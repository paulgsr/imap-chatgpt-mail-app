import type { RequestHandler } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { JwtAccessTokenVerifier } from "./jwt-verifier.js";
import { PersonalTokenVerifier } from "./personal-token-verifier.js";

export function createMcpAuthMiddleware(config: AppConfig, store: SqliteStore): RequestHandler {
  if (config.auth.mode === "none") {
    return (request, response, next) => {
      const activeUsers = store.listUsers().filter((entry) => !entry.disabled);
      if (activeUsers.length !== 1) {
        response.status(503).json({
          error: activeUsers.length === 0
            ? "Create the first administrator account in the web interface before using MCP."
            : "AUTH_MODE=none is only safe with exactly one active user. Switch to AUTH_MODE=token or OAuth.",
        });
        return;
      }
      const user = activeUsers[0]!;
      request.auth = {
        token: "local-development",
        clientId: "local-development",
        scopes: ["mail.read", "mail.draft", "mail.send"],
        resource: new URL(config.publicBaseUrl),
        extra: { sub: user.id, appUserId: user.id, appUserEmail: user.email },
      };
      next();
    };
  }

  const verifier = config.auth.mode === "oauth"
    ? new JwtAccessTokenVerifier(config, store)
    : new PersonalTokenVerifier(config, store);

  return requireBearerAuth({
    verifier,
    resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
  });
}

export function protectedResourceMetadata(config: AppConfig): Record<string, unknown> {
  if (config.auth.mode !== "oauth" || !config.auth.issuerUrl) {
    return {
      resource: config.publicBaseUrl,
      authorization_servers: [],
      scopes_supported: config.auth.scopes,
      resource_documentation: `${config.publicBaseUrl}/docs`,
    };
  }

  return {
    resource: config.publicBaseUrl,
    authorization_servers: [config.auth.issuerUrl],
    scopes_supported: config.auth.scopes,
    resource_documentation: `${config.publicBaseUrl}/docs`,
  };
}
