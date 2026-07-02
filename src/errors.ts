/**
 * Typed errors mirroring the LexAPI error envelope:
 *
 *   { "success": false, "error": { "code": "NOT_FOUND", "message": "...", "details": {...} } }
 *
 * Some legacy endpoints return a bare `{ "error": "..." }` string body; the
 * parser tolerates both shapes.
 */

const STATUS_TO_CODE: Record<number, string> = {
  400: "INVALID_PARAMS",
  401: "UNAUTHORIZED",
  402: "CREDITS_EXHAUSTED",
  403: "TIER_FORBIDDEN",
  404: "NOT_FOUND",
  429: "RATE_LIMITED",
  502: "UPSTREAM_ERROR",
  504: "TIMEOUT",
};

export class LexAPIError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  /** Seconds to wait before retrying, when the server said so (429). */
  readonly retryAfter: number | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: unknown,
    retryAfter?: number,
  ) {
    super(`[${code}] ${message} (HTTP ${status})`);
    this.name = "LexAPIError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryAfter = retryAfter;
  }

  static fromResponse(status: number, body: unknown, headerRetryAfter?: number): LexAPIError {
    let code = STATUS_TO_CODE[status] ?? "INTERNAL";
    let message = `HTTP ${status}`;
    let details: unknown;
    let retryAfter = headerRetryAfter;

    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const err = record["error"];
      if (typeof err === "object" && err !== null) {
        // Typed envelope: {success: false, error: {code, message, details}}
        const e = err as Record<string, unknown>;
        if (typeof e["code"] === "string") code = e["code"];
        if (typeof e["message"] === "string") message = e["message"];
        details = e["details"];
      } else if (typeof err === "string") {
        // Legacy bare {error: "..."}
        message = err;
      }
      if (retryAfter === undefined && typeof record["retryAfter"] === "number") {
        retryAfter = record["retryAfter"];
      }
    }
    return new LexAPIError(code, message, status, details, retryAfter);
  }
}
