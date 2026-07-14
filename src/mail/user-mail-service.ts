import type {
  EmailDetail,
  EmailSummary,
  ForwardAttachment,
  MailFolder,
  MailboxSummary,
  MultiMailboxSearchInput,
} from "../domain.js";

export interface MailboxOperationError {
  mailboxId: string;
  mailboxAddress: string;
  error: string;
}

export interface FolderListResult {
  folders: MailFolder[];
  errors: MailboxOperationError[];
}

export interface EmailSearchResult {
  messages: EmailSummary[];
  errors: MailboxOperationError[];
}

export interface UserMailService {
  listMailboxes(actorId: string): Promise<MailboxSummary[]>;
  listFolders(actorId: string, mailboxIds?: string[]): Promise<FolderListResult>;
  searchEmails(actorId: string, input: MultiMailboxSearchInput): Promise<EmailSearchResult>;
  getEmail(actorId: string, messageId: string): Promise<EmailDetail>;
  getThread(actorId: string, messageId: string, limit: number): Promise<EmailDetail[]>;
  loadForwardAttachments(actorId: string, messageId: string): Promise<ForwardAttachment[]>;
}
