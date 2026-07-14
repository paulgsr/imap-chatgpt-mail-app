import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { MailboxSecretPayload } from "../domain.js";
import { AppError } from "../errors.js";

interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class CredentialCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error("CredentialCipher requires a 32-byte key.");
    }
  }

  encrypt(payload: MailboxSecretPayload): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      v: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    return JSON.stringify(envelope);
  }

  decrypt(value: string): MailboxSecretPayload {
    try {
      const envelope = JSON.parse(value) as Partial<EncryptedEnvelope>;
      if (
        envelope.v !== 1 ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      ) {
        throw new Error("Invalid envelope");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const parsed = JSON.parse(plaintext.toString("utf8")) as Partial<MailboxSecretPayload>;
      if (
        typeof parsed.imapUsername !== "string" ||
        typeof parsed.imapPassword !== "string" ||
        typeof parsed.smtpUsername !== "string" ||
        typeof parsed.smtpPassword !== "string"
      ) {
        throw new Error("Invalid credential payload");
      }
      return {
        imapUsername: parsed.imapUsername,
        imapPassword: parsed.imapPassword,
        smtpUsername: parsed.smtpUsername,
        smtpPassword: parsed.smtpPassword,
      };
    } catch {
      throw new AppError(
        "CREDENTIAL_DECRYPTION_FAILED",
        "The mailbox credentials could not be decrypted. Check the server encryption key.",
        500,
      );
    }
  }
}
