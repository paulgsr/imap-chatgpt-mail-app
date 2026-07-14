import type { AddressObject, ParsedMail } from "mailparser";
import type { MessageAddressObject, MessageStructureObject } from "imapflow";
import type { MailAddress } from "../domain.js";
import { compactWhitespace, truncate } from "../util/values.js";

export function fromParsedAddresses(
  value: AddressObject | AddressObject[] | undefined,
): MailAddress[] {
  const objects = value ? (Array.isArray(value) ? value : [value]) : [];
  const addresses: MailAddress[] = [];
  for (const object of objects) {
    for (const entry of object.value) {
      if (!entry.address) continue;
      addresses.push(entry.name
        ? { name: entry.name, address: entry.address.toLowerCase() }
        : { address: entry.address.toLowerCase() });
    }
  }
  return addresses;
}

export function fromEnvelopeAddresses(value: MessageAddressObject[] | undefined): MailAddress[] {
  return (value ?? [])
    .filter((entry): entry is MessageAddressObject & { address: string } => Boolean(entry.address))
    .map((entry) => entry.name
      ? { name: entry.name, address: entry.address.toLowerCase() }
      : { address: entry.address.toLowerCase() });
}

export function bodyTextFromParsed(parsed: ParsedMail): string {
  if (parsed.text?.trim()) {
    return parsed.text.trim();
  }
  if (typeof parsed.html === "string") {
    return htmlToPlainText(parsed.html);
  }
  return "";
}

export function previewFromParsed(parsed: ParsedMail, maxLength = 320): string {
  const compact = compactWhitespace(bodyTextFromParsed(parsed));
  return truncate(compact, maxLength).value;
}

export function normalizeReferences(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((entry) => entry.trim()).filter(Boolean);
}

export function hasAttachments(structure: MessageStructureObject | undefined): boolean {
  if (!structure) return false;
  if (structure.disposition?.toLowerCase() === "attachment") return true;
  if (structure.dispositionParameters?.filename) return true;
  return (structure.childNodes ?? []).some(hasAttachments);
}

export function formatAddresses(addresses: MailAddress[]): string {
  return addresses
    .map((entry) => entry.name ? `${entry.name} <${entry.address}>` : entry.address)
    .join(", ");
}

function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return safeCodePoint(entity, Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return safeCodePoint(entity, Number.parseInt(entity.slice(1), 10));
    }
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}


function safeCodePoint(entity: string, value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return `&${entity};`;
  }
  return String.fromCodePoint(value);
}
