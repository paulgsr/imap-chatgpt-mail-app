import { describe, expect, it } from "vitest";
import { MessageIdCodec } from "../src/security/message-id-codec.js";

describe("MessageIdCodec", () => {
  it("round-trips a mailbox, folder, and UID without exposing them", () => {
    const codec = new MessageIdCodec("a-secure-test-secret-with-more-than-32-characters");
    const ref = { mailboxId: "mailbox-secret-id", folder: "Customer Support/2026", uid: 9321 };
    const encoded = codec.encode(ref);
    expect(encoded).not.toContain("mailbox-secret-id");
    expect(encoded).not.toContain("Customer Support");
    expect(codec.decode(encoded)).toEqual(ref);
  });

  it("rejects a tampered reference", () => {
    const codec = new MessageIdCodec("a-secure-test-secret-with-more-than-32-characters");
    const encoded = codec.encode({ mailboxId: "mbx", folder: "INBOX", uid: 7 });
    const tampered = `${encoded.slice(0, -1)}${encoded.endsWith("a") ? "b" : "a"}`;
    expect(() => codec.decode(tampered)).toThrow(/invalid/i);
  });
});
