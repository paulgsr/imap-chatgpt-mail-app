import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { ApprovalRecord, DraftRecord, SendResult } from "../domain.js";
import { AppError } from "../errors.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { sha256, stableDraftPayload } from "../util/values.js";

export interface CreatedApproval {
  token: string;
  expiresAt: string;
}

export interface ClaimedApproval {
  tokenHash: string;
  draftId: string;
  alreadySent?: SendResult;
}

export class ApprovalService {
  constructor(
    private readonly store: SqliteStore,
    private readonly config: AppConfig,
  ) {}

  async create(actorId: string, draft: DraftRecord): Promise<CreatedApproval> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.limits.sendApprovalTtlSeconds * 1_000).toISOString();
    const approval: ApprovalRecord = {
      tokenHash,
      ownerId: actorId,
      draftId: draft.id,
      draftHash: this.hashDraft(draft),
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt,
    };

    this.store.transaction(() => {
      this.store.deleteOldApprovals(new Date(now.getTime() - 86_400_000).toISOString());
      this.store.cancelPendingApprovals(actorId, draft.id, now.toISOString());
      this.store.saveApproval(approval);
      this.store.addAudit(SqliteStore.audit({
        actorId,
        mailboxId: draft.mailboxId,
        action: "prepare_send_draft",
        status: "success",
        draftId: draft.id,
      }));
    });

    return { token, expiresAt };
  }

  async cancel(actorId: string, token: string): Promise<void> {
    const tokenHash = sha256(token);
    this.store.transaction(() => {
      const approval = this.requireOwnedApproval(this.store.getApprovalOwned(actorId, tokenHash), actorId);
      if (approval.status === "pending") {
        approval.status = "cancelled";
        approval.completedAt = new Date().toISOString();
      } else if (approval.status === "sent") {
        throw new AppError("APPROVAL_ALREADY_SENT", "This approval has already sent the email.");
      } else if (approval.status === "sending") {
        throw new AppError("SEND_IN_PROGRESS", "The email is already being sent and can no longer be cancelled.");
      } else if (approval.status !== "cancelled") {
        throw new AppError("APPROVAL_NOT_PENDING", `This approval is ${approval.status}.`);
      }
      this.store.updateApproval(approval);
      const draft = this.store.getDraftOwned(actorId, approval.draftId);
      this.store.addAudit(SqliteStore.audit({
        actorId,
        ...(draft ? { mailboxId: draft.mailboxId } : {}),
        action: "cancel_send_approval",
        status: "success",
        draftId: approval.draftId,
      }));
    });
  }

  async claim(actorId: string, token: string, draft: DraftRecord): Promise<ClaimedApproval> {
    const tokenHash = sha256(token);
    return this.store.transaction(() => {
      const approval = this.requireOwnedApproval(this.store.getApprovalOwned(actorId, tokenHash), actorId);
      if (approval.draftId !== draft.id) {
        throw new AppError("APPROVAL_MISMATCH", "The approval does not belong to this draft.");
      }
      if (approval.status === "sent" && approval.result) {
        return { tokenHash, draftId: draft.id, alreadySent: approval.result };
      }
      if (approval.status !== "pending") {
        throw new AppError("APPROVAL_NOT_PENDING", `This approval is ${approval.status}.`);
      }
      if (new Date(approval.expiresAt).getTime() <= Date.now()) {
        approval.status = "cancelled";
        approval.completedAt = new Date().toISOString();
        this.store.updateApproval(approval);
        throw new AppError("APPROVAL_EXPIRED", "The send approval expired. Prepare the draft again.");
      }
      if (approval.draftHash !== this.hashDraft(draft)) {
        approval.status = "cancelled";
        approval.completedAt = new Date().toISOString();
        this.store.updateApproval(approval);
        throw new AppError(
          "DRAFT_CHANGED_AFTER_APPROVAL",
          "The draft changed after it was presented for approval. Review it again before sending.",
        );
      }

      approval.status = "sending";
      approval.usedAt = new Date().toISOString();
      this.store.updateApproval(approval);
      return { tokenHash, draftId: draft.id };
    });
  }

  async complete(actorId: string, tokenHash: string, result: SendResult): Promise<void> {
    this.store.transaction(() => {
      const approval = this.requireOwnedApproval(this.store.getApprovalOwned(actorId, tokenHash), actorId);
      approval.status = "sent";
      approval.result = result;
      approval.completedAt = result.sentAt;
      this.store.updateApproval(approval);

      const draft = this.store.requireDraftOwned(actorId, result.draftId);
      draft.status = "sent";
      draft.sentAt = result.sentAt;
      draft.smtpMessageId = result.messageId;
      draft.updatedAt = result.sentAt;
      this.store.updateDraft(draft);
      this.store.addAudit(SqliteStore.audit({
        actorId,
        mailboxId: draft.mailboxId,
        action: "send_draft",
        status: "success",
        draftId: result.draftId,
      }));
    });
  }

  async fail(actorId: string, tokenHash: string, error: string): Promise<void> {
    this.store.transaction(() => {
      const approval = this.requireOwnedApproval(this.store.getApprovalOwned(actorId, tokenHash), actorId);
      approval.status = "failed";
      approval.error = error.slice(0, 500);
      approval.completedAt = new Date().toISOString();
      this.store.updateApproval(approval);
      const draft = this.store.getDraftOwned(actorId, approval.draftId);
      this.store.addAudit(SqliteStore.audit({
        actorId,
        ...(draft ? { mailboxId: draft.mailboxId } : {}),
        action: "send_draft",
        status: "failure",
        draftId: approval.draftId,
        detail: approval.error,
      }));
    });
  }

  async invalidateDraft(actorId: string, draftId: string): Promise<void> {
    this.store.cancelPendingApprovals(actorId, draftId);
  }

  private hashDraft(draft: DraftRecord): string {
    return sha256(stableDraftPayload(draft));
  }

  private requireOwnedApproval(
    approval: ApprovalRecord | undefined,
    actorId: string,
  ): ApprovalRecord {
    if (!approval || approval.ownerId !== actorId) {
      throw new AppError("APPROVAL_NOT_FOUND", "The send approval could not be found.", 404);
    }
    return approval;
  }
}
