import type { Request, RequestHandler, Response } from "express";
import type { AppConfig } from "../config.js";
import type { SessionRecord, UserRecord } from "../domain.js";
import { randomToken, tokenHash } from "../security/tokens.js";
import type { SqliteStore } from "../storage/sqlite-store.js";

export interface CreatedWebSession {
  rawToken: string;
  session: SessionRecord;
}

export class WebSessionAuth {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SqliteStore,
  ) {}

  middleware(): RequestHandler {
    return (request, _response, next) => {
      const rawToken = parseCookies(request.headers.cookie)[this.config.session.cookieName];
      if (!rawToken) {
        next();
        return;
      }
      const session = this.store.getSession(tokenHash(rawToken));
      if (!session) {
        next();
        return;
      }
      const user = this.store.getUserById(session.userId);
      if (!user || user.disabled) {
        next();
        return;
      }
      request.webSession = session;
      request.webUser = user;
      this.store.touchSession(session.tokenHash);
      next();
    };
  }

  create(user: UserRecord): CreatedWebSession {
    const rawToken = randomToken(36);
    const now = new Date();
    const session: SessionRecord = {
      tokenHash: tokenHash(rawToken),
      userId: user.id,
      csrfToken: randomToken(24),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.session.ttlDays * 86_400_000).toISOString(),
      lastSeenAt: now.toISOString(),
    };
    this.store.createSession(session);
    return { rawToken, session };
  }

  setCookie(response: Response, rawToken: string): void {
    response.cookie(this.config.session.cookieName, rawToken, {
      httpOnly: true,
      secure: this.config.session.secure,
      sameSite: "lax",
      path: "/",
      maxAge: this.config.session.ttlDays * 86_400_000,
    });
  }

  clear(request: Request, response: Response): void {
    const rawToken = parseCookies(request.headers.cookie)[this.config.session.cookieName];
    if (rawToken) this.store.deleteSession(tokenHash(rawToken));
    response.clearCookie(this.config.session.cookieName, {
      httpOnly: true,
      secure: this.config.session.secure,
      sameSite: "lax",
      path: "/",
    });
  }

  requireUser(): RequestHandler {
    return (request, response, next) => {
      if (!request.webUser || !request.webSession) {
        response.redirect(`/login?next=${encodeURIComponent(request.originalUrl)}`);
        return;
      }
      next();
    };
  }

  requireAdmin(): RequestHandler {
    return (request, response, next) => {
      if (!request.webUser || !request.webSession) {
        response.redirect(`/login?next=${encodeURIComponent(request.originalUrl)}`);
        return;
      }
      if (request.webUser.role !== "admin") {
        response.status(403).send("Administrator access is required.");
        return;
      }
      next();
    };
  }

  requireCsrf(): RequestHandler {
    return (request, response, next) => {
      if (!request.webSession) {
        response.status(401).send("Sign in first.");
        return;
      }
      const supplied = typeof request.body?._csrf === "string"
        ? request.body._csrf
        : typeof request.headers["x-csrf-token"] === "string"
          ? request.headers["x-csrf-token"]
          : "";
      if (!supplied || supplied !== request.webSession.csrfToken) {
        response.status(403).send("The form expired or the CSRF token is invalid. Reload the page and try again.");
        return;
      }
      next();
    };
  }
}

function parseCookies(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of value?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}
