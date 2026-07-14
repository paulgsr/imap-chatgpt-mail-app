import pino from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: AppConfig) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "request.headers.authorization",
        "*.password",
        "*.token",
        "*.approvalToken",
        "*.content",
        "*.bodyText",
      ],
      censor: "[REDACTED]",
    },
    base: {
      service: "imap-chatgpt-mail-app",
      version: "0.2.0",
    },
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
