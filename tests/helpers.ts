import pino from "pino";
import type { AppConfig } from "../src/config.js";
import type {
  DraftRecord,
  EmailDetail,
  EmailSummary,
  ForwardAttachment,
  MailFolder,
  MailboxSummary,
  MultiMailboxSearchInput,
  SendResult,
} from "../src/domain.js";
import type { AppLogger } from "../src/logger.js";
import type { EmailSearchResult, FolderListResult, UserMailService } from "../src/mail/user-mail-service.js";
import type {
  CreateForwardDraftInput,
  CreateReplyDraftInput,
  DraftService,
  PreparedSend,
  UpdateDraftInput,
} from "../src/services/draft-service.js";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    nodeEnv: "test",
    port: 3000,
    bindHost: "127.0.0.1",
    publicBaseUrl: "http://localhost:3000",
    allowedHosts: ["localhost", "127.0.0.1"],
    trustProxy: false,
    logLevel: "silent",
    dataDir: "./data",
    databasePath: ":memory:",
    auth: { mode: "none", scopes: ["mail.read", "mail.draft", "mail.send"], autoLinkEmail: true },
    idSigningSecret: "test-secret-that-is-at-least-thirty-two-characters",
    credentialEncryptionKey: Buffer.alloc(32, 7),
    session: { cookieName: "test_session", ttlDays: 30, secure: false },
    allowSend: true,
    limits: {
      maxMailboxesPerUser: 20,
      maxParallelMailboxSearches: 4,
      maxSearchResults: 50,
      maxPreviewSourceBytes: 65_536,
      maxMessageBytes: 10_485_760,
      maxBodyChars: 50_000,
      maxForwardAttachmentBytes: 20_971_520,
      maxRecipients: 20,
      sendApprovalTtlSeconds: 600,
    },
  };
  return {
    ...base,
    ...overrides,
    auth: { ...base.auth, ...(overrides.auth ?? {}) },
    session: { ...base.session, ...(overrides.session ?? {}) },
    limits: { ...base.limits, ...(overrides.limits ?? {}) },
  };
}

export function testLogger(): AppLogger {
  return pino({ level: "silent" }) as AppLogger;
}

export function sampleEmail(overrides: Partial<EmailDetail> = {}): EmailDetail {
  return {
    id: "m2.opaque.signature",
    mailboxId: "11111111-1111-4111-8111-111111111111",
    mailboxAddress: "support@example.test",
    mailboxDisplayName: "Support",
    receivedBy: "support@example.test",
    folder: "INBOX",
    uid: 42,
    subject: "Order question",
    from: [{ name: "Customer", address: "customer@example.net" }],
    to: [{ address: "support@example.test" }],
    cc: [],
    receivedAt: "2026-07-14T08:00:00.000Z",
    size: 1200,
    isRead: false,
    isAnswered: false,
    hasAttachments: false,
    preview: "Could you help?",
    messageId: "<source@example.net>",
    replyTo: [],
    bodyText: "Could you help?",
    bodyTruncated: false,
    attachments: [],
    references: [],
    ...overrides,
  };
}

export function sampleDraft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    ownerId: "user-1",
    mailboxId: "11111111-1111-4111-8111-111111111111",
    mailboxAddress: "support@example.test",
    mailboxDisplayName: "Support",
    kind: "reply",
    status: "draft",
    sourceMessageId: "m2.opaque.signature",
    sourceRef: { mailboxId: "11111111-1111-4111-8111-111111111111", folder: "INBOX", uid: 42 },
    to: [{ address: "customer@example.net" }],
    cc: [],
    bcc: [],
    subject: "Re: Order question",
    bodyText: "Thanks for your message.",
    inReplyTo: "<source@example.net>",
    references: ["<source@example.net>"],
    includeSourceAttachments: false,
    attachmentMetadata: [],
    revision: 1,
    createdAt: "2026-07-14T09:00:00.000Z",
    updatedAt: "2026-07-14T09:00:00.000Z",
    ...overrides,
  };
}

export class FakeUserMailService implements UserMailService {
  readonly mailboxes: MailboxSummary[] = [{
    id: "11111111-1111-4111-8111-111111111111",
    emailAddress: "support@example.test",
    displayName: "Support",
    readEnabled: true,
    sendEnabled: true,
    status: "connected",
  }];
  readonly email = sampleEmail();

  async listMailboxes(_actorId: string): Promise<MailboxSummary[]> { return this.mailboxes; }
  async listFolders(_actorId: string, _mailboxIds?: string[]): Promise<FolderListResult> {
    const folders: MailFolder[] = [{
      mailboxId: this.mailboxes[0]!.id,
      mailboxAddress: this.mailboxes[0]!.emailAddress,
      path: "INBOX",
      name: "INBOX",
      subscribed: true,
      messages: 1,
      unseen: 1,
    }];
    return { folders, errors: [] };
  }
  async searchEmails(_actorId: string, _input: MultiMailboxSearchInput): Promise<EmailSearchResult> {
    return { messages: [this.email as EmailSummary], errors: [] };
  }
  async getEmail(_actorId: string, _messageId: string): Promise<EmailDetail> { return structuredClone(this.email); }
  async getThread(_actorId: string, _messageId: string, _limit: number): Promise<EmailDetail[]> { return [structuredClone(this.email)]; }
  async loadForwardAttachments(_actorId: string, _messageId: string): Promise<ForwardAttachment[]> { return []; }
}

export class FakeDraftService implements DraftService {
  constructor(private readonly draft: DraftRecord = sampleDraft()) {}
  async createReply(_actorId: string, _input: CreateReplyDraftInput): Promise<DraftRecord> { return this.draft; }
  async createForward(_actorId: string, _input: CreateForwardDraftInput): Promise<DraftRecord> { return this.draft; }
  async getDraft(_actorId: string, _draftId: string): Promise<DraftRecord> { return this.draft; }
  async updateDraft(_actorId: string, _input: UpdateDraftInput): Promise<DraftRecord> { return this.draft; }
  async prepareSend(_actorId: string, _draftId: string): Promise<PreparedSend> {
    return { draft: this.draft, approvalToken: "private-approval-token-that-is-long-enough-123", expiresAt: "2026-07-14T10:10:00.000Z" };
  }
  async confirmSend(_actorId: string, _approvalToken: string): Promise<SendResult> {
    return {
      draftId: this.draft.id,
      mailboxId: this.draft.mailboxId,
      fromAddress: this.draft.mailboxAddress,
      messageId: "<sent@example.test>",
      accepted: ["customer@example.net"],
      rejected: [],
      sentAt: "2026-07-14T10:00:00.000Z",
      sentCopySaved: false,
    };
  }
  async cancelSend(_actorId: string, _approvalToken: string): Promise<void> {}
}
