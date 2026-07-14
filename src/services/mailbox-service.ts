import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { MailboxRecord, MailboxRuntimeConfig, MailboxSecretPayload, MailboxSummary } from "../domain.js";
import { AppError } from "../errors.js";
import type { AppLogger } from "../logger.js";
import { ImapMailService } from "../mail/imap-mail-service.js";
import type { MailService } from "../mail/mail-service.js";
import type { MailSender } from "../mail/mail-sender.js";
import { SmtpMailSender } from "../mail/smtp-mail-sender.js";
import { CredentialCipher } from "../security/credential-cipher.js";
import { MessageIdCodec } from "../security/message-id-codec.js";
import { SqliteStore, type CreateMailboxInput, type UpdateMailboxInput } from "../storage/sqlite-store.js";

const emailSchema = z.email();

export interface MailboxSettingsInput {
  emailAddress: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapRejectUnauthorized: boolean;
  imapSentFolder?: string;
  imapUsername: string;
  imapPassword?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpRejectUnauthorized: boolean;
  smtpUsername: string;
  smtpPassword?: string;
  readEnabled: boolean;
  sendEnabled: boolean;
  saveSentCopy: boolean;
}

export class MailboxService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SqliteStore,
    private readonly cipher: CredentialCipher,
    private readonly codec: MessageIdCodec,
    private readonly logger: AppLogger,
  ) {}

  list(ownerId: string): MailboxSummary[] {
    return this.store.listMailboxes(ownerId).map(toSummary);
  }

  get(ownerId: string, mailboxId: string): MailboxRecord {
    const mailbox = this.store.requireMailboxOwned(ownerId, mailboxId);
    return withoutSecrets(mailbox);
  }

  create(ownerId: string, input: MailboxSettingsInput): MailboxRecord {
    if (this.store.countMailboxes(ownerId) >= this.config.limits.maxMailboxesPerUser) {
      throw new AppError(
        "MAILBOX_LIMIT_REACHED",
        `This account already has the configured maximum of ${this.config.limits.maxMailboxesPerUser} mailboxes.`,
        409,
      );
    }
    const normalized = this.normalizeInput(input, true);
    const secrets: MailboxSecretPayload = {
      imapUsername: normalized.imapUsername,
      imapPassword: normalized.imapPassword ?? "",
      smtpUsername: normalized.smtpUsername,
      smtpPassword: normalized.smtpPassword ?? "",
    };
    const record = this.store.createMailbox({
      ...toCreateInput(ownerId, normalized),
      encryptedSecrets: this.cipher.encrypt(secrets),
    });
    this.store.addAudit(SqliteStore.audit({
      actorId: ownerId,
      mailboxId: record.id,
      action: "create_mailbox",
      status: "success",
    }));
    return withoutSecrets(record);
  }

  update(ownerId: string, mailboxId: string, input: MailboxSettingsInput): MailboxRecord {
    const current = this.requireRuntime(ownerId, mailboxId, "manage");
    const normalized = this.normalizeInput(input, false);
    const newSecrets: MailboxSecretPayload = {
      imapUsername: normalized.imapUsername,
      imapPassword: normalized.imapPassword || current.imapPassword,
      smtpUsername: normalized.smtpUsername,
      smtpPassword: normalized.smtpPassword || current.smtpPassword,
    };
    const update: UpdateMailboxInput = {
      ...toUpdateInput(normalized),
      encryptedSecrets: this.cipher.encrypt(newSecrets),
    };
    const record = this.store.updateMailbox(ownerId, mailboxId, update);
    this.store.addAudit(SqliteStore.audit({
      actorId: ownerId,
      mailboxId,
      action: "update_mailbox",
      status: "success",
    }));
    return withoutSecrets(record);
  }

  delete(ownerId: string, mailboxId: string): void {
    this.store.deleteMailbox(ownerId, mailboxId);
    this.store.addAudit(SqliteStore.audit({
      actorId: ownerId,
      action: "delete_mailbox",
      status: "success",
      detail: `Deleted mailbox ${mailboxId}`,
    }));
  }

  requireRuntime(
    ownerId: string,
    mailboxId: string,
    capability: "read" | "send" | "manage" = "read",
  ): MailboxRuntimeConfig {
    const mailbox = this.store.requireMailboxOwned(ownerId, mailboxId);
    if (capability === "read" && !mailbox.readEnabled) {
      throw new AppError("MAILBOX_READ_DISABLED", "Reading is disabled for this mailbox.", 403);
    }
    if (capability === "send" && !mailbox.sendEnabled) {
      throw new AppError("MAILBOX_SEND_DISABLED", "Sending is disabled for this mailbox.", 403);
    }
    return { ...withoutSecrets(mailbox), ...this.cipher.decrypt(mailbox.encryptedSecrets) };
  }

  listRuntime(ownerId: string, mailboxIds: string[] | undefined, capability: "read" | "send"): MailboxRuntimeConfig[] {
    const all = this.store.listMailboxes(ownerId);
    const selectedIds = mailboxIds?.length ? [...new Set(mailboxIds)] : undefined;
    const selected = selectedIds
      ? selectedIds.map((id) => {
          const mailbox = all.find((entry) => entry.id === id);
          if (!mailbox) {
            throw new AppError("MAILBOX_NOT_FOUND", "One of the selected mailboxes is unavailable.", 404);
          }
          return mailbox;
        })
      : all;

    const enabled = selected.filter((mailbox) => capability === "read" ? mailbox.readEnabled : mailbox.sendEnabled);
    if (enabled.length === 0) {
      throw new AppError(
        capability === "read" ? "NO_READABLE_MAILBOXES" : "NO_SENDABLE_MAILBOXES",
        capability === "read"
          ? "No readable mailboxes are configured for this user."
          : "No mailboxes with sending enabled are configured for this user.",
        404,
      );
    }
    return enabled.map((mailbox) => ({ ...withoutSecrets(mailbox), ...this.cipher.decrypt(mailbox.encryptedSecrets) }));
  }

  createMailService(mailbox: MailboxRuntimeConfig): MailService {
    return new ImapMailService(this.config, mailbox, this.codec, this.logger);
  }

  createMailSender(mailbox: MailboxRuntimeConfig, mailService?: MailService): MailSender {
    const service = mailService ?? this.createMailService(mailbox);
    return new SmtpMailSender(this.config, mailbox, service, this.logger);
  }

  async testConnections(ownerId: string, mailboxId: string): Promise<{ imap: "ok"; smtp: "ok" }> {
    const mailbox = this.requireRuntime(ownerId, mailboxId, "manage");
    const mailService = this.createMailService(mailbox);
    const sender = this.createMailSender(mailbox, mailService);
    try {
      await mailService.verifyConnection();
      await sender.verifyConnection();
      this.store.setMailboxStatus(ownerId, mailboxId, "connected");
      this.store.addAudit(SqliteStore.audit({
        actorId: ownerId,
        mailboxId,
        action: "test_mailbox_connections",
        status: "success",
      }));
      return { imap: "ok", smtp: "ok" };
    } catch (error) {
      const message = safeErrorMessage(error);
      this.store.setMailboxStatus(ownerId, mailboxId, "error", message);
      this.store.addAudit(SqliteStore.audit({
        actorId: ownerId,
        mailboxId,
        action: "test_mailbox_connections",
        status: "failure",
        detail: message,
      }));
      throw new AppError("MAILBOX_CONNECTION_FAILED", message, 400);
    }
  }

  private normalizeInput(input: MailboxSettingsInput, requirePasswords: boolean): MailboxSettingsInput {
    const emailAddress = emailSchema.parse(input.emailAddress.trim().toLowerCase());
    const imapHost = requiredText(input.imapHost, "IMAP host");
    const smtpHost = requiredText(input.smtpHost, "SMTP host");
    const imapUsername = requiredText(input.imapUsername, "IMAP username");
    const smtpUsername = requiredText(input.smtpUsername, "SMTP username");
    if (requirePasswords && !input.imapPassword) {
      throw new AppError("IMAP_PASSWORD_REQUIRED", "An IMAP password or app password is required.");
    }
    if (requirePasswords && !input.smtpPassword) {
      throw new AppError("SMTP_PASSWORD_REQUIRED", "An SMTP password or app password is required.");
    }
    return {
      emailAddress,
      ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
      imapHost,
      imapPort: validPort(input.imapPort, "IMAP"),
      imapSecure: input.imapSecure,
      imapRejectUnauthorized: input.imapRejectUnauthorized,
      ...(input.imapSentFolder?.trim() ? { imapSentFolder: input.imapSentFolder.trim() } : {}),
      imapUsername,
      ...(input.imapPassword ? { imapPassword: input.imapPassword } : {}),
      smtpHost,
      smtpPort: validPort(input.smtpPort, "SMTP"),
      smtpSecure: input.smtpSecure,
      smtpRejectUnauthorized: input.smtpRejectUnauthorized,
      smtpUsername,
      ...(input.smtpPassword ? { smtpPassword: input.smtpPassword } : {}),
      readEnabled: input.readEnabled,
      sendEnabled: input.sendEnabled,
      saveSentCopy: input.saveSentCopy,
    };
  }
}

function toCreateInput(ownerId: string, input: MailboxSettingsInput): Omit<CreateMailboxInput, "encryptedSecrets"> {
  return {
    ownerId,
    emailAddress: input.emailAddress,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure,
    imapRejectUnauthorized: input.imapRejectUnauthorized,
    ...(input.imapSentFolder ? { imapSentFolder: input.imapSentFolder } : {}),
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpRejectUnauthorized: input.smtpRejectUnauthorized,
    readEnabled: input.readEnabled,
    sendEnabled: input.sendEnabled,
    saveSentCopy: input.saveSentCopy,
  };
}

function toUpdateInput(input: MailboxSettingsInput): Omit<UpdateMailboxInput, "encryptedSecrets"> {
  return {
    emailAddress: input.emailAddress,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure,
    imapRejectUnauthorized: input.imapRejectUnauthorized,
    ...(input.imapSentFolder ? { imapSentFolder: input.imapSentFolder } : {}),
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpRejectUnauthorized: input.smtpRejectUnauthorized,
    readEnabled: input.readEnabled,
    sendEnabled: input.sendEnabled,
    saveSentCopy: input.saveSentCopy,
  };
}

function withoutSecrets(mailbox: import("../storage/sqlite-store.js").StoredMailbox): MailboxRecord {
  const { encryptedSecrets: _encryptedSecrets, ...record } = mailbox;
  return record;
}

function toSummary(mailbox: import("../storage/sqlite-store.js").StoredMailbox): MailboxSummary {
  return {
    id: mailbox.id,
    emailAddress: mailbox.emailAddress,
    ...(mailbox.displayName ? { displayName: mailbox.displayName } : {}),
    readEnabled: mailbox.readEnabled,
    sendEnabled: mailbox.sendEnabled,
    status: mailbox.status,
    ...(mailbox.lastCheckedAt ? { lastCheckedAt: mailbox.lastCheckedAt } : {}),
    ...(mailbox.lastError ? { lastError: mailbox.lastError } : {}),
  };
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AppError("INVALID_MAILBOX_SETTINGS", `${label} is required.`);
  return trimmed;
}

function validPort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new AppError("INVALID_MAILBOX_SETTINGS", `${label} port must be between 1 and 65535.`);
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) {
    return error.message.replace(/password=[^\s]+/gi, "password=[redacted]").slice(0, 1_000);
  }
  return "The mailbox provider rejected the connection.";
}
