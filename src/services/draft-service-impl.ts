import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { DraftRecord, EmailDetail, MailAddress, SendResult } from "../domain.js";
import { AppError, errorMessage } from "../errors.js";
import type { AppLogger } from "../logger.js";
import type { UserMailService } from "../mail/user-mail-service.js";
import { formatAddresses } from "../mail/parsing.js";
import { ApprovalService } from "../security/approval-service.js";
import { MessageIdCodec } from "../security/message-id-codec.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import {
  cleanHeaderValue,
  dedupeAddresses,
  ensureSubjectPrefix,
  normalizeEmail,
  recipientDomains,
  sha256,
} from "../util/values.js";
import type { MailboxService } from "./mailbox-service.js";
import type {
  CreateForwardDraftInput,
  CreateReplyDraftInput,
  DraftService,
  PreparedSend,
  UpdateDraftInput,
} from "./draft-service.js";
import { addressesFromStrings } from "./draft-service.js";

export class DraftServiceImpl implements DraftService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SqliteStore,
    private readonly mailboxService: MailboxService,
    private readonly userMailService: UserMailService,
    private readonly codec: MessageIdCodec,
    private readonly approvals: ApprovalService,
    private readonly logger: AppLogger,
  ) {}

  async createReply(actorId: string, input: CreateReplyDraftInput): Promise<DraftRecord> {
    const original = await this.userMailService.getEmail(actorId, input.messageId);
    const mailbox = this.mailboxService.requireRuntime(actorId, original.mailboxId, "read");
    const recipients = this.replyRecipients(actorId, original, input.replyAll);
    const now = new Date().toISOString();
    const draft: DraftRecord = {
      id: randomUUID(),
      ownerId: actorId,
      mailboxId: mailbox.id,
      mailboxAddress: mailbox.emailAddress,
      ...(mailbox.displayName ? { mailboxDisplayName: mailbox.displayName } : {}),
      kind: "reply",
      status: "draft",
      sourceMessageId: input.messageId,
      sourceRef: this.codec.decode(input.messageId),
      to: recipients.to,
      cc: recipients.cc,
      bcc: [],
      subject: ensureSubjectPrefix(original.subject, "Re"),
      bodyText: this.limitBody(input.bodyText),
      ...(original.messageId ? { inReplyTo: original.messageId } : {}),
      references: dedupeStrings([...original.references, ...(original.messageId ? [original.messageId] : [])]),
      includeSourceAttachments: false,
      attachmentMetadata: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.saveNewDraft(draft);
    return draft;
  }

  async createForward(actorId: string, input: CreateForwardDraftInput): Promise<DraftRecord> {
    const original = await this.userMailService.getEmail(actorId, input.messageId);
    const mailbox = this.mailboxService.requireRuntime(actorId, original.mailboxId, "read");
    const now = new Date().toISOString();
    const draft: DraftRecord = {
      id: randomUUID(),
      ownerId: actorId,
      mailboxId: mailbox.id,
      mailboxAddress: mailbox.emailAddress,
      ...(mailbox.displayName ? { mailboxDisplayName: mailbox.displayName } : {}),
      kind: "forward",
      status: "draft",
      sourceMessageId: input.messageId,
      sourceRef: this.codec.decode(input.messageId),
      to: dedupeAddresses(addressesFromStrings(input.to)),
      cc: dedupeAddresses(addressesFromStrings(input.cc)),
      bcc: dedupeAddresses(addressesFromStrings(input.bcc)),
      subject: ensureSubjectPrefix(original.subject, "Fwd"),
      bodyText: this.limitBody(buildForwardBody(input.note, original)),
      references: [],
      includeSourceAttachments: input.includeAttachments,
      attachmentMetadata: input.includeAttachments
        ? original.attachments.filter((attachment) => !attachment.inline)
        : [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.validateRecipientCount(draft);
    this.saveNewDraft(draft);
    return draft;
  }

  async getDraft(actorId: string, draftId: string): Promise<DraftRecord> {
    return this.store.requireDraftOwned(actorId, draftId);
  }

  async updateDraft(actorId: string, input: UpdateDraftInput): Promise<DraftRecord> {
    const draft = this.store.requireDraftOwned(actorId, input.draftId);
    if (draft.status !== "draft") {
      throw new AppError("DRAFT_NOT_EDITABLE", `This draft is already ${draft.status}.`);
    }
    if (this.store.hasSendingApproval(actorId, draft.id)) {
      throw new AppError("DRAFT_SEND_IN_PROGRESS", "This draft is currently being sent.");
    }

    if (input.to) draft.to = dedupeAddresses(addressesFromStrings(input.to));
    if (input.cc) draft.cc = dedupeAddresses(addressesFromStrings(input.cc));
    if (input.bcc) draft.bcc = dedupeAddresses(addressesFromStrings(input.bcc));
    if (input.subject !== undefined) draft.subject = cleanHeaderValue(input.subject, "(no subject)");
    if (input.bodyText !== undefined) draft.bodyText = this.limitBody(input.bodyText);
    if (input.includeSourceAttachments !== undefined) {
      if (draft.kind !== "forward" && input.includeSourceAttachments) {
        throw new AppError("ATTACHMENTS_NOT_AVAILABLE", "Source attachments can only be included on forwards.");
      }
      draft.includeSourceAttachments = input.includeSourceAttachments;
    }
    this.validateRecipientCount(draft);
    draft.revision += 1;
    draft.updatedAt = new Date().toISOString();

    this.store.transaction(() => {
      this.store.updateDraft(draft);
      this.store.addAudit(SqliteStore.audit({
        actorId,
        mailboxId: draft.mailboxId,
        action: "update_draft",
        status: "success",
        draftId: draft.id,
        recipientDomains: recipientDomains([...draft.to, ...draft.cc, ...draft.bcc]),
      }));
      this.store.cancelPendingApprovals(actorId, input.draftId);
    });
    return draft;
  }

  async prepareSend(actorId: string, draftId: string): Promise<PreparedSend> {
    const draft = await this.getDraft(actorId, draftId);
    this.validateSendable(actorId, draft);
    const approval = await this.approvals.create(actorId, draft);
    return { draft, approvalToken: approval.token, expiresAt: approval.expiresAt };
  }

  async confirmSend(actorId: string, approvalToken: string): Promise<SendResult> {
    if (!this.config.allowSend) {
      throw new AppError(
        "SENDING_DISABLED",
        "Sending is disabled globally. Set ALLOW_SEND=true only after completing test-mailbox checks.",
      );
    }

    const draftId = this.lookupApprovalDraft(actorId, approvalToken);
    const draft = await this.getDraft(actorId, draftId);
    if (draft.status === "draft") this.validateSendable(actorId, draft);
    const claimed = await this.approvals.claim(actorId, approvalToken, draft);
    if (claimed.alreadySent) return claimed.alreadySent;

    try {
      const mailbox = this.mailboxService.requireRuntime(actorId, draft.mailboxId, "send");
      const mailService = this.mailboxService.createMailService(mailbox);
      const attachments = draft.includeSourceAttachments
        ? await mailService.loadForwardAttachments(draft.sourceMessageId)
        : [];
      const sender = this.mailboxService.createMailSender(mailbox, mailService);
      const result = await sender.sendDraft(draft, attachments);
      await this.approvals.complete(actorId, claimed.tokenHash, result);
      return result;
    } catch (error) {
      await this.approvals.fail(actorId, claimed.tokenHash, errorMessage(error));
      this.logger.error({ error, draftId: draft.id, actorId, mailboxId: draft.mailboxId }, "Draft send failed");
      throw error;
    }
  }

  async cancelSend(actorId: string, approvalToken: string): Promise<void> {
    await this.approvals.cancel(actorId, approvalToken);
  }

  private lookupApprovalDraft(actorId: string, approvalToken: string): string {
    const approval = this.store.getApprovalOwned(actorId, sha256(approvalToken));
    if (!approval) {
      throw new AppError("APPROVAL_NOT_FOUND", "The send approval could not be found.", 404);
    }
    return approval.draftId;
  }

  private saveNewDraft(draft: DraftRecord): void {
    this.store.transaction(() => {
      this.store.saveDraft(draft);
      this.store.addAudit(SqliteStore.audit({
        actorId: draft.ownerId,
        mailboxId: draft.mailboxId,
        action: draft.kind === "reply" ? "create_reply_draft" : "create_forward_draft",
        status: "success",
        draftId: draft.id,
        sourceMessageId: draft.sourceMessageId,
        recipientDomains: recipientDomains([...draft.to, ...draft.cc, ...draft.bcc]),
      }));
    });
  }

  private replyRecipients(actorId: string, original: EmailDetail, replyAll: boolean): { to: MailAddress[]; cc: MailAddress[] } {
    const ownAddresses = new Set(this.mailboxService.list(actorId).map((mailbox) => normalizeEmail(mailbox.emailAddress)));
    const directReply = original.replyTo.length ? original.replyTo : original.from;
    const to = dedupeAddresses(replyAll ? [...directReply, ...original.to] : directReply)
      .filter((entry) => !ownAddresses.has(normalizeEmail(entry.address)));
    const toSet = new Set(to.map((entry) => normalizeEmail(entry.address)));
    const cc = replyAll
      ? dedupeAddresses(original.cc).filter(
          (entry) => !ownAddresses.has(normalizeEmail(entry.address)) && !toSet.has(normalizeEmail(entry.address)),
        )
      : [];

    if (to.length === 0) {
      throw new AppError("NO_REPLY_ADDRESS", "The source email does not contain a usable reply address.");
    }
    return { to, cc };
  }

  private validateSendable(actorId: string, draft: DraftRecord): void {
    if (draft.status !== "draft") {
      throw new AppError("DRAFT_NOT_SENDABLE", `This draft is already ${draft.status}.`);
    }
    const mailbox = this.mailboxService.requireRuntime(actorId, draft.mailboxId, "send");
    if (normalizeEmail(mailbox.emailAddress) !== normalizeEmail(draft.mailboxAddress)) {
      throw new AppError("DRAFT_MAILBOX_MISMATCH", "The draft sending identity no longer matches its mailbox.");
    }
    const recipients = dedupeAddresses([...draft.to, ...draft.cc, ...draft.bcc]);
    if (recipients.length === 0) {
      throw new AppError("NO_RECIPIENTS", "The draft has no recipients.");
    }
    this.validateRecipientCount(draft);
    if (!draft.subject.trim()) {
      throw new AppError("EMPTY_SUBJECT", "The draft subject is empty.");
    }
  }

  private validateRecipientCount(draft: DraftRecord): void {
    const count = dedupeAddresses([...draft.to, ...draft.cc, ...draft.bcc]).length;
    if (count > this.config.limits.maxRecipients) {
      throw new AppError(
        "TOO_MANY_RECIPIENTS",
        `The draft has ${count} recipients; the configured limit is ${this.config.limits.maxRecipients}.`,
      );
    }
  }

  private limitBody(value: string): string {
    if (value.length > this.config.limits.maxBodyChars) {
      throw new AppError(
        "BODY_TOO_LONG",
        `The draft body exceeds the configured ${this.config.limits.maxBodyChars}-character limit.`,
      );
    }
    return value.trim();
  }
}

function buildForwardBody(note: string, original: EmailDetail): string {
  const header = [
    "---------- Forwarded message ----------",
    `From: ${formatAddresses(original.from) || "Unknown"}`,
    `Date: ${original.receivedAt ?? "Unknown"}`,
    `Subject: ${original.subject}`,
    `To: ${formatAddresses(original.to) || "Unknown"}`,
  ].join("\n");
  return [note.trim(), header, original.bodyText].filter(Boolean).join("\n\n");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
