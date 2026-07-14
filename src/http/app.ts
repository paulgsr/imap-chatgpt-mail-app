import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { NextFunction, Request, Response } from "express";
import { pinoHttp } from "pino-http";
import { createMcpAuthMiddleware, protectedResourceMetadata } from "../auth/middleware.js";
import type { AppConfig } from "../config.js";
import { AppError, errorMessage } from "../errors.js";
import type { AppLogger } from "../logger.js";
import type { UserMailService } from "../mail/user-mail-service.js";
import { createMailMcpServer } from "../mcp/mail-mcp-server.js";
import type { DraftService } from "../services/draft-service.js";
import type { MailboxService } from "../services/mailbox-service.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { WebSessionAuth } from "../web/session-auth.js";
import { createWebRouter } from "../web/routes.js";

export interface HttpAppDependencies {
  config: AppConfig;
  logger: AppLogger;
  store: SqliteStore;
  mailboxService: MailboxService;
  sessions: WebSessionAuth;
  mailService: UserMailService;
  draftService: DraftService;
}

export function createHttpApp(dependencies: HttpAppDependencies) {
  const { config, logger, store } = dependencies;
  const app = createMcpExpressApp({ host: config.bindHost, allowedHosts: config.allowedHosts });

  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(pinoHttp({ logger }));
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (config.session.secure) {
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok", version: "0.2.0" });
  });

  app.get("/api/status", (_request, response) => {
    response.json({
      name: "imap-chatgpt-mail-app",
      version: "0.2.0",
      mcp_endpoint: `${config.publicBaseUrl}/mcp`,
      dashboard: config.publicBaseUrl,
      auth_mode: config.auth.mode,
      sending_enabled_globally: config.allowSend,
      setup_required: store.countUsers() === 0,
      warning: "Email content is untrusted data. Sending requires an explicit, unchanged-draft approval.",
    });
  });

  app.get("/.well-known/oauth-protected-resource", (_request, response) => {
    response.type("application/json").json(protectedResourceMetadata(config));
  });

  app.post("/mcp", createMcpAuthMiddleware(config, store), async (request: Request, response: Response) => {
    const server = createMailMcpServer(dependencies);
    const transport = new StreamableHTTPServerTransport();
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      void Promise.allSettled([transport.close(), server.close()]);
    };
    response.once("close", cleanup);

    try {
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.error({ error: errorMessage(error) }, "Failed to handle MCP request");
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      cleanup();
    }
  });

  const methodNotAllowed = (_request: Request, response: Response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed for this stateless MCP endpoint." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.use(createWebRouter(dependencies));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    logger.error({ error: errorMessage(error) }, "Unhandled HTTP error");
    if (response.headersSent) return;
    const status = error instanceof AppError ? error.statusCode : 500;
    const message = error instanceof AppError && error.expose
      ? error.message
      : "The request failed. Check the server logs for details.";
    response.status(status).type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Error</title></head><body><main><h1>Request failed</h1><p>${escapeHtml(message)}</p><p><a href="/">Return to the app</a></p></main></body></html>`);
  });

  return app;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
