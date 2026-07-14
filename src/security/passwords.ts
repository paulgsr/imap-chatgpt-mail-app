import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const N = 32_768;
const R = 8;
const P = 1;

function deriveKey(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", N, R, P, salt.toString("base64url"), derived.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nValue, rValue, pValue, saltValue, hashValue] = encoded.split("$");
  if (!algorithm || algorithm !== "scrypt" || !nValue || !rValue || !pValue || !saltValue || !hashValue) {
    return false;
  }
  const n = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const derived = await deriveKey(password, Buffer.from(saltValue, "base64url"), expected.length, {
      N: n, r, p, maxmem: 64 * 1024 * 1024,
    });
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export function validatePassword(password: string): void {
  if (password.length < 12) throw new Error("Password must contain at least 12 characters.");
  if (password.length > 256) throw new Error("Password is too long.");
}
