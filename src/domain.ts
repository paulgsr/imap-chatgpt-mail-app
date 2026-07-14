export interface MailAddress {
  name?: string;
  address: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  oauthSubject?: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface MailboxRecord {
  id: string;
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
  status: "untested" | "connected" | "error" | "disabled";
  lastCheckedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MailboxSecretPayload {
  imapUsername: string;
  imapPassword: string;
  smtpUsername: string;
  smtpPassword: string;
}

export interface MailboxRuntimeConfig extends MailboxRecord, MailboxSecretPayload {}

export interface MailboxSummary {
  id: string;
  emailAddress: string;
  displayName?: string;
  readEnabled: boolean;
  sendEnabled: boolean;
  status: MailboxRecord["status"];
  lastCheckedAt?: string;
  lastError?: string;
}

export interface AttachmentMetadata {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  contentId?: string;
}

export interface EmailSummary {
  id: string;
  mailboxId: string;
  mailboxAddress: string;
  mailboxDisplayName?: string;
  receivedBy: string;
  folder: string;
  uid: number;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  receivedAt?: string;
  size?: number;
  isRead: boolean;
  isAnswered: boolean;
  hasAttachments: boolean;
  preview: string;
  messageId?: string;
}

export interface EmailDetail extends EmailSummary {
  replyTo: MailAddress[];
  bodyText: string;
  bodyTruncated: boolean;
  attachments: AttachmentMetadata[];
  inReplyTo?: string;
  references: string[];
}

export interface MailFolder {
  mailboxId: string;
  mailboxAddress: string;
  path: string;
  name: string;
  specialUse?: string;
  subscribed: boolean;
  messages?: number;
  unseen?: number;
}

export interface SearchEmailsInput {
  folder: string;
  query?: string;
  from?: string;
  subject?: string;
  unread?: boolean;
  since?: string;
  before?: string;
  limit: number;
}

export interface MultiMailboxSearchInput extends SearchEmailsInput {
  mailboxIds?: string[];
}

export interface MessageRef {
  mailboxId: string;
  folder: string;
  uid: number;
}

export interface ForwardAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  contentDisposition?: string;
  contentId?: string;
}

export type DraftKind = "reply" | "forward";
export type DraftStatus = "draft" | "sent";

export interface DraftRecord {
  id: string;
  ownerId: string;
  mailboxId: string;
  mailboxAddress: string;
  mailboxDisplayName?: string;
  kind: DraftKind;
  status: DraftStatus;
  sourceMessageId: string;
  sourceRef: MessageRef;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  references: string[];
  includeSourceAttachments: boolean;
  attachmentMetadata: AttachmentMetadata[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  smtpMessageId?: string;
}

export type ApprovalStatus = "pending" | "sending" | "sent" | "cancelled" | "failed";

export interface ApprovalRecord {
  tokenHash: string;
  ownerId: string;
  draftId: string;
  draftHash: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  completedAt?: string;
  error?: string;
  result?: SendResult;
}

export interface SendResult {
  draftId: string;
  mailboxId: string;
  fromAddress: string;
  messageId: string;
  accepted: string[];
  rejected: string[];
  sentAt: string;
  sentCopySaved: boolean;
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  actorId: string;
  mailboxId?: string;
  action: string;
  status: "success" | "failure";
  draftId?: string;
  sourceMessageId?: string;
  recipientDomains?: string[];
  detail?: string;
}

export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}
