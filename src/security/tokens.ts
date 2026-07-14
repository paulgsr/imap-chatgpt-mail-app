import { createHash, randomBytes } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createPersonalAccessToken(): { token: string; hash: string } {
  const token = `mcp_pat_${randomToken(36)}`;
  return { token, hash: tokenHash(token) };
}
