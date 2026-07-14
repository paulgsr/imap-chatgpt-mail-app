import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../src/http/app.js";
import { CredentialCipher } from "../src/security/credential-cipher.js";
import { MessageIdCodec } from "../src/security/message-id-codec.js";
import { hashPassword } from "../src/security/passwords.js";
import { MailboxService } from "../src/services/mailbox-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { WebSessionAuth } from "../src/web/session-auth.js";
import { FakeDraftService, FakeUserMailService, testConfig, testLogger } from "./helpers.js";

describe("web control centre", () => {
  it("creates the first admin, keeps a session, and adds an encrypted mailbox", async () => {
    const config = testConfig();
    const store = new SqliteStore(":memory:");
    store.initialize();
    try {
      const logger = testLogger();
      const mailboxService = new MailboxService(
        config,
        store,
        new CredentialCipher(config.credentialEncryptionKey),
        new MessageIdCodec(config.idSigningSecret),
        logger,
      );
      const app = createHttpApp({
        config,
        logger,
        store,
        mailboxService,
        sessions: new WebSessionAuth(config, store),
        mailService: new FakeUserMailService(),
        draftService: new FakeDraftService(),
      });
      const agent = request.agent(app);
      expect((await agent.get("/")).headers.location).toBe("/setup");
      const setup = await agent.post("/setup").type("form").send({
        name: "Patrick",
        email: "patrick@example.test",
        password: "a-strong-test-password",
      });
      expect(setup.status).toBe(303);
      const dashboard = await agent.get("/app");
      expect(dashboard.status).toBe(200);
      expect(dashboard.text).toContain("Your private workspace");
      const csrf = dashboard.text.match(/name="_csrf" value="([^"]+)"/)?.[1];
      expect(csrf).toBeTruthy();

      const created = await agent.post("/app/mailboxes").type("form").send({
        _csrf: csrf,
        email_address: "support@example.test",
        display_name: "Support",
        imap_host: "imap.example.test",
        imap_port: "993",
        imap_secure: "1",
        imap_reject_unauthorized: "1",
        imap_username: "support@example.test",
        imap_password: "imap-secret",
        smtp_host: "smtp.example.test",
        smtp_port: "465",
        smtp_secure: "1",
        smtp_reject_unauthorized: "1",
        smtp_username: "support@example.test",
        smtp_password: "smtp-secret",
        read_enabled: "1",
        save_sent_copy: "1",
      });
      expect(created.status).toBe(303);
      const user = store.findUserByEmail("patrick@example.test")!;
      const stored = store.listMailboxes(user.id)[0]!;
      expect(stored.emailAddress).toBe("support@example.test");
      expect(stored.encryptedSecrets).not.toContain("imap-secret");

      const second = store.createUser({
        email: "other@example.test",
        name: "Other User",
        passwordHash: await hashPassword("another-strong-password"),
        role: "user",
      });
      const secondAgent = request.agent(app);
      expect((await secondAgent.post("/login").type("form").send({
        email: second.email,
        password: "another-strong-password",
      })).status).toBe(303);
      const secondDashboard = await secondAgent.get("/app");
      expect(secondDashboard.status).toBe(200);
      expect(secondDashboard.text).not.toContain("support@example.test");
      const denied = await secondAgent.get(`/app/mailboxes/${stored.id}/edit`);
      expect(denied.status).toBe(303);
      expect(store.listMailboxes(second.id)).toHaveLength(0);
      expect(store.listMailboxes(user.id)).toHaveLength(1);

      const docs = await request(app).get("/docs");
      expect(docs.status).toBe(200);
      expect(docs.text).toContain("/mcp");
    } finally {
      store.close();
    }
  });
});
