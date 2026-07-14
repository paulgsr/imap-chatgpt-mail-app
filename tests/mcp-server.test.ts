import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMailMcpServer } from "../src/mcp/mail-mcp-server.js";
import { FakeDraftService, FakeUserMailService, testConfig, testLogger } from "./helpers.js";

const closeCallbacks: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(closeCallbacks.splice(0).map((callback) => callback())); });

async function connectedClient() {
  const config = testConfig();
  const server = createMailMcpServer({
    config,
    logger: testLogger(),
    mailService: new FakeUserMailService(),
    draftService: new FakeDraftService(),
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const authInfo: AuthInfo = {
    token: "test-token",
    clientId: "test-client",
    scopes: ["mail.read", "mail.draft", "mail.send"],
    resource: new URL(config.publicBaseUrl),
    extra: { sub: "user-1", appUserId: "user-1" },
  };
  const originalSend = clientTransport.send.bind(clientTransport);
  (clientTransport as unknown as { send: typeof clientTransport.send }).send = async (message, options) => {
    await (originalSend as unknown as (message: unknown, options: Record<string, unknown>) => Promise<void>)(
      message,
      { ...(options ?? {}), authInfo },
    );
  };
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("multi-mailbox MCP tools", () => {
  it("labels search results with the receiving mailbox", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "search_emails", arguments: { folder: "INBOX", limit: 10 } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      messages: [{
        mailbox_address: "support@example.test",
        mailbox_label: "Support",
        received_by: "support@example.test",
      }],
      mailbox_errors: [],
    });
  });

  it("keeps the raw approval token outside model-visible content", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "prepare_send_draft",
      arguments: { draft_id: "22222222-2222-4222-8222-222222222222" },
    });
    expect(JSON.stringify(result.content)).not.toContain("private-approval-token");
    expect(JSON.stringify(result.structuredContent)).not.toContain("private-approval-token");
    expect(result._meta?.approvalToken).toContain("private-approval-token");
    expect(result.structuredContent).toMatchObject({ mailbox_address: "support@example.test", mailbox_label: "Support" });
  });
});
