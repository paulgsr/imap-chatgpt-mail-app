import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AppConfig } from "../config.js";
import { AppError, ScopeError } from "../errors.js";

export interface AuthenticatedToolExtra {
  authInfo?: AuthInfo;
}

export function actorId(extra: AuthenticatedToolExtra): string {
  const appUserId = extra.authInfo?.extra?.appUserId;
  if (typeof appUserId === "string" && appUserId) {
    return appUserId;
  }
  throw new AppError("UNAUTHENTICATED_USER", "The MCP request is not linked to an application user.", 401);
}

export function requireScopes(extra: AuthenticatedToolExtra, required: string[]): void {
  const granted = new Set(extra.authInfo?.scopes ?? []);
  const missing = required.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new ScopeError(missing);
  }
}

export function securityMeta(config: AppConfig, scopes: string[]): Record<string, unknown> {
  if (config.auth.mode === "none") {
    return { securitySchemes: [{ type: "noauth" }] };
  }
  if (config.auth.mode === "token") {
    return { securitySchemes: [{ type: "http", scheme: "bearer" }] };
  }
  return { securitySchemes: [{ type: "oauth2", scopes }] };
}

export function authChallenge(config: AppConfig, errorDescription: string): string {
  return [
    `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`,
    "error=\"insufficient_scope\"",
    `error_description="${errorDescription.replaceAll('"', "'")}"`,
  ].join(", ");
}
