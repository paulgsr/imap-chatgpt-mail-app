import { createHash } from "node:crypto";
import type { MailAddress } from "../domain.js";

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function dedupeAddresses(addresses: MailAddress[]): MailAddress[] {
  const seen = new Set<string>();
  const result: MailAddress[] = [];

  for (const item of addresses) {
    const normalized = normalizeEmail(item.address);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const trimmed = item.address.trim();
    result.push(item.name ? { name: item.name, address: trimmed } : { address: trimmed });
  }

  return result;
}

export function recipientDomains(addresses: MailAddress[]): string[] {
  return [...new Set(
    addresses
      .map((entry) => normalizeEmail(entry.address).split("@")[1])
      .filter((domain): domain is string => Boolean(domain)),
  )].sort();
}

export function cleanHeaderValue(value: string, fallback = ""): string {
  const cleaned = value.replace(/[\r\n\0]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return cleaned || fallback;
}

export function ensureSubjectPrefix(subject: string, prefix: "Re" | "Fwd"): string {
  const trimmed = cleanHeaderValue(subject, "(no subject)");
  const expression = prefix === "Re" ? /^(re|aw|sv):\s*/i : /^(fwd|fw|wg):\s*/i;
  return expression.test(trimmed) ? trimmed : `${prefix}: ${trimmed}`;
}

export function normalizeThreadSubject(subject: string): string {
  let normalized = subject.trim();
  const prefix = /^(re|aw|sv|fwd|fw|wg):\s*/i;
  while (prefix.test(normalized)) {
    normalized = normalized.replace(prefix, "").trim();
  }
  return normalized.toLowerCase();
}

export function truncate(value: string, maxLength: number): { value: string; truncated: boolean } {
  if (value.length <= maxLength) {
    return { value, truncated: false };
  }
  return { value: `${value.slice(0, Math.max(0, maxLength - 1))}…`, truncated: true };
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function stableDraftPayload(input: {
  id: string;
  mailboxId: string;
  mailboxAddress: string;
  revision: number;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyText: string;
  includeSourceAttachments: boolean;
}): string {
  return JSON.stringify({
    id: input.id,
    mailboxId: input.mailboxId,
    mailboxAddress: input.mailboxAddress,
    revision: input.revision,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    bodyText: input.bodyText,
    includeSourceAttachments: input.includeSourceAttachments,
  });
}
