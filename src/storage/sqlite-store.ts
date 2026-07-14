import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ApiTokenRecord,
  ApprovalRecord,
  AuditRecord,
  DraftRecord,
  MailboxRecord,
  SessionRecord,
  UserRecord,
} from "../domain.js";
import { AppError } from "../errors.js";

export interface StoredMailbox extends MailboxRecord {
  encryptedSecrets: string;
}

export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
  role: "admin" | "user";
}

export interface CreateMailboxInput {
  id?: string;
  ownerId: string;
  emailAddress: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapRejectUnauthorized: boolean;
  imapSentFolder?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpRejectUnauthorized: boolean;
  readEnabled: boolean;
  sendEnabled: boolean;
  saveSentCopy: boolean;
  encryptedSecrets: string;
}

export interface UpdateMailboxInput extends Omit<CreateMailboxInput, "ownerId" | "id" | "encryptedSecrets"> {
  encryptedSecrets?: string;
}

export interface UserWithPassword extends UserRecord {
  passwordHash: string;
}

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path, {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        oauth_subject TEXT UNIQUE,
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS mailboxes (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email_address TEXT NOT NULL COLLATE NOCASE,
        display_name TEXT,
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL,
        imap_secure INTEGER NOT NULL CHECK (imap_secure IN (0, 1)),
        imap_reject_unauthorized INTEGER NOT NULL CHECK (imap_reject_unauthorized IN (0, 1)),
        imap_sent_folder TEXT,
        smtp_host TEXT NOT NULL,
        smtp_port INTEGER NOT NULL,
        smtp_secure INTEGER NOT NULL CHECK (smtp_secure IN (0, 1)),
        smtp_reject_unauthorized INTEGER NOT NULL CHECK (smtp_reject_unauthorized IN (0, 1)),
        read_enabled INTEGER NOT NULL CHECK (read_enabled IN (0, 1)),
        send_enabled INTEGER NOT NULL CHECK (send_enabled IN (0, 1)),
        save_sent_copy INTEGER NOT NULL CHECK (save_sent_copy IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('untested', 'connected', 'error', 'disabled')),
        last_checked_at TEXT,
        last_error TEXT,
        encrypted_secrets TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_id, email_address)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS mailboxes_owner_idx ON mailboxes(owner_id);

      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens(user_id);

      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        mailbox_address TEXT NOT NULL,
        mailbox_display_name TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('reply', 'forward')),
        status TEXT NOT NULL CHECK (status IN ('draft', 'sent')),
        source_message_id TEXT NOT NULL,
        source_ref_json TEXT NOT NULL,
        to_json TEXT NOT NULL,
        cc_json TEXT NOT NULL,
        bcc_json TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        in_reply_to TEXT,
        references_json TEXT NOT NULL,
        include_source_attachments INTEGER NOT NULL CHECK (include_source_attachments IN (0, 1)),
        attachment_metadata_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        smtp_message_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS drafts_owner_idx ON drafts(owner_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS drafts_mailbox_idx ON drafts(mailbox_id);

      CREATE TABLE IF NOT EXISTS approvals (
        token_hash TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        draft_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        completed_at TEXT,
        error TEXT,
        result_json TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS approvals_owner_draft_idx ON approvals(owner_id, draft_id);

      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
        draft_id TEXT,
        source_message_id TEXT,
        recipient_domains_json TEXT,
        detail TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit(actor_id, timestamp DESC);

      CREATE TRIGGER IF NOT EXISTS drafts_owner_insert
      BEFORE INSERT ON drafts
      FOR EACH ROW
      WHEN (SELECT owner_id FROM mailboxes WHERE id = NEW.mailbox_id) IS NOT NEW.owner_id
      BEGIN
        SELECT RAISE(ABORT, 'draft mailbox owner mismatch');
      END;

      CREATE TRIGGER IF NOT EXISTS drafts_owner_update
      BEFORE UPDATE OF owner_id, mailbox_id ON drafts
      FOR EACH ROW
      WHEN (SELECT owner_id FROM mailboxes WHERE id = NEW.mailbox_id) IS NOT NEW.owner_id
      BEGIN
        SELECT RAISE(ABORT, 'draft mailbox owner mismatch');
      END;

      CREATE TRIGGER IF NOT EXISTS approvals_owner_insert
      BEFORE INSERT ON approvals
      FOR EACH ROW
      WHEN (SELECT owner_id FROM drafts WHERE id = NEW.draft_id) IS NOT NEW.owner_id
      BEGIN
        SELECT RAISE(ABORT, 'approval draft owner mismatch');
      END;

      CREATE TRIGGER IF NOT EXISTS approvals_owner_update
      BEFORE UPDATE OF owner_id, draft_id ON approvals
      FOR EACH ROW
      WHEN (SELECT owner_id FROM drafts WHERE id = NEW.draft_id) IS NOT NEW.owner_id
      BEGIN
        SELECT RAISE(ABORT, 'approval draft owner mismatch');
      END;

      CREATE TRIGGER IF NOT EXISTS audit_mailbox_owner_insert
      BEFORE INSERT ON audit
      FOR EACH ROW
      WHEN NEW.mailbox_id IS NOT NULL
        AND (SELECT owner_id FROM mailboxes WHERE id = NEW.mailbox_id) IS NOT NEW.actor_id
      BEGIN
        SELECT RAISE(ABORT, 'audit mailbox owner mismatch');
      END;
    `);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    return row.count;
  }

  createUser(input: CreateUserInput): UserRecord {
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      role: input.role,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db.prepare(`
        INSERT INTO users (id, email, name, password_hash, role, disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(user.id, user.email, user.name, input.passwordHash, user.role, now, now);
      return user;
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new AppError("USER_EXISTS", "A user with this email address already exists.", 409);
      }
      throw error;
    }
  }

  getUserById(id: string): UserRecord | undefined {
    return mapUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  getUserWithPasswordByEmail(email: string): UserWithPassword | undefined {
    return mapUserWithPassword(
      this.db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email.trim().toLowerCase()),
    );
  }

  findUserByOAuthSubject(subject: string): UserRecord | undefined {
    return mapUser(this.db.prepare("SELECT * FROM users WHERE oauth_subject = ?").get(subject));
  }

  findUserByEmail(email: string): UserRecord | undefined {
    return mapUser(this.db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email.trim().toLowerCase()));
  }

  getFirstActiveUser(): UserRecord | undefined {
    return mapUser(this.db.prepare("SELECT * FROM users WHERE disabled = 0 ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at LIMIT 1").get());
  }

  listUsers(): UserRecord[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY created_at").all() as unknown[])
      .map(mapUser)
      .filter((entry): entry is UserRecord => Boolean(entry));
  }

  linkOAuthSubject(userId: string, subject: string): void {
    this.setOAuthSubject(userId, subject);
  }

  setOAuthSubject(userId: string, subject?: string): void {
    try {
      this.db.prepare("UPDATE users SET oauth_subject = ?, updated_at = ? WHERE id = ?")
        .run(subject?.trim() || null, new Date().toISOString(), userId);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new AppError("OAUTH_SUBJECT_IN_USE", "That OAuth identity is already linked to another user.", 409);
      }
      throw error;
    }
  }

  updateUserPassword(userId: string, passwordHash: string): void {
    this.requireChanged(
      this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, new Date().toISOString(), userId).changes,
      "USER_NOT_FOUND",
      "The user could not be found.",
    );
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  setUserDisabled(userId: string, disabled: boolean): void {
    this.requireChanged(
      this.db.prepare("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?")
        .run(disabled ? 1 : 0, new Date().toISOString(), userId).changes,
      "USER_NOT_FOUND",
      "The user could not be found.",
    );
    if (disabled) {
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      this.db.prepare("UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?")
        .run(new Date().toISOString(), userId);
    }
  }

  createSession(session: SessionRecord): void {
    this.cleanupExpiredSessions();
    this.db.prepare(`
      INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.tokenHash,
      session.userId,
      session.csrfToken,
      session.createdAt,
      session.expiresAt,
      session.lastSeenAt,
    );
  }

  getSession(tokenHash: string): SessionRecord | undefined {
    const row = this.db.prepare(`
      SELECT s.* FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0
    `).get(tokenHash, new Date().toISOString());
    return mapSession(row);
  }

  touchSession(tokenHash: string): void {
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(new Date().toISOString(), tokenHash);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  cleanupExpiredSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }

  countMailboxes(ownerId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM mailboxes WHERE owner_id = ?")
      .get(ownerId) as { count: number };
    return row.count;
  }

  createMailbox(input: CreateMailboxInput): StoredMailbox {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    try {
      this.db.prepare(`
        INSERT INTO mailboxes (
          id, owner_id, email_address, display_name,
          imap_host, imap_port, imap_secure, imap_reject_unauthorized, imap_sent_folder,
          smtp_host, smtp_port, smtp_secure, smtp_reject_unauthorized,
          read_enabled, send_enabled, save_sent_copy, status,
          encrypted_secrets, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untested', ?, ?, ?)
      `).run(
        id,
        input.ownerId,
        input.emailAddress.trim().toLowerCase(),
        nullable(input.displayName),
        input.imapHost.trim(),
        input.imapPort,
        boolInt(input.imapSecure),
        boolInt(input.imapRejectUnauthorized),
        nullable(input.imapSentFolder),
        input.smtpHost.trim(),
        input.smtpPort,
        boolInt(input.smtpSecure),
        boolInt(input.smtpRejectUnauthorized),
        boolInt(input.readEnabled),
        boolInt(input.sendEnabled),
        boolInt(input.saveSentCopy),
        input.encryptedSecrets,
        now,
        now,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new AppError("MAILBOX_EXISTS", "That mailbox address is already configured for this user.", 409);
      }
      throw error;
    }
    return this.requireMailboxOwned(input.ownerId, id);
  }

  updateMailbox(ownerId: string, mailboxId: string, input: UpdateMailboxInput): StoredMailbox {
    const current = this.requireMailboxOwned(ownerId, mailboxId);
    const encryptedSecrets = input.encryptedSecrets ?? current.encryptedSecrets;
    try {
      const result = this.db.prepare(`
        UPDATE mailboxes SET
          email_address = ?, display_name = ?,
          imap_host = ?, imap_port = ?, imap_secure = ?, imap_reject_unauthorized = ?, imap_sent_folder = ?,
          smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_reject_unauthorized = ?,
          read_enabled = ?, send_enabled = ?, save_sent_copy = ?,
          status = CASE WHEN ? = 0 AND ? = 0 THEN 'disabled' ELSE 'untested' END,
          last_error = NULL, encrypted_secrets = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(
        input.emailAddress.trim().toLowerCase(),
        nullable(input.displayName),
        input.imapHost.trim(),
        input.imapPort,
        boolInt(input.imapSecure),
        boolInt(input.imapRejectUnauthorized),
        nullable(input.imapSentFolder),
        input.smtpHost.trim(),
        input.smtpPort,
        boolInt(input.smtpSecure),
        boolInt(input.smtpRejectUnauthorized),
        boolInt(input.readEnabled),
        boolInt(input.sendEnabled),
        boolInt(input.saveSentCopy),
        boolInt(input.readEnabled),
        boolInt(input.sendEnabled),
        encryptedSecrets,
        new Date().toISOString(),
        mailboxId,
        ownerId,
      );
      this.requireChanged(result.changes, "MAILBOX_NOT_FOUND", "The mailbox could not be found.");
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new AppError("MAILBOX_EXISTS", "That mailbox address is already configured for this user.", 409);
      }
      throw error;
    }
    return this.requireMailboxOwned(ownerId, mailboxId);
  }

  listMailboxes(ownerId: string): StoredMailbox[] {
    return (this.db.prepare("SELECT * FROM mailboxes WHERE owner_id = ? ORDER BY email_address")
      .all(ownerId) as unknown[])
      .map(mapMailbox)
      .filter((entry): entry is StoredMailbox => Boolean(entry));
  }

  getMailboxOwned(ownerId: string, mailboxId: string): StoredMailbox | undefined {
    return mapMailbox(this.db.prepare("SELECT * FROM mailboxes WHERE id = ? AND owner_id = ?").get(mailboxId, ownerId));
  }

  requireMailboxOwned(ownerId: string, mailboxId: string): StoredMailbox {
    const mailbox = this.getMailboxOwned(ownerId, mailboxId);
    if (!mailbox) {
      throw new AppError("MAILBOX_NOT_FOUND", "The mailbox could not be found or is not available to this user.", 404);
    }
    return mailbox;
  }

  deleteMailbox(ownerId: string, mailboxId: string): void {
    const result = this.db.prepare("DELETE FROM mailboxes WHERE id = ? AND owner_id = ?").run(mailboxId, ownerId);
    this.requireChanged(result.changes, "MAILBOX_NOT_FOUND", "The mailbox could not be found.");
  }

  setMailboxStatus(ownerId: string, mailboxId: string, status: MailboxRecord["status"], error?: string): void {
    this.db.prepare(`
      UPDATE mailboxes SET status = ?, last_checked_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `).run(
      status,
      new Date().toISOString(),
      error ? error.slice(0, 1_000) : null,
      new Date().toISOString(),
      mailboxId,
      ownerId,
    );
  }

  createApiToken(record: ApiTokenRecord): void {
    this.db.prepare(`
      INSERT INTO api_tokens (id, user_id, name, token_hash, scopes_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.userId,
      record.name,
      record.tokenHash,
      JSON.stringify(record.scopes),
      record.createdAt,
      record.expiresAt ?? null,
    );
  }

  findApiTokenByHash(hash: string): ApiTokenRecord | undefined {
    const row = this.db.prepare(`
      SELECT t.* FROM api_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > ?)
        AND u.disabled = 0
    `).get(hash, new Date().toISOString());
    return mapApiToken(row);
  }

  touchApiToken(id: string): void {
    this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  listApiTokens(userId: string): ApiTokenRecord[] {
    return (this.db.prepare("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as unknown[])
      .map(mapApiToken)
      .filter((entry): entry is ApiTokenRecord => Boolean(entry));
  }

  revokeApiToken(userId: string, tokenId: string): void {
    this.requireChanged(
      this.db.prepare("UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?")
        .run(new Date().toISOString(), tokenId, userId).changes,
      "TOKEN_NOT_FOUND",
      "The token could not be found.",
    );
  }

  saveDraft(draft: DraftRecord): void {
    this.db.prepare(`
      INSERT INTO drafts (
        id, owner_id, mailbox_id, mailbox_address, mailbox_display_name,
        kind, status, source_message_id, source_ref_json,
        to_json, cc_json, bcc_json, subject, body_text, in_reply_to, references_json,
        include_source_attachments, attachment_metadata_json, revision,
        created_at, updated_at, sent_at, smtp_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.id,
      draft.ownerId,
      draft.mailboxId,
      draft.mailboxAddress,
      draft.mailboxDisplayName ?? null,
      draft.kind,
      draft.status,
      draft.sourceMessageId,
      JSON.stringify(draft.sourceRef),
      JSON.stringify(draft.to),
      JSON.stringify(draft.cc),
      JSON.stringify(draft.bcc),
      draft.subject,
      draft.bodyText,
      draft.inReplyTo ?? null,
      JSON.stringify(draft.references),
      boolInt(draft.includeSourceAttachments),
      JSON.stringify(draft.attachmentMetadata),
      draft.revision,
      draft.createdAt,
      draft.updatedAt,
      draft.sentAt ?? null,
      draft.smtpMessageId ?? null,
    );
  }

  getDraftOwned(ownerId: string, draftId: string): DraftRecord | undefined {
    return mapDraft(this.db.prepare("SELECT * FROM drafts WHERE id = ? AND owner_id = ?").get(draftId, ownerId));
  }

  requireDraftOwned(ownerId: string, draftId: string): DraftRecord {
    const draft = this.getDraftOwned(ownerId, draftId);
    if (!draft) throw new AppError("DRAFT_NOT_FOUND", "The draft could not be found.", 404);
    return draft;
  }

  updateDraft(draft: DraftRecord): void {
    const result = this.db.prepare(`
      UPDATE drafts SET
        mailbox_address = ?, mailbox_display_name = ?, status = ?,
        to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_text = ?,
        include_source_attachments = ?, attachment_metadata_json = ?, revision = ?,
        updated_at = ?, sent_at = ?, smtp_message_id = ?
      WHERE id = ? AND owner_id = ?
    `).run(
      draft.mailboxAddress,
      draft.mailboxDisplayName ?? null,
      draft.status,
      JSON.stringify(draft.to),
      JSON.stringify(draft.cc),
      JSON.stringify(draft.bcc),
      draft.subject,
      draft.bodyText,
      boolInt(draft.includeSourceAttachments),
      JSON.stringify(draft.attachmentMetadata),
      draft.revision,
      draft.updatedAt,
      draft.sentAt ?? null,
      draft.smtpMessageId ?? null,
      draft.id,
      draft.ownerId,
    );
    this.requireChanged(result.changes, "DRAFT_NOT_FOUND", "The draft could not be found.");
  }

  listDrafts(ownerId: string, limit = 100): DraftRecord[] {
    return (this.db.prepare("SELECT * FROM drafts WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(ownerId, limit) as unknown[])
      .map(mapDraft)
      .filter((entry): entry is DraftRecord => Boolean(entry));
  }

  hasSendingApproval(ownerId: string, draftId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 AS found FROM approvals WHERE owner_id = ? AND draft_id = ? AND status = 'sending' LIMIT 1
    `).get(ownerId, draftId));
  }

  saveApproval(approval: ApprovalRecord): void {
    this.db.prepare(`
      INSERT INTO approvals (
        token_hash, owner_id, draft_id, draft_hash, status, created_at, expires_at,
        used_at, completed_at, error, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.tokenHash,
      approval.ownerId,
      approval.draftId,
      approval.draftHash,
      approval.status,
      approval.createdAt,
      approval.expiresAt,
      approval.usedAt ?? null,
      approval.completedAt ?? null,
      approval.error ?? null,
      approval.result ? JSON.stringify(approval.result) : null,
    );
  }

  getApprovalOwned(ownerId: string, tokenHash: string): ApprovalRecord | undefined {
    return mapApproval(this.db.prepare("SELECT * FROM approvals WHERE token_hash = ? AND owner_id = ?")
      .get(tokenHash, ownerId));
  }

  updateApproval(approval: ApprovalRecord): void {
    const result = this.db.prepare(`
      UPDATE approvals SET status = ?, used_at = ?, completed_at = ?, error = ?, result_json = ?
      WHERE token_hash = ? AND owner_id = ?
    `).run(
      approval.status,
      approval.usedAt ?? null,
      approval.completedAt ?? null,
      approval.error ?? null,
      approval.result ? JSON.stringify(approval.result) : null,
      approval.tokenHash,
      approval.ownerId,
    );
    this.requireChanged(result.changes, "APPROVAL_NOT_FOUND", "The send approval could not be found.");
  }

  cancelPendingApprovals(ownerId: string, draftId: string, completedAt = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE approvals SET status = 'cancelled', completed_at = ?
      WHERE owner_id = ? AND draft_id = ? AND status = 'pending'
    `).run(completedAt, ownerId, draftId);
  }

  deleteOldApprovals(beforeIso: string): void {
    this.db.prepare("DELETE FROM approvals WHERE expires_at < ? AND status != 'sending'").run(beforeIso);
  }

  addAudit(record: AuditRecord): void {
    this.db.prepare(`
      INSERT INTO audit (
        id, timestamp, actor_id, mailbox_id, action, status,
        draft_id, source_message_id, recipient_domains_json, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.timestamp,
      record.actorId,
      record.mailboxId ?? null,
      record.action,
      record.status,
      record.draftId ?? null,
      record.sourceMessageId ?? null,
      record.recipientDomains ? JSON.stringify(record.recipientDomains) : null,
      record.detail ?? null,
    );
  }

  listAudit(ownerId: string, limit = 200): AuditRecord[] {
    return (this.db.prepare("SELECT * FROM audit WHERE actor_id = ? ORDER BY timestamp DESC LIMIT ?")
      .all(ownerId, limit) as unknown[])
      .map(mapAudit)
      .filter((entry): entry is AuditRecord => Boolean(entry));
  }

  static audit(input: Omit<AuditRecord, "id" | "timestamp">): AuditRecord {
    return { id: randomUUID(), timestamp: new Date().toISOString(), ...input };
  }

  private requireChanged(changes: number | bigint, code: string, message: string): void {
    if (Number(changes) < 1) throw new AppError(code, message, 404);
  }
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

function nullable(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function rowObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid database value for ${key}`);
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Invalid database value for ${key}`);
  return value;
}

function mapUser(value: unknown): UserRecord | undefined {
  const row = rowObject(value);
  if (!row) return undefined;
  const oauthSubject = optionalString(row, "oauth_subject");
  return {
    id: stringValue(row, "id"),
    email: stringValue(row, "email"),
    name: stringValue(row, "name"),
    role: stringValue(row, "role") as UserRecord["role"],
    ...(oauthSubject ? { oauthSubject } : {}),
    disabled: numberValue(row, "disabled") === 1,
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  };
}

function mapUserWithPassword(value: unknown): UserWithPassword | undefined {
  const row = rowObject(value);
  const user = mapUser(value);
  return row && user ? { ...user, passwordHash: stringValue(row, "password_hash") } : undefined;
}

function mapSession(value: unknown): SessionRecord | undefined {
  const row = rowObject(value);
  if (!row) return undefined;
  return {
    tokenHash: stringValue(row, "token_hash"),
    userId: stringValue(row, "user_id"),
    csrfToken: stringValue(row, "csrf_token"),
    createdAt: stringValue(row, "created_at"),
    expiresAt: stringValue(row, "expires_at"),
    lastSeenAt: stringValue(row, "last_seen_at"),
  };
}

function mapMailbox(value: unknown): StoredMailbox | undefined {
  const row = rowObject(value);
  if (!row) return undefined;
  const displayName = optionalString(row, "display_name");
  const sentFolder = optionalString(row, "imap_sent_folder");
  const lastCheckedAt = optionalString(row, "last_checked_at");
  const lastError = optionalString(row, "last_error");
  return {
    id: stringValue(row, "id"),
    ownerId: stringValue(row, "owner_id"),
    emailAddress: stringValue(row, "email_address"),
    ...(displayName ? { displayName } : {}),
    imapHost: stringValue(row, "imap_host"),
    imapPort: numberValue(row, "imap_port"),
    imapSecure: numberValue(row, "imap_secure") === 1,
    imapRejectUnauthorized: numberValue(row, "imap_reject_unauthorized") === 1,
    ...(sentFolder ? { imapSentFolder: sentFolder } : {}),
    smtpHost: stringValue(row, "smtp_host"),
    smtpPort: numberValue(row, "smtp_port"),
    smtpSecure: numberValue(row, "smtp_secure") === 1,
    smtpRejectUnauthorized: numberValue(row, "smtp_reject_unauthorized") === 1,
    readEnabled: numberValue(row, "read_enabled") === 1,
    sendEnabled: numberValue(row, "send_enabled") === 1,
    saveSentCopy: numberValue(row, "save_sent_copy") === 1,
    status: stringValue(row, "status") as MailboxRecord["status"],
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    ...(lastError ? { lastError } : {}),
    encryptedSecrets: stringValue(row, "encrypted_secrets"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  };
}

function mapApiToken(value: unknown): ApiTokenRecord | undefined {
  const row = rowObject(value);
  if (!row) return undefined;
  const expiresAt = optionalString(row, "expires_at");
  const lastUsedAt = optionalString(row, "last_used_at");
  const revokedAt = optionalString(row, "revoked_at");
  return {
    id: stringValue(row, "id"),
    userId: stringValue(row, "user_id"),
    name: stringValue(row, "name"),
    tokenHash: stringValue(row, "token_hash"),
    scopes: parseJson<string[]>(stringValue(row, "scopes_json"), []),
    createdAt: stringValue(row, "created_at"),
    ...(expiresAt ? { expiresAt } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function mapDraft(value: unknown): DraftRecord | undefined {
  const row = rowObject(value);
  if (!row) return undefined;
  const mailboxDisplayName = optionalString(row, "mailbox_display_name");
  const inReplyTo = optionalString(row, "in_reply_to");
  const sentAt = optionalString(row, "sent_at");
  const smtpMessageId = optionalString(row, "smtp_message_id");
  return {
    id: stringValue(row, "id"),
    ownerId: stringValue(row, "owner_id"),
    mailboxId: stringValue(row, "mailbox_id"),
    mailboxAddress: stringValue(row, "mailbox_address"),
    ...(mailboxDisplayName ? { mailboxDisplayName } : {}),
    kind: stringValue(row, "kind") as DraftRecord["kind"],
    status: stringValue(row, "status") as DraftRecord["status"],
    sourceMessageId: stringValue(row, "source_message_id"),
    sourceRef: parseJson(stringValue(row, "source_ref_json"), { mailboxId: "", folder: "INBOX", uid: 0 }),
    to: parseJson(stringValue(row, "to_json"), []),
    cc: parseJson(stringValue(row, "cc_json"), []),
    bcc: parseJson(stringValue(row, "bcc_json"), []),
    subject: stringValue(row, "subject"),
    bodyText: stringValue(row, "body_text"),
    ...(inReplyTo ? { inReplyTo } : {}),
    references: parseJson<string[]>(stringValue(row, "references_json"), []),
    includeSourceAttachments: numberValue(row, "include_source_attachments") === 1,
    attachmentMetadata: parseJson(stringValue(row, "attachment_metadata_json"), []),
    revision: numberValue(row, "revision"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
    ...(sentAt ? { sentAt } : {}),
    ...(smtpMessageId ? { smtpMessageId } : {}),
  };
}

function mapApproval(value: unknown): ApprovalRecord | undefined {
  const row = rowObject(value);
  if (!row) return undefined;
  const usedAt = optionalString(row, "used_at");
  const completedAt = optionalString(row, "completed_at");
  const error = optionalString(row, "error");
  const resultJson = optionalString(row, "result_json");
  const result = resultJson ? parseJson<ApprovalRecord["result"]>(resultJson, undefined) : undefined;
  return {
    tokenHash: stringValue(row, "token_hash"),
    ownerId: stringValue(row, "owner_id"),
    draftId: stringValue(row, "draft_id"),
    draftHash: stringValue(row, "draft_hash"),
    status: stringValue(row, "status") as ApprovalRecord["status"],
    createdAt: stringValue(row, "created_at"),
    expiresAt: stringValue(row, "expires_at"),
    ...(usedAt ? { usedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(error ? { error } : {}),
    ...(result ? { result } : {}),
  };
}

function mapAudit(value: unknown): AuditRecord | undefined {
  const row = rowObject(value);
  if (!row) return undefined;
  const mailboxId = optionalString(row, "mailbox_id");
  const draftId = optionalString(row, "draft_id");
  const sourceMessageId = optionalString(row, "source_message_id");
  const recipientDomainsJson = optionalString(row, "recipient_domains_json");
  const detail = optionalString(row, "detail");
  return {
    id: stringValue(row, "id"),
    timestamp: stringValue(row, "timestamp"),
    actorId: stringValue(row, "actor_id"),
    ...(mailboxId ? { mailboxId } : {}),
    action: stringValue(row, "action"),
    status: stringValue(row, "status") as AuditRecord["status"],
    ...(draftId ? { draftId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(recipientDomainsJson ? { recipientDomains: parseJson<string[]>(recipientDomainsJson, []) } : {}),
    ...(detail ? { detail } : {}),
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
