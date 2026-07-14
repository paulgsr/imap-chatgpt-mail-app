import { ImapFlow, type FetchMessageObject, type SearchObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import type { AppConfig } from "../config.js";
import type {
  AttachmentMetadata,
  EmailDetail,
  EmailSummary,
  ForwardAttachment,
  MailFolder,
  MailboxRuntimeConfig,
  MessageRef,
  SearchEmailsInput,
} from "../domain.js";
import { AppError } from "../errors.js";
import type { AppLogger } from "../logger.js";
import { MessageIdCodec } from "../security/message-id-codec.js";
import { normalizeThreadSubject, truncate } from "../util/values.js";
import type { MailService } from "./mail-service.js";
import {
  bodyTextFromParsed,
  fromEnvelopeAddresses,
  fromParsedAddresses,
  hasAttachments,
  normalizeReferences,
  previewFromParsed,
} from "./parsing.js";

export class ImapMailService implements MailService {
  constructor(
    private readonly config: AppConfig,
    private readonly mailbox: MailboxRuntimeConfig,
    private readonly codec: MessageIdCodec,
    private readonly logger: AppLogger,
  ) {}

  async verifyConnection(): Promise<void> {
    await this.withClient(async (client) => {
      await client.list();
    });
  }

  async listFolders(): Promise<MailFolder[]> {
    return this.withClient(async (client) => {
      const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
      return folders
        .filter((folder) => folder.listed)
        .map((folder) => ({
          mailboxId: this.mailbox.id,
          mailboxAddress: this.mailbox.emailAddress,
          path: folder.path,
          name: folder.name,
          subscribed: folder.subscribed,
          ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
          ...(typeof folder.status?.messages === "number" ? { messages: folder.status.messages } : {}),
          ...(typeof folder.status?.unseen === "number" ? { unseen: folder.status.unseen } : {}),
        }))
        .sort((left, right) => {
          if (left.path.toUpperCase() === "INBOX") return -1;
          if (right.path.toUpperCase() === "INBOX") return 1;
          return left.path.localeCompare(right.path);
        });
    });
  }

  async searchEmails(input: SearchEmailsInput): Promise<EmailSummary[]> {
    const limit = Math.min(input.limit, this.config.limits.maxSearchResults);
    const criteria: SearchObject = { all: true };
    if (input.query) criteria.text = input.query;
    if (input.from) criteria.from = input.from;
    if (input.subject) criteria.subject = input.subject;
    if (typeof input.unread === "boolean") criteria.seen = !input.unread;
    if (input.since) criteria.since = this.parseDate(input.since, "since");
    if (input.before) criteria.before = this.parseDate(input.before, "before");

    return this.withMailbox(input.folder, true, async (client) => {
      const matches = await client.search(criteria, { uid: true });
      if (!matches || matches.length === 0) return [];
      const selected = matches.slice(-Math.max(limit * 2, limit));
      const fetched = await client.fetchAll(
        selected,
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
          source: { maxLength: this.config.limits.maxPreviewSourceBytes },
        },
        { uid: true },
      );

      const summaries = await Promise.all(fetched.map((message) => this.toSummary(input.folder, message)));
      return summaries
        .sort((left, right) => (right.receivedAt ?? "").localeCompare(left.receivedAt ?? ""))
        .slice(0, limit);
    });
  }

  async getEmail(messageId: string): Promise<EmailDetail> {
    const ref = this.decodeOwnedReference(messageId);
    return this.withMailbox(ref.folder, true, async (client) => {
      const message = await this.fetchFullMessage(client, ref);
      return this.toDetail(ref.folder, message);
    });
  }

  async getThread(messageId: string, limit: number): Promise<EmailDetail[]> {
    const ref = this.decodeOwnedReference(messageId);
    const boundedLimit = Math.min(Math.max(limit, 1), 30);

    return this.withMailbox(ref.folder, true, async (client) => {
      const originalRaw = await this.fetchFullMessage(client, ref);
      const original = await this.toDetail(ref.folder, originalRaw);
      const normalizedSubject = normalizeThreadSubject(original.subject);
      if (!normalizedSubject) return [original];

      const matches = await client.search({ subject: normalizedSubject }, { uid: true });
      if (!matches || matches.length === 0) return [original];

      const candidateCount = Math.min(40, Math.max(boundedLimit * 2, boundedLimit));
      const candidateUids = matches.slice(-candidateCount);
      const details: EmailDetail[] = [];
      for (const uid of candidateUids) {
        try {
          const raw = await this.fetchFullMessage(client, { mailboxId: this.mailbox.id, folder: ref.folder, uid });
          const detail = await this.toDetail(ref.folder, raw);
          if (normalizeThreadSubject(detail.subject) === normalizedSubject) {
            details.push(detail);
          }
        } catch (error) {
          this.logger.debug({ error, uid, folder: ref.folder, mailboxId: this.mailbox.id }, "Skipping a thread candidate");
        }
      }

      const connected = connectThread(details, original);
      return connected
        .sort((left, right) => (left.receivedAt ?? "").localeCompare(right.receivedAt ?? ""))
        .slice(-boundedLimit);
    });
  }

  async loadForwardAttachments(messageId: string): Promise<ForwardAttachment[]> {
    const ref = this.decodeOwnedReference(messageId);
    return this.withMailbox(ref.folder, true, async (client) => {
      const message = await this.fetchFullMessage(client, ref);
      if (!message.source) return [];
      const parsed = await simpleParser(message.source);
      const attachments = parsed.attachments.filter(
        (attachment) => !attachment.related && attachment.contentDisposition !== "inline",
      );
      const totalSize = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
      if (totalSize > this.config.limits.maxForwardAttachmentBytes) {
        throw new AppError(
          "ATTACHMENTS_TOO_LARGE",
          `The forwarded attachments total ${totalSize} bytes, above the configured limit.`,
        );
      }
      return attachments.map((attachment, index) => ({
        filename: attachment.filename ?? `attachment-${index + 1}`,
        contentType: attachment.contentType,
        content: attachment.content,
        ...(attachment.contentDisposition ? { contentDisposition: attachment.contentDisposition } : {}),
        ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
      }));
    });
  }

  async appendSentCopy(rawMessage: Buffer): Promise<boolean> {
    const sentFolder = await this.resolveSentFolder();
    if (!sentFolder) return false;
    return this.withClient(async (client) => Boolean(
      await client.append(sentFolder, rawMessage, ["\\Seen"], new Date()),
    ));
  }

  private decodeOwnedReference(messageId: string): MessageRef {
    const ref = this.codec.decode(messageId);
    if (ref.mailboxId !== this.mailbox.id) {
      throw new AppError("INVALID_MESSAGE_ID", "The message reference does not belong to this mailbox.");
    }
    return ref;
  }

  private async resolveSentFolder(): Promise<string | undefined> {
    if (this.mailbox.imapSentFolder) return this.mailbox.imapSentFolder;
    return this.withClient(async (client) => {
      const folders = await client.list();
      return folders.find((folder) => folder.specialUse?.toLowerCase() === "\\sent")?.path;
    });
  }

  private async fetchFullMessage(client: ImapFlow, ref: MessageRef): Promise<FetchMessageObject> {
    const metadata = await client.fetchOne(
      ref.uid,
      { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true },
      { uid: true },
    );
    if (!metadata) {
      throw new AppError("MESSAGE_NOT_FOUND", "The email could not be found.", 404);
    }
    if ((metadata.size ?? 0) > this.config.limits.maxMessageBytes) {
      throw new AppError(
        "MESSAGE_TOO_LARGE",
        `The email is larger than the configured ${this.config.limits.maxMessageBytes}-byte parsing limit.`,
      );
    }

    const source = await client.fetchOne(ref.uid, { uid: true, source: true }, { uid: true });
    if (!source || !source.source) {
      throw new AppError("MESSAGE_CONTENT_UNAVAILABLE", "The email content could not be loaded.");
    }
    return { ...metadata, source: source.source };
  }

  private async toSummary(folder: string, message: FetchMessageObject): Promise<EmailSummary> {
    let parsed: ParsedMail | undefined;
    if (message.source) {
      try {
        parsed = await simpleParser(message.source);
      } catch {
        parsed = undefined;
      }
    }

    const receivedAt = dateToIso(message.envelope?.date ?? message.internalDate);
    const flags = message.flags ?? new Set<string>();
    return {
      id: this.codec.encode({ mailboxId: this.mailbox.id, folder, uid: message.uid }),
      mailboxId: this.mailbox.id,
      mailboxAddress: this.mailbox.emailAddress,
      ...(this.mailbox.displayName ? { mailboxDisplayName: this.mailbox.displayName } : {}),
      receivedBy: this.mailbox.emailAddress,
      folder,
      uid: message.uid,
      subject: message.envelope?.subject?.trim() || "(no subject)",
      from: fromEnvelopeAddresses(message.envelope?.from),
      to: fromEnvelopeAddresses(message.envelope?.to),
      cc: fromEnvelopeAddresses(message.envelope?.cc),
      ...(receivedAt ? { receivedAt } : {}),
      ...(typeof message.size === "number" ? { size: message.size } : {}),
      isRead: flags.has("\\Seen"),
      isAnswered: flags.has("\\Answered"),
      hasAttachments: hasAttachments(message.bodyStructure),
      preview: parsed ? previewFromParsed(parsed) : "",
      ...(message.envelope?.messageId ? { messageId: message.envelope.messageId } : {}),
    };
  }

  private async toDetail(folder: string, message: FetchMessageObject): Promise<EmailDetail> {
    if (!message.source) {
      throw new AppError("MESSAGE_CONTENT_UNAVAILABLE", "The email content could not be loaded.");
    }
    const parsed = await simpleParser(message.source);
    const base = await this.toSummary(folder, message);
    const body = truncate(bodyTextFromParsed(parsed), this.config.limits.maxBodyChars);
    const attachments: AttachmentMetadata[] = parsed.attachments.map((attachment, index) => ({
      index,
      filename: attachment.filename ?? `attachment-${index + 1}`,
      contentType: attachment.contentType,
      size: attachment.size,
      inline: Boolean(attachment.related || attachment.contentDisposition === "inline"),
      ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
    }));

    return {
      ...base,
      from: fromParsedAddresses(parsed.from).length ? fromParsedAddresses(parsed.from) : base.from,
      to: fromParsedAddresses(parsed.to).length ? fromParsedAddresses(parsed.to) : base.to,
      cc: fromParsedAddresses(parsed.cc).length ? fromParsedAddresses(parsed.cc) : base.cc,
      replyTo: fromParsedAddresses(parsed.replyTo),
      subject: parsed.subject?.trim() || base.subject,
      bodyText: body.value,
      bodyTruncated: body.truncated,
      attachments,
      hasAttachments: attachments.length > 0,
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
      references: normalizeReferences(parsed.references),
    };
  }

  private parseDate(value: string, field: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new AppError("INVALID_DATE", `The ${field} date must be an ISO-8601 date.`);
    }
    return date;
  }

  private async withMailbox<T>(
    folder: string,
    readOnly: boolean,
    operation: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly, acquireTimeout: 15_000 });
      try {
        return await operation(client);
      } finally {
        lock.release();
      }
    });
  }

  private async withClient<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.mailbox.imapHost,
      port: this.mailbox.imapPort,
      secure: this.mailbox.imapSecure,
      auth: {
        user: this.mailbox.imapUsername,
        pass: this.mailbox.imapPassword,
      },
      tls: { rejectUnauthorized: this.mailbox.imapRejectUnauthorized },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 90_000,
      maxLiteralSize: this.config.limits.maxMessageBytes + 1_048_576,
    });

    try {
      await client.connect();
      return await operation(client);
    } catch (error) {
      this.logger.warn(
        { error, host: this.mailbox.imapHost, mailboxId: this.mailbox.id },
        "IMAP operation failed",
      );
      throw error;
    } finally {
      try {
        if (client.usable) await client.logout();
      } catch {
        client.close();
      }
    }
  }
}

function dateToIso(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function connectThread(candidates: EmailDetail[], original: EmailDetail): EmailDetail[] {
  const originalTokens = messageTokens(original);
  if (originalTokens.size === 0) {
    return candidates.some((candidate) => candidate.id === original.id) ? candidates : [...candidates, original];
  }

  const known = new Set(originalTokens);
  const selected = new Map<string, EmailDetail>([[original.id, original]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (selected.has(candidate.id)) continue;
      const tokens = messageTokens(candidate);
      if ([...tokens].some((token) => known.has(token))) {
        selected.set(candidate.id, candidate);
        for (const token of tokens) known.add(token);
        changed = true;
      }
    }
  }
  return [...selected.values()];
}

function messageTokens(message: EmailDetail): Set<string> {
  return new Set(
    [message.messageId, message.inReplyTo, ...message.references]
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => entry.trim()),
  );
}
