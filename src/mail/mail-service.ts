import type {
  EmailDetail,
  EmailSummary,
  ForwardAttachment,
  MailFolder,
  SearchEmailsInput,
} from "../domain.js";

export interface MailService {
  verifyConnection(): Promise<void>;
  listFolders(): Promise<MailFolder[]>;
  searchEmails(input: SearchEmailsInput): Promise<EmailSummary[]>;
  getEmail(messageId: string): Promise<EmailDetail>;
  getThread(messageId: string, limit: number): Promise<EmailDetail[]>;
  loadForwardAttachments(messageId: string): Promise<ForwardAttachment[]>;
  appendSentCopy(rawMessage: Buffer): Promise<boolean>;
}
