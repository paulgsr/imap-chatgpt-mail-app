import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import type { MessageRef } from "../domain.js";

interface EncodedPayload {
  m: string;
  f: string;
  u: number;
}

export class MessageIdCodec {
  constructor(private readonly secret: string) {}

  encode(ref: MessageRef): string {
    const payload = Buffer.from(JSON.stringify({ m: ref.mailboxId, f: ref.folder, u: ref.uid } satisfies EncodedPayload))
      .toString("base64url");
    const signature = this.sign(payload);
    return `m2.${payload}.${signature}`;
  }

  decode(value: string): MessageRef {
    const [version, payload, signature] = value.split(".");
    if (version !== "m2" || !payload || !signature) {
      throw new AppError("INVALID_MESSAGE_ID", "The message reference is invalid.");
    }

    const expected = Buffer.from(this.sign(payload), "base64url");
    const supplied = Buffer.from(signature, "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new AppError("INVALID_MESSAGE_ID", "The message reference is invalid.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new AppError("INVALID_MESSAGE_ID", "The message reference is invalid.");
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("m" in parsed) ||
      !("f" in parsed) ||
      !("u" in parsed) ||
      typeof parsed.m !== "string" ||
      !parsed.m ||
      typeof parsed.f !== "string" ||
      typeof parsed.u !== "number" ||
      !Number.isInteger(parsed.u) ||
      parsed.u < 1
    ) {
      throw new AppError("INVALID_MESSAGE_ID", "The message reference is invalid.");
    }

    return { mailboxId: parsed.m, folder: parsed.f, uid: parsed.u };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest().subarray(0, 18).toString("base64url");
  }
}
