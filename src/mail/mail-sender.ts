import type { DraftRecord, ForwardAttachment, SendResult } from "../domain.js";

export interface MailSender {
  verifyConnection(): Promise<void>;
  sendDraft(draft: DraftRecord, attachments: ForwardAttachment[]): Promise<SendResult>;
}
