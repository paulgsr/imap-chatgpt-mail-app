import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { SqliteStore } from "../storage/sqlite-store.js";

export class JwtAccessTokenVerifier implements OAuthTokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly config: AppConfig,
    private readonly store: SqliteStore,
  ) {
    const { issuerUrl, jwksUrl, audience } = config.auth;
    if (!issuerUrl || !jwksUrl || !audience) {
      throw new Error("OAuth verifier requires issuerUrl, jwksUrl, and audience.");
    }
    this.issuer = issuerUrl;
    this.audience = audience;
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.audience,
    });

    const scopes = extractScopes(payload);
    const clientId = stringClaim(payload, "azp") ?? stringClaim(payload, "client_id") ?? "chatgpt";
    const subject = payload.sub;
    if (!subject) {
      throw new AppError("INVALID_TOKEN_SUBJECT", "The access token does not contain a subject.", 401);
    }
    const email = stringClaim(payload, "email")?.toLowerCase();
    const emailVerified = payload.email_verified === true;
    let user = this.store.findUserByOAuthSubject(subject);
    if (!user && email && emailVerified && this.config.auth.autoLinkEmail) {
      const candidate = this.store.findUserByEmail(email);
      if (candidate && !candidate.disabled && (!candidate.oauthSubject || candidate.oauthSubject === subject)) {
        this.store.linkOAuthSubject(candidate.id, subject);
        user = this.store.getUserById(candidate.id);
      }
    }
    if (!user || user.disabled) {
      throw new AppError(
        "UNLINKED_OAUTH_IDENTITY",
        "This OAuth identity is not linked to an active mail-app user.",
        403,
      );
    }

    const extra: Record<string, unknown> = {
      sub: subject,
      appUserId: user.id,
      appUserEmail: user.email,
    };
    const name = stringClaim(payload, "name");
    if (email) extra.email = email;
    extra.emailVerified = emailVerified;
    if (name) extra.name = name;

    return {
      token,
      clientId,
      scopes,
      ...(typeof payload.exp === "number" ? { expiresAt: payload.exp } : {}),
      resource: new URL(this.config.publicBaseUrl),
      extra,
    };
  }
}

function extractScopes(payload: JWTPayload): string[] {
  const values: string[] = [];
  for (const key of ["scope", "scp"] as const) {
    const claim = payload[key];
    if (typeof claim === "string") {
      values.push(...claim.split(/[\s,]+/));
    } else if (Array.isArray(claim)) {
      values.push(...claim.filter((entry): entry is string => typeof entry === "string"));
    }
  }

  const permissions = payload.permissions;
  if (Array.isArray(permissions)) {
    values.push(...permissions.filter((entry): entry is string => typeof entry === "string"));
  }

  return [...new Set(values.filter(Boolean))];
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}
