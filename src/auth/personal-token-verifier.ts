import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { tokenHash } from "../security/tokens.js";
import type { SqliteStore } from "../storage/sqlite-store.js";

export class PersonalTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SqliteStore,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!token.startsWith("mcp_pat_")) {
      throw new AppError("INVALID_ACCESS_TOKEN", "The personal access token is invalid.", 401);
    }
    const record = this.store.findApiTokenByHash(tokenHash(token));
    if (!record) {
      throw new AppError("INVALID_ACCESS_TOKEN", "The personal access token is invalid or expired.", 401);
    }
    const user = this.store.getUserById(record.userId);
    if (!user || user.disabled) {
      throw new AppError("USER_DISABLED", "The user account is disabled.", 403);
    }
    this.store.touchApiToken(record.id);
    return {
      token,
      clientId: `personal-token:${record.id}`,
      scopes: record.scopes,
      ...(record.expiresAt ? { expiresAt: Math.floor(new Date(record.expiresAt).getTime() / 1_000) } : {}),
      resource: new URL(this.config.publicBaseUrl),
      extra: {
        sub: user.id,
        appUserId: user.id,
        appUserEmail: user.email,
        tokenId: record.id,
      },
    };
  }
}
