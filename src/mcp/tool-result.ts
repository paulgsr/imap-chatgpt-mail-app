import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { AppError, ScopeError, errorMessage } from "../errors.js";
import type { AppLogger } from "../logger.js";
import { authChallenge } from "../security/scopes.js";

export function toolSuccess(
  structuredContent: Record<string, unknown>,
  summary?: string,
  meta?: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: summary ?? JSON.stringify(structuredContent) }],
    structuredContent,
    ...(meta ? { _meta: meta } : {}),
  };
}

export function toolError(
  error: unknown,
  config: AppConfig,
  logger: AppLogger,
): CallToolResult {
  const appError = error instanceof AppError ? error : undefined;
  const message = appError?.expose ? appError.message : "The email operation failed unexpectedly.";
  const code = appError?.code ?? "INTERNAL_ERROR";

  if (!appError) {
    logger.error({ error }, "Unhandled MCP tool error");
  }

  const meta: Record<string, unknown> = {};
  if (error instanceof ScopeError && config.auth.mode === "oauth") {
    meta["mcp/www_authenticate"] = authChallenge(config, error.message);
  }

  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

export async function safely(
  config: AppConfig,
  logger: AppLogger,
  operation: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    logger.debug({ error: errorMessage(error) }, "MCP tool returned an error");
    return toolError(error, config, logger);
  }
}
