import type { DraftRecord, MailAddress, SendResult } from "../domain.js";

export interface CreateReplyDraftInput {
  messageId: string;
  bodyText: string;
  replyAll: boolean;
}

export interface CreateForwardDraftInput {
  messageId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  note: string;
  includeAttachments: boolean;
}

export interface UpdateDraftInput {
  draftId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  includeSourceAttachments?: boolean;
}

export interface PreparedSend {
  draft: DraftRecord;
  approvalToken: string;
  expiresAt: string;
}

export interface DraftService {
  createReply(actorId: string, input: CreateReplyDraftInput): Promise<DraftRecord>;
  createForward(actorId: string, input: CreateForwardDraftInput): Promise<DraftRecord>;
  getDraft(actorId: string, draftId: string): Promise<DraftRecord>;
  updateDraft(actorId: string, input: UpdateDraftInput): Promise<DraftRecord>;
  prepareSend(actorId: string, draftId: string): Promise<PreparedSend>;
  confirmSend(actorId: string, approvalToken: string): Promise<SendResult>;
  cancelSend(actorId: string, approvalToken: string): Promise<void>;
}

export function addressesFromStrings(values: string[]): MailAddress[] {
  return values.map((address) => ({ address: address.trim() })).filter((entry) => entry.address);
}
