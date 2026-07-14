import { createHmac } from "node:crypto";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type StreamTransport from "nodemailer/lib/stream-transport/index.js";
import type { AppConfig } from "../config.js";
import type { DraftRecord, ForwardAttachment, MailAddress, MailboxRuntimeConfig, SendResult } from "../domain.js";
import { AppError } from "../errors.js";
import type { AppLogger } from "../logger.js";
import { dedupeAddresses } from "../util/values.js";
import type { MailService } from "./mail-service.js";
import type { MailSender } from "./mail-sender.js";

export class SmtpMailSender implements MailSender {
  private readonly smtpTransporter: Transporter<SMTPTransport.SentMessageInfo>;
  private readonly streamTransporter: Transporter<StreamTransport.SentMessageInfo>;

  constructor(
    private readonly config: AppConfig,
    private readonly mailbox: MailboxRuntimeConfig,
    private readonly mailService: MailService,
    private readonly logger: AppLogger,
  ) {
    this.smtpTransporter = nodemailer.createTransport({
      host: mailbox.smtpHost,
      port: mailbox.smtpPort,
      secure: mailbox.smtpSecure,
      auth: {
        user: mailbox.smtpUsername,
        pass: mailbox.smtpPassword,
      },
      tls: { rejectUnauthorized: mailbox.smtpRejectUnauthorized },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 90_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    } satisfies SMTPTransport.Options);

    this.streamTransporter = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "windows",
    } satisfies StreamTransport.Options);
  }

  async verifyConnection(): Promise<void> {
    await this.smtpTransporter.verify();
  }

  async sendDraft(draft: DraftRecord, attachments: ForwardAttachment[]): Promise<SendResult> {
    if (!this.config.allowSend) {
      throw new AppError(
        "SENDING_DISABLED",
        "Sending is disabled by the server-wide ALLOW_SEND safety switch.",
      );
    }
    if (!this.mailbox.sendEnabled) {
      throw new AppError("MAILBOX_SEND_DISABLED", "Sending is disabled for this mailbox.");
    }
    if (draft.mailboxId !== this.mailbox.id || draft.mailboxAddress !== this.mailbox.emailAddress) {
      throw new AppError(
        "DRAFT_MAILBOX_MISMATCH",
        "The draft is not bound to the selected sending mailbox.",
      );
    }
    if (draft.status !== "draft") {
      throw new AppError("DRAFT_NOT_SENDABLE", `This draft is already ${draft.status}.`);
    }

    const recipients = dedupeAddresses([...draft.to, ...draft.cc, ...draft.bcc]);
    if (recipients.length === 0) {
      throw new AppError("NO_RECIPIENTS", "The draft has no recipients.");
    }
    if (recipients.length > this.config.limits.maxRecipients) {
      throw new AppError(
        "TOO_MANY_RECIPIENTS",
        `The draft has ${recipients.length} recipients; the configured limit is ${this.config.limits.maxRecipients}.`,
      );
    }

    const messageId = draft.smtpMessageId ?? this.messageIdForDraft(draft);
    const options: SendMailOptions = {
      from: this.mailbox.displayName
        ? { name: this.mailbox.displayName, address: this.mailbox.emailAddress }
        : this.mailbox.emailAddress,
      to: draft.to.map(toNodemailerAddress),
      cc: draft.cc.map(toNodemailerAddress),
      bcc: draft.bcc.map(toNodemailerAddress),
      subject: draft.subject,
      text: draft.bodyText,
      messageId,
      ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
      ...(draft.references.length ? { references: draft.references } : {}),
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: attachment.content,
        ...(attachment.contentDisposition
          ? { contentDisposition: attachment.contentDisposition === "inline" ? "inline" as const : "attachment" as const }
          : {}),
        ...(attachment.contentId ? { cid: attachment.contentId } : {}),
      })),
    };

    const built = await this.streamTransporter.sendMail(options);
    if (!Buffer.isBuffer(built.message)) {
      throw new AppError("MESSAGE_BUILD_FAILED", "The MIME message builder did not return a buffer.");
    }
    const rawMessage = built.message;
    const envelope = {
      from: this.mailbox.emailAddress,
      to: recipients.map((entry) => entry.address),
    };

    const sent = await this.smtpTransporter.sendMail({ envelope, raw: rawMessage });
    const accepted = normalizeSmtpAddresses(sent.accepted);
    const rejected = normalizeSmtpAddresses(sent.rejected);
    if (accepted.length === 0) {
      throw new AppError(
        "SMTP_REJECTED_ALL_RECIPIENTS",
        `The SMTP server rejected all recipients${rejected.length ? `: ${rejected.join(", ")}` : "."}`,
      );
    }
    const sentAt = new Date().toISOString();
    let sentCopySaved = false;
    if (this.mailbox.saveSentCopy) {
      try {
        sentCopySaved = await this.mailService.appendSentCopy(rawMessage);
      } catch (error) {
        this.logger.error(
          { error, draftId: draft.id, mailboxId: this.mailbox.id },
          "Email sent, but the IMAP Sent copy could not be saved",
        );
      }
    }

    return {
      draftId: draft.id,
      mailboxId: this.mailbox.id,
      fromAddress: this.mailbox.emailAddress,
      messageId: sent.messageId || messageId,
      accepted,
      rejected,
      sentAt,
      sentCopySaved,
    };
  }

  private messageIdForDraft(draft: DraftRecord): string {
    const domain = this.mailbox.emailAddress.split("@")[1] ?? "localhost";
    const opaqueId = createHmac("sha256", this.config.idSigningSecret)
      .update(`${draft.id}:${draft.revision}:${this.mailbox.id}`)
      .digest("hex")
      .slice(0, 32);
    return `<mailapp.${opaqueId}@${domain}>`;
  }
}

function toNodemailerAddress(address: MailAddress): { name?: string; address: string } {
  return address.name ? { name: address.name, address: address.address } : { address: address.address };
}

function normalizeSmtpAddresses(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "address" in value && typeof value.address === "string") {
      return value.address;
    }
    return "";
  }).filter(Boolean);
}
