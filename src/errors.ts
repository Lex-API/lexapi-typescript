/**
 * Typed errors mirroring the LexAPI error envelope:
 *
 *   { "success": false, "error": { "code": "NOT_FOUND", "message": "...", "details": {...} } }
 *
 * Some legacy endpoints return a bare `{ "error": "...", "message": "..." }`
 * body without the typed envelope; the parser tolerates both shapes. Unknown
 * codes never crash the parser — the raw code string is preserved on the
 * base `LexAPIError` (forward compatibility).
 */

/** Stable error codes from the OpenAPI `ErrorResponse.error.code` enum. */
export type ErrorCode =
  | "NOT_FOUND"
  | "INVALID_CELEX"
  | "INVALID_URL"
  | "INVALID_PARAMS"
  | "RATE_LIMITED"
  | "TIER_FORBIDDEN"
  | "CREDITS_EXHAUSTED"
  | "UPSTREAM_ERROR"
  | "TIMEOUT"
  | "INTERNAL"
  // Derived (not in the envelope enum): 401 has no typed code in the spec.
  | "UNAUTHORIZED"
  // Client-side transport failure (no HTTP response at all).
  | "NETWORK_ERROR"
  // Forward compatibility: unknown codes are kept as-is.
  | (string & {});

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: "INVALID_PARAMS",
  401: "UNAUTHORIZED",
  402: "CREDITS_EXHAUSTED",
  403: "TIER_FORBIDDEN",
  404: "NOT_FOUND",
  429: "RATE_LIMITED",
  502: "UPSTREAM_ERROR",
  504: "TIMEOUT",
};

/** Base class for every error thrown by the SDK. */
export class LexAPIError extends Error {
  /** Stable machine-readable code (`error.code`, or derived from the HTTP status for legacy bodies). */
  readonly code: ErrorCode;
  /** HTTP status. `0` for client-side failures (network error, client-side timeout). */
  readonly status: number;
  /** The `error.details` object from the typed envelope, when present. */
  readonly details: unknown;
  /**
   * Seconds to wait before retrying, when the server said so (429).
   * Sourced from the `Retry-After` response HEADER first; the JSON
   * `retryAfter` body field is only a fallback because it historically
   * carried buggy epoch-seconds values (epoch-looking values are
   * normalized to a delta).
   */
  readonly retryAfter: number | undefined;

  constructor(
    code: ErrorCode,
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

  /**
   * Build the most specific error subclass for a non-2xx response.
   * Accepts both the typed envelope and the legacy bare `{error, message}` shape.
   */
  static fromResponse(status: number, body: unknown, headerRetryAfter?: number): LexAPIError {
    let code: ErrorCode = STATUS_TO_CODE[status] ?? "INTERNAL";
    let message = `HTTP ${status}`;
    let details: unknown;
    let retryAfter = headerRetryAfter;
    let resetsAt: string | undefined;

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
        // Legacy bare {error: "...", message?: "..."} — `error` is a short
        // slug or the message itself; a sibling `message` adds detail.
        message =
          typeof record["message"] === "string" && record["message"] !== err
            ? `${err}: ${record["message"]}`
            : err;
      } else if (typeof record["message"] === "string") {
        message = record["message"];
      }
      // JSON retryAfter fallback — only when the header didn't provide one.
      if (retryAfter === undefined) {
        const jsonRetryAfter = readNumber(record["retryAfter"]) ?? readNumber(detailsField(details, "retryAfter"));
        if (jsonRetryAfter !== undefined) retryAfter = normalizeRetryAfterSeconds(jsonRetryAfter);
      }
      // resetsAt for CREDITS_EXHAUSTED: spec puts it in error.details; some
      // envelopes also carry a top-level usage.resetsAt.
      resetsAt =
        readString(detailsField(details, "resetsAt")) ??
        readString(usageField(record, "resetsAt"));
    }

    switch (code) {
      case "NOT_FOUND":
        return new NotFoundError(message, status, details, retryAfter);
      case "INVALID_CELEX":
        return new InvalidCelexError(message, status, details, retryAfter);
      case "INVALID_URL":
        return new InvalidUrlError(message, status, details, retryAfter);
      case "INVALID_PARAMS":
        return new InvalidParamsError(message, status, details, retryAfter);
      case "RATE_LIMITED":
        return new RateLimitedError(message, status, details, retryAfter);
      case "TIER_FORBIDDEN":
        return new TierForbiddenError(message, status, details, retryAfter);
      case "CREDITS_EXHAUSTED":
        return new CreditsExhaustedError(message, status, details, retryAfter, resetsAt);
      case "UPSTREAM_ERROR":
        return new UpstreamError(message, status, details, retryAfter);
      case "TIMEOUT":
        return new TimeoutError(message, status, details, retryAfter);
      case "UNAUTHORIZED":
        return new AuthenticationError(message, status, details, retryAfter);
      case "INTERNAL":
        return new InternalServerError(message, status, details, retryAfter);
      default:
        // Unknown code: keep the raw string, never crash (forward compat).
        return new LexAPIError(code, message, status, details, retryAfter);
    }
  }
}

/** 404 — document or resource missing (`NOT_FOUND`). */
export class NotFoundError extends LexAPIError {
  constructor(message: string, status = 404, details?: unknown, retryAfter?: number) {
    super("NOT_FOUND", message, status, details, retryAfter);
    this.name = "NotFoundError";
  }
}

/** 400 — CELEX failed validation (`INVALID_CELEX`). */
export class InvalidCelexError extends LexAPIError {
  constructor(message: string, status = 400, details?: unknown, retryAfter?: number) {
    super("INVALID_CELEX", message, status, details, retryAfter);
    this.name = "InvalidCelexError";
  }
}

/** 400 — URL had no resolvable CELEX (`INVALID_URL`). */
export class InvalidUrlError extends LexAPIError {
  constructor(message: string, status = 400, details?: unknown, retryAfter?: number) {
    super("INVALID_URL", message, status, details, retryAfter);
    this.name = "InvalidUrlError";
  }
}

/** 400 — missing or malformed params (`INVALID_PARAMS`). */
export class InvalidParamsError extends LexAPIError {
  constructor(message: string, status = 400, details?: unknown, retryAfter?: number) {
    super("INVALID_PARAMS", message, status, details, retryAfter);
    this.name = "InvalidParamsError";
  }
}

/** 401 — missing, invalid, or revoked API key. */
export class AuthenticationError extends LexAPIError {
  constructor(message: string, status = 401, details?: unknown, retryAfter?: number) {
    super("UNAUTHORIZED", message, status, details, retryAfter);
    this.name = "AuthenticationError";
  }
}

/** 429 — quota or rate ceiling hit (`RATE_LIMITED`). Check `retryAfter`. */
export class RateLimitedError extends LexAPIError {
  constructor(message: string, status = 429, details?: unknown, retryAfter?: number) {
    super("RATE_LIMITED", message, status, details, retryAfter);
    this.name = "RateLimitedError";
  }
}

/** 403 — tier-gated endpoint (`TIER_FORBIDDEN`). Retrying cannot help; upgrade the plan. */
export class TierForbiddenError extends LexAPIError {
  constructor(message: string, status = 403, details?: unknown, retryAfter?: number) {
    super("TIER_FORBIDDEN", message, status, details, retryAfter);
    this.name = "TierForbiddenError";
  }
}

/** 402 — monthly credit pool exhausted (`CREDITS_EXHAUSTED`). Not retried. */
export class CreditsExhaustedError extends LexAPIError {
  /** When the monthly credit allowance resets (ISO date-time), when the server said so. */
  readonly resetsAt: string | undefined;

  constructor(
    message: string,
    status = 402,
    details?: unknown,
    retryAfter?: number,
    resetsAt?: string,
  ) {
    super("CREDITS_EXHAUSTED", message, status, details, retryAfter);
    this.name = "CreditsExhaustedError";
    this.resetsAt = resetsAt;
  }
}

/** 502 — EUR-Lex returned an error (`UPSTREAM_ERROR`). Retry-safe on GETs. */
export class UpstreamError extends LexAPIError {
  constructor(message: string, status = 502, details?: unknown, retryAfter?: number) {
    super("UPSTREAM_ERROR", message, status, details, retryAfter);
    this.name = "UpstreamError";
  }
}

/**
 * `TIMEOUT` — either a server-reported 504 (upstream EUR-Lex fetch timed out,
 * spec-marked retry-safe) or a client-side timeout (`status === 0`) when the
 * configured `timeoutMs` elapsed before a response arrived.
 */
export class TimeoutError extends LexAPIError {
  constructor(message: string, status = 0, details?: unknown, retryAfter?: number) {
    super("TIMEOUT", message, status, details, retryAfter);
    this.name = "TimeoutError";
  }
}

/** 500 — unexpected server failure (`INTERNAL`). Not retried by default. */
export class InternalServerError extends LexAPIError {
  constructor(message: string, status = 500, details?: unknown, retryAfter?: number) {
    super("INTERNAL", message, status, details, retryAfter);
    this.name = "InternalServerError";
  }
}

/** Transport-level failure: DNS, connection reset, etc. No HTTP response was received. */
export class NetworkError extends LexAPIError {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super("NETWORK_ERROR", message, 0);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/**
 * Normalize a JSON `retryAfter` body value. The field historically carried
 * buggy absolute epoch values instead of delta-seconds (pending server fix);
 * epoch-looking values are converted to a non-negative delta in seconds.
 */
export function normalizeRetryAfterSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1e12) return Math.max(0, Math.round((value - Date.now()) / 1000)); // epoch millis
  if (value > 1e9) return Math.max(0, Math.round(value - Date.now() / 1000)); // epoch seconds
  return Math.max(0, value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function detailsField(details: unknown, key: string): unknown {
  if (typeof details === "object" && details !== null) {
    return (details as Record<string, unknown>)[key];
  }
  return undefined;
}

function usageField(record: Record<string, unknown>, key: string): unknown {
  return detailsField(record["usage"], key);
}
