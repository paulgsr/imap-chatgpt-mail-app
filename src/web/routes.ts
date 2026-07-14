import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { MailboxRecord, UserRecord } from "../domain.js";
import { AppError, errorMessage } from "../errors.js";
import type { AppLogger } from "../logger.js";
import { hashPassword, verifyPassword } from "../security/passwords.js";
import { createPersonalAccessToken } from "../security/tokens.js";
import type { MailboxService, MailboxSettingsInput } from "../services/mailbox-service.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { WebSessionAuth } from "./session-auth.js";
import {
  dashboardPage,
  docsPage,
  loginPage,
  mailboxFormPage,
  securityPage,
  setupPage,
  usersPage,
  type PageMessage,
} from "./templates.js";

const emailSchema = z.email();

export interface WebRouteDependencies {
  config: AppConfig;
  logger: AppLogger;
  store: SqliteStore;
  mailboxService: MailboxService;
  sessions: WebSessionAuth;
}

export function createWebRouter(dependencies: WebRouteDependencies): Router {
  const { config, logger, store, mailboxService, sessions } = dependencies;
  const router = Router();
  const loginAttempts = new LoginAttemptLimiter();
  router.use(express.urlencoded({ extended: false, limit: "128kb" }));
  router.use(sessions.middleware());

  router.get("/docs", (_request, response) => {
    response.type("html").send(docsPage({
      publicBaseUrl: config.publicBaseUrl,
      authMode: config.auth.mode,
      setupProtected: Boolean(config.setupToken),
    }));
  });

  router.get("/", (request, response) => {
    if (store.countUsers() === 0) return response.redirect(303, "/setup");
    return response.redirect(303, request.webUser ? "/app" : "/login");
  });

  router.get("/setup", (_request, response) => {
    if (store.countUsers() > 0) return response.redirect(303, "/login");
    return response.type("html").send(setupPage({}, Boolean(config.setupToken)));
  });

  router.post("/setup", asyncHandler(async (request, response) => {
    if (store.countUsers() > 0) return response.redirect(303, "/login");
    try {
      if (config.setupToken && !secureEqual(bodyString(request, "setup_token"), config.setupToken)) {
        throw new AppError("INVALID_SETUP_TOKEN", "The setup token is incorrect.", 403);
      }
      const email = normalizedEmail(bodyString(request, "email"));
      const name = required(bodyString(request, "name"), "Name");
      const passwordHash = await hashPassword(bodyString(request, "password"));
      const user = store.createUser({ email, name, passwordHash, role: "admin" });
      store.addAudit(SqliteStore.audit({ actorId: user.id, action: "create_initial_admin", status: "success" }));
      const created = sessions.create(user);
      sessions.setCookie(response, created.rawToken);
      return response.redirect(303, `/app?notice=${encodeURIComponent("Administrator account created.")}`);
    } catch (error) {
      logger.warn({ error: errorMessage(error) }, "Initial administrator setup failed");
      return response.status(statusCode(error)).type("html").send(setupPage({ error: exposedMessage(error) }, Boolean(config.setupToken)));
    }
  }));

  router.get("/login", (request, response) => {
    if (store.countUsers() === 0) return response.redirect(303, "/setup");
    if (request.webUser) return response.redirect(303, "/app");
    return response.type("html").send(loginPage(messageFromQuery(request)));
  });

  router.post("/login", asyncHandler(async (request, response) => {
    const email = bodyString(request, "email").trim().toLowerCase();
    const attemptKey = `${request.ip ?? "unknown"}|${email}`;
    if (loginAttempts.isBlocked(attemptKey)) {
      return response.status(429).type("html").send(loginPage({ error: "Too many sign-in attempts. Try again later." }));
    }
    const candidate = store.getUserWithPasswordByEmail(email);
    const password = bodyString(request, "password");
    if (!candidate || candidate.disabled || !(await verifyPassword(password, candidate.passwordHash))) {
      loginAttempts.recordFailure(attemptKey);
      return response.status(401).type("html").send(loginPage({ error: "The email address or password is incorrect." }));
    }
    loginAttempts.clear(attemptKey);
    const created = sessions.create(candidate);
    sessions.setCookie(response, created.rawToken);
    store.addAudit(SqliteStore.audit({ actorId: candidate.id, action: "dashboard_login", status: "success" }));
    return response.redirect(303, "/app");
  }));

  router.post("/logout", sessions.requireUser(), sessions.requireCsrf(), (request, response) => {
    const user = request.webUser!;
    store.addAudit(SqliteStore.audit({ actorId: user.id, action: "dashboard_logout", status: "success" }));
    sessions.clear(request, response);
    response.redirect(303, `/login?notice=${encodeURIComponent("You have been signed out.")}`);
  });

  router.get("/app", sessions.requireUser(), (request, response) => {
    const user = request.webUser!;
    response.type("html").send(dashboardPage({
      user,
      csrfToken: request.webSession!.csrfToken,
      mailboxes: mailboxService.list(user.id),
      drafts: store.listDrafts(user.id, 20),
      audit: store.listAudit(user.id, 50),
      sendGloballyEnabled: config.allowSend,
      authMode: config.auth.mode,
      message: messageFromQuery(request),
    }));
  });

  router.get("/app/mailboxes/new", sessions.requireUser(), (request, response) => {
    response.type("html").send(mailboxFormPage({
      user: request.webUser!,
      csrfToken: request.webSession!.csrfToken,
      message: messageFromQuery(request),
    }));
  });

  router.post("/app/mailboxes", sessions.requireUser(), sessions.requireCsrf(), (request, response) => {
    const user = request.webUser!;
    try {
      const mailbox = mailboxService.create(user.id, mailboxInput(request, undefined));
      response.redirect(303, `/app?notice=${encodeURIComponent(`${mailbox.emailAddress} was added. Test both connections before using it.`)}`);
    } catch (error) {
      logger.warn({ error: errorMessage(error), userId: user.id }, "Mailbox creation failed");
      response.status(statusCode(error)).type("html").send(mailboxFormPage({
        user,
        csrfToken: request.webSession!.csrfToken,
        message: { error: exposedMessage(error) },
      }));
    }
  });

  router.get("/app/mailboxes/:mailboxId/edit", sessions.requireUser(), (request, response) => {
    const user = request.webUser!;
    try {
      const mailbox = mailboxService.get(user.id, paramString(request, "mailboxId"));
      response.type("html").send(mailboxFormPage({
        user,
        csrfToken: request.webSession!.csrfToken,
        mailbox,
        message: messageFromQuery(request),
      }));
    } catch (error) {
      response.redirect(303, `/app?error=${encodeURIComponent(exposedMessage(error))}`);
    }
  });

  router.post("/app/mailboxes/:mailboxId", sessions.requireUser(), sessions.requireCsrf(), (request, response) => {
    const user = request.webUser!;
    const mailboxId = paramString(request, "mailboxId");
    let existing: MailboxRecord | undefined;
    try {
      existing = mailboxService.get(user.id, mailboxId);
      const runtime = mailboxService.requireRuntime(user.id, mailboxId, "manage");
      const mailbox = mailboxService.update(user.id, mailboxId, mailboxInput(request, {
        imapUsername: runtime.imapUsername,
        smtpUsername: runtime.smtpUsername,
      }));
      response.redirect(303, `/app?notice=${encodeURIComponent(`${mailbox.emailAddress} was updated. Run the connection test again.`)}`);
    } catch (error) {
      logger.warn({ error: errorMessage(error), userId: user.id, mailboxId }, "Mailbox update failed");
      response.status(statusCode(error)).type("html").send(mailboxFormPage({
        user,
        csrfToken: request.webSession!.csrfToken,
        ...(existing ? { mailbox: existing } : {}),
        message: { error: exposedMessage(error) },
      }));
    }
  });

  router.post("/app/mailboxes/:mailboxId/test", sessions.requireUser(), sessions.requireCsrf(), asyncHandler(async (request, response) => {
    const user = request.webUser!;
    const mailboxId = paramString(request, "mailboxId");
    try {
      await mailboxService.testConnections(user.id, mailboxId);
      response.redirect(303, `/app?notice=${encodeURIComponent("IMAP and SMTP connections succeeded.")}`);
    } catch (error) {
      logger.warn({ error: errorMessage(error), userId: user.id, mailboxId }, "Mailbox connection test failed");
      response.redirect(303, `/app?error=${encodeURIComponent(exposedMessage(error))}`);
    }
  }));

  router.post("/app/mailboxes/:mailboxId/delete", sessions.requireUser(), sessions.requireCsrf(), (request, response) => {
    try {
      mailboxService.delete(request.webUser!.id, paramString(request, "mailboxId"));
      response.redirect(303, `/app?notice=${encodeURIComponent("Mailbox removed.")}`);
    } catch (error) {
      response.redirect(303, `/app?error=${encodeURIComponent(exposedMessage(error))}`);
    }
  });

  router.get("/app/users", sessions.requireAdmin(), (request, response) => {
    response.type("html").send(usersPage({
      user: request.webUser!,
      csrfToken: request.webSession!.csrfToken,
      users: store.listUsers(),
      message: messageFromQuery(request),
    }));
  });

  router.post("/app/users", sessions.requireAdmin(), sessions.requireCsrf(), asyncHandler(async (request, response) => {
    const actor = request.webUser!;
    try {
      const role = bodyString(request, "role") === "admin" ? "admin" : "user";
      const created = store.createUser({
        name: required(bodyString(request, "name"), "Name"),
        email: normalizedEmail(bodyString(request, "email")),
        passwordHash: await hashPassword(bodyString(request, "password")),
        role,
      });
      store.addAudit(SqliteStore.audit({ actorId: actor.id, action: "create_user", status: "success", detail: created.email }));
      response.redirect(303, `/app/users?notice=${encodeURIComponent(`${created.email} can now sign in and add only their own mailboxes.`)}`);
    } catch (error) {
      response.status(statusCode(error)).type("html").send(usersPage({
        user: actor,
        csrfToken: request.webSession!.csrfToken,
        users: store.listUsers(),
        message: { error: exposedMessage(error) },
      }));
    }
  }));

  router.post("/app/users/:userId/toggle", sessions.requireAdmin(), sessions.requireCsrf(), (request, response) => {
    const actor = request.webUser!;
    const targetId = paramString(request, "userId");
    try {
      if (targetId === actor.id) throw new AppError("CANNOT_DISABLE_SELF", "You cannot disable your own account.", 409);
      const target = store.getUserById(targetId);
      if (!target) throw new AppError("USER_NOT_FOUND", "The user could not be found.", 404);
      if (!target.disabled && target.role === "admin") {
        const activeAdmins = store.listUsers().filter((user) => user.role === "admin" && !user.disabled);
        if (activeAdmins.length <= 1) throw new AppError("LAST_ADMIN", "The final active administrator cannot be disabled.", 409);
      }
      store.setUserDisabled(targetId, !target.disabled);
      store.addAudit(SqliteStore.audit({ actorId: actor.id, action: target.disabled ? "enable_user" : "disable_user", status: "success", detail: target.email }));
      response.redirect(303, `/app/users?notice=${encodeURIComponent(`${target.email} is now ${target.disabled ? "enabled" : "disabled"}.`)}`);
    } catch (error) {
      response.redirect(303, `/app/users?error=${encodeURIComponent(exposedMessage(error))}`);
    }
  });

  router.get("/app/security", sessions.requireUser(), (request, response) => {
    const user = request.webUser!;
    response.type("html").send(securityPage({
      user,
      csrfToken: request.webSession!.csrfToken,
      tokens: store.listApiTokens(user.id),
      authMode: config.auth.mode,
      message: messageFromQuery(request),
    }));
  });

  router.post("/app/security/tokens", sessions.requireUser(), sessions.requireCsrf(), (request, response) => {
    const user = request.webUser!;
    try {
      const name = required(bodyString(request, "name"), "Token name");
      const created = createPersonalAccessToken();
      store.createApiToken({
        id: randomUUID(),
        userId: user.id,
        name,
        tokenHash: created.hash,
        scopes: [...config.auth.scopes],
        createdAt: new Date().toISOString(),
      });
      store.addAudit(SqliteStore.audit({ actorId: user.id, action: "create_mcp_token", status: "success", detail: name }));
      response.status(201).type("html").send(securityPage({
        user,
        csrfToken: request.webSession!.csrfToken,
        tokens: store.listApiTokens(user.id),
        authMode: config.auth.mode,
        newToken: created.token,
        message: { notice: "Token created. Copy it before leaving this page." },
      }));
    } catch (error) {
      response.status(statusCode(error)).type("html").send(securityPage({
        user,
        csrfToken: request.webSession!.csrfToken,
        tokens: store.listApiTokens(user.id),
        authMode: config.auth.mode,
        message: { error: exposedMessage(error) },
      }));
    }
  });

  router.post("/app/security/tokens/:tokenId/revoke", sessions.requireUser(), sessions.requireCsrf(), (request, response) => {
    const user = request.webUser!;
    try {
      store.revokeApiToken(user.id, paramString(request, "tokenId"));
      store.addAudit(SqliteStore.audit({ actorId: user.id, action: "revoke_mcp_token", status: "success" }));
      response.redirect(303, `/app/security?notice=${encodeURIComponent("Token revoked.")}`);
    } catch (error) {
      response.redirect(303, `/app/security?error=${encodeURIComponent(exposedMessage(error))}`);
    }
  });

  router.post("/app/security/password", sessions.requireUser(), sessions.requireCsrf(), asyncHandler(async (request, response) => {
    const user = request.webUser!;
    try {
      const current = store.getUserWithPasswordByEmail(user.email);
      if (!current || !(await verifyPassword(bodyString(request, "current_password"), current.passwordHash))) {
        throw new AppError("INVALID_CURRENT_PASSWORD", "The current password is incorrect.", 400);
      }
      store.updateUserPassword(user.id, await hashPassword(bodyString(request, "new_password")));
      store.addAudit(SqliteStore.audit({ actorId: user.id, action: "change_password", status: "success" }));
      sessions.clear(request, response);
      response.redirect(303, `/login?notice=${encodeURIComponent("Password changed. Sign in again.")}`);
    } catch (error) {
      response.status(statusCode(error)).type("html").send(securityPage({
        user,
        csrfToken: request.webSession!.csrfToken,
        tokens: store.listApiTokens(user.id),
        authMode: config.auth.mode,
        message: { error: exposedMessage(error) },
      }));
    }
  }));

  return router;
}

function mailboxInput(request: Request, existing?: { imapUsername: string; smtpUsername: string }): MailboxSettingsInput {
  const imapUsername = bodyString(request, "imap_username").trim() || existing?.imapUsername || "";
  const smtpUsername = bodyString(request, "smtp_username").trim() || existing?.smtpUsername || "";
  const displayName = optional(bodyString(request, "display_name"));
  const imapSentFolder = optional(bodyString(request, "imap_sent_folder"));
  const imapPassword = optional(bodyString(request, "imap_password"));
  const smtpPassword = optional(bodyString(request, "smtp_password"));
  return {
    emailAddress: bodyString(request, "email_address"),
    ...(displayName ? { displayName } : {}),
    imapHost: bodyString(request, "imap_host"),
    imapPort: bodyNumber(request, "imap_port"),
    imapSecure: bodyBoolean(request, "imap_secure"),
    imapRejectUnauthorized: bodyBoolean(request, "imap_reject_unauthorized"),
    ...(imapSentFolder ? { imapSentFolder } : {}),
    imapUsername,
    ...(imapPassword ? { imapPassword } : {}),
    smtpHost: bodyString(request, "smtp_host"),
    smtpPort: bodyNumber(request, "smtp_port"),
    smtpSecure: bodyBoolean(request, "smtp_secure"),
    smtpRejectUnauthorized: bodyBoolean(request, "smtp_reject_unauthorized"),
    smtpUsername,
    ...(smtpPassword ? { smtpPassword } : {}),
    readEnabled: bodyBoolean(request, "read_enabled"),
    sendEnabled: bodyBoolean(request, "send_enabled"),
    saveSentCopy: bodyBoolean(request, "save_sent_copy"),
  };
}

function bodyString(request: Request, name: string): string {
  const value = request.body?.[name];
  return typeof value === "string" ? value : "";
}

function bodyNumber(request: Request, name: string): number {
  return Number(bodyString(request, name));
}

function bodyBoolean(request: Request, name: string): boolean {
  return bodyString(request, name) === "1" || bodyString(request, name).toLowerCase() === "true";
}

function paramString(request: Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function queryString(request: Request, name: string): string | undefined {
  const value = request.query[name];
  return typeof value === "string" ? value : undefined;
}

function messageFromQuery(request: Request): PageMessage {
  const notice = queryString(request, "notice");
  const error = queryString(request, "error");
  return { ...(notice ? { notice } : {}), ...(error ? { error } : {}) };
}

function normalizedEmail(value: string): string {
  return emailSchema.parse(value.trim().toLowerCase());
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AppError("REQUIRED_FIELD", `${label} is required.`);
  return trimmed;
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function exposedMessage(error: unknown): string {
  if (error instanceof AppError && error.expose) return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "The submitted data is invalid.";
  if (error instanceof Error && error.message.startsWith("Password ")) return error.message;
  return "The operation failed. Check the server logs for details.";
}

function statusCode(error: unknown): number {
  return error instanceof AppError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
}

function asyncHandler(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next);
  };
}


class LoginAttemptLimiter {
  private readonly entries = new Map<string, { failures: number; firstFailureAt: number; blockedUntil?: number }>();
  private readonly windowMs = 15 * 60 * 1_000;
  private readonly maxFailures = 8;

  isBlocked(key: string): boolean {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.blockedUntil && entry.blockedUntil > now) return true;
    if (entry.firstFailureAt + this.windowMs <= now) this.entries.delete(key);
    return false;
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const current = this.entries.get(key);
    const entry = !current || current.firstFailureAt + this.windowMs <= now
      ? { failures: 0, firstFailureAt: now }
      : current;
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) entry.blockedUntil = now + this.windowMs;
    this.entries.set(key, entry);
    if (this.entries.size > 10_000) this.prune(now);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if ((entry.blockedUntil ?? entry.firstFailureAt + this.windowMs) <= now) this.entries.delete(key);
      if (this.entries.size <= 8_000) break;
    }
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
