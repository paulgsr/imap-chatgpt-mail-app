export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly expose: boolean;

  constructor(code: string, message: string, statusCode = 400, expose = true) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.expose = expose;
  }
}

export class ScopeError extends AppError {
  readonly requiredScopes: string[];

  constructor(requiredScopes: string[]) {
    super(
      "INSUFFICIENT_SCOPE",
      `This action requires: ${requiredScopes.join(", ")}`,
      403,
      true,
    );
    this.requiredScopes = requiredScopes;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}
