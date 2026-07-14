import { describe, expect, it } from "vitest";
import { CredentialCipher } from "../src/security/credential-cipher.js";
import { MessageIdCodec } from "../src/security/message-id-codec.js";
import { MailboxService } from "../src/services/mailbox-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { sampleDraft, testConfig, testLogger } from "./helpers.js";

describe("encrypted mailbox ownership", () => {
  it("encrypts credentials and rejects another user even with the mailbox ID", () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    store.initialize();
    try {
      const passwordHash = "not-used-in-this-test";
      const patrick = store.createUser({ email: "patrick@example.test", name: "Patrick", passwordHash, role: "admin" });
      const other = store.createUser({ email: "other@example.test", name: "Other", passwordHash, role: "user" });
      const service = new MailboxService(
        config,
        store,
        new CredentialCipher(config.credentialEncryptionKey),
        new MessageIdCodec(config.idSigningSecret),
        testLogger(),
      );
      const mailbox = service.create(patrick.id, {
        emailAddress: "support@example.test",
        displayName: "Support",
        imapHost: "imap.example.test",
        imapPort: 993,
        imapSecure: true,
        imapRejectUnauthorized: true,
        imapUsername: "support@example.test",
        imapPassword: "imap-super-secret",
        smtpHost: "smtp.example.test",
        smtpPort: 465,
        smtpSecure: true,
        smtpRejectUnauthorized: true,
        smtpUsername: "support@example.test",
        smtpPassword: "smtp-super-secret",
        readEnabled: true,
        sendEnabled: false,
        saveSentCopy: true,
      });

      const stored = store.requireMailboxOwned(patrick.id, mailbox.id);
      expect(stored.encryptedSecrets).not.toContain("imap-super-secret");
      expect(stored.encryptedSecrets).not.toContain("smtp-super-secret");
      expect(service.requireRuntime(patrick.id, mailbox.id).imapPassword).toBe("imap-super-secret");
      expect(() => service.get(other.id, mailbox.id)).toThrow(/could not be found|not available/i);
      expect(() => service.requireRuntime(other.id, mailbox.id)).toThrow(/could not be found|not available/i);
      expect(() => store.saveDraft(sampleDraft({
        ownerId: other.id,
        mailboxId: mailbox.id,
        sourceRef: { mailboxId: mailbox.id, folder: "INBOX", uid: 42 },
      }))).toThrow(/owner mismatch/i);
    } finally {
      store.close();
    }
  });
});
