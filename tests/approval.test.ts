import { describe, expect, it } from "vitest";
import { ApprovalService } from "../src/security/approval-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { sampleDraft, testConfig } from "./helpers.js";

describe("send approval boundary", () => {
  it("invalidates approval when the reviewed draft changes", async () => {
    const store = new SqliteStore(":memory:");
    store.initialize();
    try {
      const user = store.createUser({ email: "user@example.test", name: "User", passwordHash: "unused", role: "user" });
      const draft = sampleDraft({ ownerId: user.id });
      store.createMailbox({
        id: draft.mailboxId,
        ownerId: user.id,
        emailAddress: draft.mailboxAddress,
        imapHost: "imap.example.test",
        imapPort: 993,
        imapSecure: true,
        imapRejectUnauthorized: true,
        smtpHost: "smtp.example.test",
        smtpPort: 465,
        smtpSecure: true,
        smtpRejectUnauthorized: true,
        readEnabled: true,
        sendEnabled: true,
        saveSentCopy: true,
        encryptedSecrets: "encrypted-test-placeholder",
      });
      store.saveDraft(draft);
      const approvals = new ApprovalService(store, testConfig());
      const created = await approvals.create(user.id, draft);
      await expect(approvals.claim(user.id, created.token, { ...draft, revision: 2, bodyText: "Changed" }))
        .rejects.toMatchObject({ code: "DRAFT_CHANGED_AFTER_APPROVAL" });
    } finally {
      store.close();
    }
  });
});
