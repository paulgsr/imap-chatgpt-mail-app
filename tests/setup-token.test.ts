import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../src/http/app.js";
import { CredentialCipher } from "../src/security/credential-cipher.js";
import { MessageIdCodec } from "../src/security/message-id-codec.js";
import { MailboxService } from "../src/services/mailbox-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { WebSessionAuth } from "../src/web/session-auth.js";
import { FakeDraftService, FakeUserMailService, testConfig, testLogger } from "./helpers.js";

describe("first-run setup protection", () => {
  it("requires the configured setup token", async () => {
    const config = testConfig({ setupToken: "a-server-side-setup-secret" });
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
      expect((await request(app).get("/setup")).text).toContain("Setup token");
      const rejected = await request(app).post("/setup").type("form").send({
        name: "Patrick",
        email: "patrick@example.test",
        password: "a-strong-test-password",
        setup_token: "wrong-token-value",
      });
      expect(rejected.status).toBe(403);
      expect(store.countUsers()).toBe(0);

      const accepted = await request(app).post("/setup").type("form").send({
        name: "Patrick",
        email: "patrick@example.test",
        password: "a-strong-test-password",
        setup_token: "a-server-side-setup-secret",
      });
      expect(accepted.status).toBe(303);
      expect(store.countUsers()).toBe(1);
    } finally {
      store.close();
    }
  });
});
