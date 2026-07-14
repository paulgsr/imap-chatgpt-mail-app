import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PersonalTokenVerifier } from "../src/auth/personal-token-verifier.js";
import { createPersonalAccessToken } from "../src/security/tokens.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { testConfig } from "./helpers.js";

describe("per-user MCP tokens", () => {
  it("resolves the token to exactly its owning app user", async () => {
    const store = new SqliteStore(":memory:");
    store.initialize();
    try {
      const first = store.createUser({ email: "first@example.test", name: "First", passwordHash: "unused", role: "user" });
      const second = store.createUser({ email: "second@example.test", name: "Second", passwordHash: "unused", role: "user" });
      const created = createPersonalAccessToken();
      store.createApiToken({
        id: randomUUID(),
        userId: second.id,
        name: "Second user token",
        tokenHash: created.hash,
        scopes: ["mail.read"],
        createdAt: new Date().toISOString(),
      });
      const verifier = new PersonalTokenVerifier(testConfig({ auth: { mode: "token", scopes: ["mail.read"], autoLinkEmail: true } }), store);
      const auth = await verifier.verifyAccessToken(created.token);
      expect(auth.extra?.appUserId).toBe(second.id);
      expect(auth.extra?.appUserId).not.toBe(first.id);
      expect(auth.scopes).toEqual(["mail.read"]);
    } finally {
      store.close();
    }
  });
});
