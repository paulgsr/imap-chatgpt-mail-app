import type {
  AttachmentMetadata,
  DraftRecord,
  EmailDetail,
  EmailSummary,
  MailAddress,
  MailFolder,
  MailboxSummary,
  SendResult,
} from "../domain.js";

export function addressToOutput(address: MailAddress): Record<string, string> {
  return { ...(address.name ? { name: address.name } : {}), address: address.address };
}

export function attachmentToOutput(attachment: AttachmentMetadata): Record<string, unknown> {
  return {
    index: attachment.index,
    filename: attachment.filename,
    content_type: attachment.contentType,
    size: attachment.size,
    inline: attachment.inline,
    ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
  };
}

export function mailboxToOutput(mailbox: MailboxSummary): Record<string, unknown> {
  return {
    mailbox_id: mailbox.id,
    label: mailbox.displayName || mailbox.emailAddress,
    email_address: mailbox.emailAddress,
    ...(mailbox.displayName ? { display_name: mailbox.displayName } : {}),
    reading_enabled: mailbox.readEnabled,
    sending_enabled: mailbox.sendEnabled,
    status: mailbox.status,
    ...(mailbox.lastError ? { last_error: mailbox.lastError } : {}),
    ...(mailbox.lastCheckedAt ? { last_checked_at: mailbox.lastCheckedAt } : {}),
  };
}

export function folderToOutput(folder: MailFolder): Record<string, unknown> {
  return {
    mailbox_id: folder.mailboxId,
    mailbox_address: folder.mailboxAddress,
    mailbox_label: folder.mailboxAddress,
    path: folder.path,
    name: folder.name,
    subscribed: folder.subscribed,
    ...(folder.specialUse ? { special_use: folder.specialUse } : {}),
    ...(folder.messages !== undefined ? { messages: folder.messages } : {}),
    ...(folder.unseen !== undefined ? { unseen: folder.unseen } : {}),
  };
}

export function emailSummaryToOutput(email: EmailSummary): Record<string, unknown> {
  return {
    id: email.id,
    mailbox_id: email.mailboxId,
    mailbox_address: email.mailboxAddress,
    mailbox_label: email.mailboxDisplayName || email.mailboxAddress,
    received_by: email.receivedBy,
    folder: email.folder,
    uid: email.uid,
    subject: email.subject,
    from: email.from.map(addressToOutput),
    to: email.to.map(addressToOutput),
    cc: email.cc.map(addressToOutput),
    ...(email.receivedAt ? { received_at: email.receivedAt } : {}),
    ...(email.size !== undefined ? { size: email.size } : {}),
    is_read: email.isRead,
    is_answered: email.isAnswered,
    has_attachments: email.hasAttachments,
    preview: email.preview,
  };
}

export function emailDetailToOutput(email: EmailDetail): Record<string, unknown> {
  return {
    ...emailSummaryToOutput(email),
    reply_to: email.replyTo.map(addressToOutput),
    body_text: email.bodyText,
    body_truncated: email.bodyTruncated,
    attachments: email.attachments.map(attachmentToOutput),
    ...(email.messageId ? { internet_message_id: email.messageId } : {}),
    ...(email.inReplyTo ? { in_reply_to: email.inReplyTo } : {}),
    references: email.references,
  };
}

export function draftToOutput(draft: DraftRecord, includeBody = true): Record<string, unknown> {
  return {
    draft_id: draft.id,
    mailbox_id: draft.mailboxId,
    mailbox_address: draft.mailboxAddress,
    mailbox_label: draft.mailboxDisplayName || draft.mailboxAddress,
    kind: draft.kind,
    status: draft.status,
    source_message_id: draft.sourceMessageId,
    to: draft.to.map(addressToOutput),
    cc: draft.cc.map(addressToOutput),
    bcc: draft.bcc.map(addressToOutput),
    subject: draft.subject,
    ...(includeBody ? { body_text: draft.bodyText } : {}),
    include_source_attachments: draft.includeSourceAttachments,
    attachments: draft.attachmentMetadata.map(attachmentToOutput),
    revision: draft.revision,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
    ...(draft.sentAt ? { sent_at: draft.sentAt } : {}),
    ...(draft.smtpMessageId ? { smtp_message_id: draft.smtpMessageId } : {}),
  };
}

export function sendResultToOutput(result: SendResult): Record<string, unknown> {
  return {
    draft_id: result.draftId,
    mailbox_id: result.mailboxId,
    mailbox_address: result.fromAddress,
    message_id: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
    sent_at: result.sentAt,
    sent_copy_saved: result.sentCopySaved,
  };
}
