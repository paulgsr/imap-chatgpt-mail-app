import "dotenv/config";
import { z } from "zod";

const booleanValue = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}, z.boolean());

const optionalBooleanValue = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}, z.boolean().optional());

const integerValue = (defaultValue: number, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? defaultValue : Number(value)),
    z.number().int().min(min).max(max),
  );

const optionalUrl = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: integerValue(3000, 1, 65_535),
  BIND_HOST: z.string().default("127.0.0.1"),
  PUBLIC_BASE_URL: z.url().default("http://localhost:3000"),
  ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1"),
  TRUST_PROXY: booleanValue.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATA_DIR: z.string().default("./data"),
  DATABASE_PATH: z.string().optional(),
  SETUP_TOKEN: z.string().min(16).optional(),

  AUTH_MODE: z.enum(["none", "token", "oauth"]).default("token"),
  OAUTH_ISSUER_URL: optionalUrl,
  OAUTH_JWKS_URL: optionalUrl,
  OAUTH_AUDIENCE: z.string().optional(),
  OAUTH_SCOPES: z.string().default("mail.read,mail.draft,mail.send"),
  OAUTH_AUTO_LINK_EMAIL: booleanValue.default(true),

  ID_SIGNING_SECRET: z.string().min(32),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(1),

  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("mailapp_session"),
  SESSION_TTL_DAYS: integerValue(30, 1, 90),
  COOKIE_SECURE: optionalBooleanValue,

  ALLOW_SEND: booleanValue.default(false),

  MAX_MAILBOXES_PER_USER: integerValue(20, 1, 100),
  MAX_PARALLEL_MAILBOX_SEARCHES: integerValue(4, 1, 20),
  MAX_SEARCH_RESULTS: integerValue(50, 1, 100),
  MAX_PREVIEW_SOURCE_BYTES: integerValue(65_536, 4_096, 1_048_576),
  MAX_MESSAGE_BYTES: integerValue(10_485_760, 65_536, 104_857_600),
  MAX_BODY_CHARS: integerValue(50_000, 1_000, 500_000),
  MAX_FORWARD_ATTACHMENT_BYTES: integerValue(20_971_520, 1_024, 104_857_600),
  MAX_RECIPIENTS: integerValue(20, 1, 100),
  SEND_APPROVAL_TTL_SECONDS: integerValue(600, 60, 3_600),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  bindHost: string;
  publicBaseUrl: string;
  allowedHosts: string[];
  trustProxy: boolean;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  dataDir: string;
  databasePath: string;
  setupToken?: string;
  auth: {
    mode: "none" | "token" | "oauth";
    issuerUrl?: string;
    jwksUrl?: string;
    audience?: string;
    scopes: string[];
    autoLinkEmail: boolean;
  };
  idSigningSecret: string;
  credentialEncryptionKey: Buffer;
  session: {
    cookieName: string;
    ttlDays: number;
    secure: boolean;
  };
  allowSend: boolean;
  limits: {
    maxMailboxesPerUser: number;
    maxParallelMailboxSearches: number;
    maxSearchResults: number;
    maxPreviewSourceBytes: number;
    maxMessageBytes: number;
    maxBodyChars: number;
    maxForwardAttachmentBytes: number;
    maxRecipients: number;
    sendApprovalTtlSeconds: number;
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(environment);
  const encryptionKey = decodeEncryptionKey(parsed.CREDENTIAL_ENCRYPTION_KEY);

  if (parsed.AUTH_MODE === "oauth") {
    if (!parsed.OAUTH_ISSUER_URL || !parsed.OAUTH_JWKS_URL || !parsed.OAUTH_AUDIENCE) {
      throw new Error("OAUTH_ISSUER_URL, OAUTH_JWKS_URL, and OAUTH_AUDIENCE are required for OAuth mode.");
    }
  }

  if (parsed.NODE_ENV === "production" && parsed.AUTH_MODE === "none") {
    throw new Error("AUTH_MODE=none is not allowed in production.");
  }
  if (parsed.NODE_ENV === "production" && !parsed.SETUP_TOKEN) {
    throw new Error("SETUP_TOKEN is required in production so the first administrator cannot be claimed by an unauthorised visitor.");
  }

  const publicBaseUrl = parsed.PUBLIC_BASE_URL.replace(/\/$/, "");
  const auth = {
    mode: parsed.AUTH_MODE,
    scopes: parsed.OAUTH_SCOPES.split(",").map((entry) => entry.trim()).filter(Boolean),
    autoLinkEmail: parsed.OAUTH_AUTO_LINK_EMAIL,
    ...(parsed.OAUTH_ISSUER_URL ? { issuerUrl: parsed.OAUTH_ISSUER_URL } : {}),
    ...(parsed.OAUTH_JWKS_URL ? { jwksUrl: parsed.OAUTH_JWKS_URL } : {}),
    ...(parsed.OAUTH_AUDIENCE ? { audience: parsed.OAUTH_AUDIENCE } : {}),
  } satisfies AppConfig["auth"];

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    bindHost: parsed.BIND_HOST,
    publicBaseUrl,
    allowedHosts: parsed.ALLOWED_HOSTS.split(",").map((entry) => entry.trim()).filter(Boolean),
    trustProxy: parsed.TRUST_PROXY,
    logLevel: parsed.LOG_LEVEL,
    dataDir: parsed.DATA_DIR,
    databasePath: parsed.DATABASE_PATH ?? `${parsed.DATA_DIR.replace(/\/$/, "")}/mailapp.sqlite`,
    ...(parsed.SETUP_TOKEN ? { setupToken: parsed.SETUP_TOKEN } : {}),
    auth,
    idSigningSecret: parsed.ID_SIGNING_SECRET,
    credentialEncryptionKey: encryptionKey,
    session: {
      cookieName: parsed.SESSION_COOKIE_NAME,
      ttlDays: parsed.SESSION_TTL_DAYS,
      secure: parsed.COOKIE_SECURE ?? publicBaseUrl.startsWith("https://"),
    },
    allowSend: parsed.ALLOW_SEND,
    limits: {
      maxMailboxesPerUser: parsed.MAX_MAILBOXES_PER_USER,
      maxParallelMailboxSearches: parsed.MAX_PARALLEL_MAILBOX_SEARCHES,
      maxSearchResults: parsed.MAX_SEARCH_RESULTS,
      maxPreviewSourceBytes: parsed.MAX_PREVIEW_SOURCE_BYTES,
      maxMessageBytes: parsed.MAX_MESSAGE_BYTES,
      maxBodyChars: parsed.MAX_BODY_CHARS,
      maxForwardAttachmentBytes: parsed.MAX_FORWARD_ATTACHMENT_BYTES,
      maxRecipients: parsed.MAX_RECIPIENTS,
      sendApprovalTtlSeconds: parsed.SEND_APPROVAL_TTL_SECONDS,
    },
  };
}

function decodeEncryptionKey(value: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(value, "base64");
  } catch {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes. Generate it with: openssl rand -base64 32");
  }
  return key;
}
