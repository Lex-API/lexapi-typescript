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

import type { RateLimitInfo, ResponseHeaders } from "./headers.js";

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
  // Derived: 503 (deploy drain / temporary unavailability) has no typed code.
  | "SERVICE_UNAVAILABLE"
  // SDK-side (SDK contract §1.3): transport failure — `NetworkError`.
  | "CONNECTION_ERROR"
  // SDK-side: the SDK's own response timeout (status 0) — `TimeoutError`;
  // distinct from the server's `TIMEOUT` (504/524).
  | "REQUEST_TIMEOUT"
  // SDK-side: the caller's AbortSignal fired — `RequestAbortedError`.
  | "ABORTED"
  // SDK-side: a 2xx whose non-empty body is not JSON — `InvalidResponseError`.
  | "INVALID_RESPONSE"
  // SDK-side: an export ended without its `_done` trailer — `IncompleteExportError`.
  | "INCOMPLETE_EXPORT"
  // Forward compatibility: unknown codes are kept as-is.
  | (string & {});

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: "INVALID_PARAMS",
  401: "UNAUTHORIZED",
  402: "CREDITS_EXHAUSTED",
  403: "TIER_FORBIDDEN",
  404: "NOT_FOUND",
  429: "RATE_LIMITED",
  500: "INTERNAL",
  502: "UPSTREAM_ERROR",
  503: "SERVICE_UNAVAILABLE",
  504: "TIMEOUT",
  // Cloudflare edge errors (non-JSON bodies). SDK contract §1.3.
  520: "UPSTREAM_ERROR",
  521: "UPSTREAM_ERROR",
  522: "UPSTREAM_ERROR",
  523: "UPSTREAM_ERROR",
  524: "TIMEOUT",
};

/** Extra context attached to errors built from an HTTP response. */
export interface LexAPIErrorContext {
  /** The parsed JSON error body, verbatim (e.g. legacy `upgradeUrl`, `current`/`limit`). */
  body?: unknown;
  /** Parsed response headers (rate limits, source, …). */
  headers?: ResponseHeaders;
}

/**
 * Brand stamped on every SDK error (registered symbol, so it is shared by the
 * ESM and CommonJS builds — and by two installed copies of the package).
 * Holds the error's class kinds, most specific first.
 */
const ERROR_KINDS = Symbol.for("@lexapi/client.errorKinds");

function collectKinds(ctor: unknown): string[] {
  const kinds: string[] = [];
  let current: unknown = ctor;
  while (typeof current === "function") {
    const kind = (current as { kind?: unknown }).kind;
    if (Object.prototype.hasOwnProperty.call(current, "kind") && typeof kind === "string") {
      kinds.push(kind);
    }
    current = Object.getPrototypeOf(current);
  }
  return kinds;
}

/**
 * `instanceof` that also works across the dual-package hazard: an error
 * thrown by the CommonJS build (`require`) is still `instanceof` the ESM
 * build's classes (`import`), because both check the shared brand. Classes
 * you derive yourself fall back to the ordinary prototype check.
 */
function brandedHasInstance(ctor: { kind?: string }, value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Function.prototype[Symbol.hasInstance].call(ctor, value)) return true;
  if (!Object.prototype.hasOwnProperty.call(ctor, "kind")) return false;
  const kinds = (value as Record<symbol, unknown>)[ERROR_KINDS];
  return Array.isArray(kinds) && kinds.includes(ctor.kind);
}

/** Base class for every error thrown by the SDK. */
export class LexAPIError extends Error {
  /** Stable class tag used by the cross-build `instanceof` brand check. */
  static readonly kind: string = "LexAPIError";

  static override [Symbol.hasInstance](value: unknown): boolean {
    return brandedHasInstance(this, value);
  }

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
  /**
   * The parsed JSON error body, verbatim. Useful for legacy-shape fields the
   * typed properties don't cover (`upgradeUrl` on tier gates, `current` /
   * `limit` on the webhook ceiling, `usage` on legacy quota 429s).
   */
  readonly body: unknown;
  /** Parsed response headers, when the error came from an HTTP response. */
  readonly headers: ResponseHeaders | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super(`[${code}] ${message} (HTTP ${status})`);
    this.name = "LexAPIError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryAfter = retryAfter;
    this.body = context?.body;
    this.headers = context?.headers;
    Object.defineProperty(this, ERROR_KINDS, { value: collectKinds(new.target), enumerable: false });
  }

  /**
   * Build the most specific error subclass for a non-2xx response.
   * Accepts both the typed envelope and the legacy bare `{error, message}` shape.
   */
  static fromResponse(
    status: number,
    body: unknown,
    headerRetryAfter?: number,
    headers?: ResponseHeaders,
  ): LexAPIError {
    // SDK contract §1.3: unmapped statuses are INTERNAL.
    const statusCode = STATUS_TO_CODE[status];
    let code: ErrorCode = statusCode ?? "INTERNAL";
    let typedCode = false;
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
        if (typeof e["code"] === "string") {
          code = e["code"];
          typedCode = true;
        }
        if (typeof e["message"] === "string") message = e["message"];
        details = e["details"];
      } else if (typeof err === "string") {
        // Legacy bare {error: "<text>", message?, details?}: the string is
        // HUMAN TEXT, never a code (even when it looks like a slug) — the
        // code comes from the status. `details` (validation lists) is kept.
        message =
          typeof record["message"] === "string" && record["message"] !== err
            ? `${err}: ${record["message"]}`
            : err;
        details = record["details"];
      } else {
        // No `error` member ({message, details}): keep both when present.
        if (typeof record["message"] === "string") message = record["message"];
        details = record["details"];
      }
      // JSON retryAfter fallback — only on a 429, and only when the header
      // didn't provide one.
      if (retryAfter === undefined && status === 429) {
        const jsonRetryAfter = readNumber(record["retryAfter"]) ?? readNumber(detailsField(details, "retryAfter"));
        if (jsonRetryAfter !== undefined) retryAfter = normalizeRetryAfterSeconds(jsonRetryAfter);
      }
      // resetsAt for CREDITS_EXHAUSTED: spec puts it in error.details; some
      // envelopes also carry a top-level usage.resetsAt.
      resetsAt =
        readString(detailsField(details, "resetsAt")) ??
        readString(usageField(record, "resetsAt"));
    }

    const context: LexAPIErrorContext = { body, ...(headers ? { headers } : {}) };
    // An unmapped client status (409, 413, …) keeps code INTERNAL per the
    // contract but is not presented as a server failure: base class.
    if (!typedCode && statusCode === undefined && status < 500) {
      return new LexAPIError(code, message, status, details, retryAfter, context);
    }
    // §1.2: a quota-exhausted 429 exposes no retry-after value.
    if (code === "RATE_LIMITED" && isQuota429(body, headers)) {
      return new RateLimitedError(message, status, details, undefined, context);
    }
    switch (code) {
      case "NOT_FOUND":
        return new NotFoundError(message, status, details, retryAfter, context);
      case "INVALID_CELEX":
        return new InvalidCelexError(message, status, details, retryAfter, context);
      case "INVALID_URL":
        return new InvalidUrlError(message, status, details, retryAfter, context);
      case "INVALID_PARAMS":
        return new InvalidParamsError(message, status, details, retryAfter, context);
      case "RATE_LIMITED":
        return new RateLimitedError(message, status, details, retryAfter, context);
      case "TIER_FORBIDDEN":
        return new TierForbiddenError(message, status, details, retryAfter, context);
      case "CREDITS_EXHAUSTED":
        return new CreditsExhaustedError(message, status, details, retryAfter, resetsAt, context);
      case "UPSTREAM_ERROR":
        return new UpstreamError(message, status, details, retryAfter, context);
      case "TIMEOUT":
        return new TimeoutError(message, status, details, retryAfter, context);
      case "UNAUTHORIZED":
        return new AuthenticationError(message, status, details, retryAfter, context);
      case "SERVICE_UNAVAILABLE":
        return new ServiceUnavailableError(message, status, details, retryAfter, context);
      case "INTERNAL":
        return new InternalServerError(message, status, details, retryAfter, context);
      default:
        // Unknown code: keep the raw string, never crash (forward compat).
        return new LexAPIError(code, message, status, details, retryAfter, context);
    }
  }
}

/** 404 — document or resource missing (`NOT_FOUND`). */
export class NotFoundError extends LexAPIError {
  static override readonly kind: string = "NotFoundError";
  constructor(
    message: string,
    status = 404,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("NOT_FOUND", message, status, details, retryAfter, context);
    this.name = "NotFoundError";
  }
}

/** 400 — CELEX failed validation (`INVALID_CELEX`). */
export class InvalidCelexError extends LexAPIError {
  static override readonly kind: string = "InvalidCelexError";
  constructor(
    message: string,
    status = 400,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("INVALID_CELEX", message, status, details, retryAfter, context);
    this.name = "InvalidCelexError";
  }
}

/** 400 — URL had no resolvable CELEX (`INVALID_URL`). */
export class InvalidUrlError extends LexAPIError {
  static override readonly kind: string = "InvalidUrlError";
  constructor(
    message: string,
    status = 400,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("INVALID_URL", message, status, details, retryAfter, context);
    this.name = "InvalidUrlError";
  }
}

/** 400 — missing or malformed params (`INVALID_PARAMS`). */
export class InvalidParamsError extends LexAPIError {
  static override readonly kind: string = "InvalidParamsError";
  constructor(
    message: string,
    status = 400,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("INVALID_PARAMS", message, status, details, retryAfter, context);
    this.name = "InvalidParamsError";
  }
}

/** 401 — missing, invalid, or revoked API key. */
export class AuthenticationError extends LexAPIError {
  static override readonly kind: string = "AuthenticationError";
  constructor(
    message: string,
    status = 401,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("UNAUTHORIZED", message, status, details, retryAfter, context);
    this.name = "AuthenticationError";
  }
}

/**
 * 429 — per-minute rate limit (or, on legacy daily plans, the daily quota).
 * Today's 429s use the legacy `{error, message, retryAfter}` body; the
 * `Retry-After` header is authoritative and is what `retryAfter` reads first.
 */
export class RateLimitedError extends LexAPIError {
  static override readonly kind: string = "RateLimitedError";
  constructor(
    message: string,
    status = 429,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("RATE_LIMITED", message, status, details, retryAfter, context);
    this.name = "RateLimitedError";
  }

  /** `RateLimit-*` headers from the 429 response (limit / remaining / reset seconds). */
  get rateLimit(): RateLimitInfo | undefined {
    return this.headers?.rateLimit;
  }

  /**
   * `true` for a legacy-plan quota 429 (daily call quota, or the monthly
   * semantic quota) rather than the per-minute limiter (SDK contract §1.2):
   * the body carries `usage.resetsAt`, with neither a `Retry-After` header
   * nor a `retryAfter` body field. It cannot succeed before `resetsAt`, so
   * the SDK does not retry it and `retryAfter` is `undefined`.
   */
  get quotaExhausted(): boolean {
    return isQuota429(this.body, this.headers);
  }

  /** When a legacy quota resets (`usage.resetsAt` on quota 429s). */
  get resetsAt(): string | undefined {
    return readString(detailsField(bodyField(this.body, "usage"), "resetsAt"));
  }
}

/** 403 — tier-gated endpoint (`TIER_FORBIDDEN`). Retrying cannot help; upgrade the plan. */
export class TierForbiddenError extends LexAPIError {
  static override readonly kind: string = "TierForbiddenError";
  constructor(
    message: string,
    status = 403,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("TIER_FORBIDDEN", message, status, details, retryAfter, context);
    this.name = "TierForbiddenError";
  }
}

/** `error.details` on a 402 `CREDITS_EXHAUSTED` envelope. */
export interface CreditsExhaustedDetails {
  /** The operation that was refused, e.g. `"semantic_case_law"`. */
  operation?: string;
  /** Its upfront credit weight (variable-priced operations are admitted against their upfront weight). */
  weight?: number;
  /** Credits left in the pool (monthly + top-up − used). `weight − available` is the shortfall. */
  available?: number;
  /** Monthly allowance. */
  included?: number;
  /** Top-up credits. */
  topup?: number;
  /** Credits used this window. */
  used?: number;
  /** When the monthly pool refills. */
  resetsAt?: string | null;
  [key: string]: unknown;
}

/**
 * 402 — monthly credit pool (incl. top-ups) cannot cover the operation
 * (`CREDITS_EXHAUSTED`). Not retried: wait for `resetsAt`, buy a top-up, or
 * upgrade. A cheaper operation may still succeed — compare `weight` to `available`.
 */
export class CreditsExhaustedError extends LexAPIError {
  static override readonly kind: string = "CreditsExhaustedError";
  /** When the monthly credit allowance resets (ISO date-time), when the server said so. */
  readonly resetsAt: string | undefined;
  /** Typed view of `error.details` (operation, weight, available, included, topup, used, resetsAt). */
  declare readonly details: CreditsExhaustedDetails | undefined;

  constructor(
    message: string,
    status = 402,
    details?: unknown,
    retryAfter?: number,
    resetsAt?: string,
    context?: LexAPIErrorContext,
  ) {
    super("CREDITS_EXHAUSTED", message, status, details, retryAfter, context);
    this.name = "CreditsExhaustedError";
    this.resetsAt = resetsAt;
  }

  /** The refused operation's credit weight (`details.weight`). */
  get weight(): number | undefined {
    return readNumber(this.details?.weight);
  }

  /** Credits left in the pool (`details.available`). */
  get available(): number | undefined {
    return readNumber(this.details?.available);
  }

  /** The refused operation (`details.operation`). */
  get operation(): string | undefined {
    return readString(this.details?.operation);
  }
}

/** 502 — EUR-Lex returned an error (`UPSTREAM_ERROR`). Retry-safe on GETs. */
export class UpstreamError extends LexAPIError {
  static override readonly kind: string = "UpstreamError";
  constructor(
    message: string,
    status = 502,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("UPSTREAM_ERROR", message, status, details, retryAfter, context);
    this.name = "UpstreamError";
  }
}

/**
 * A timeout. Two cases, told apart by `code` / `status`:
 * - `TIMEOUT` (504, 524): the server or Cloudflare gave up on the upstream.
 * - `REQUEST_TIMEOUT` (`status === 0`): the SDK's own response timeout —
 *   no bytes for `timeoutMs` (SDK contract §1.6).
 */
export class TimeoutError extends LexAPIError {
  static override readonly kind: string = "TimeoutError";
  constructor(
    message: string,
    status = 0,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super(status === 0 ? "REQUEST_TIMEOUT" : "TIMEOUT", message, status, details, retryAfter, context);
    this.name = "TimeoutError";
  }
}

/**
 * 503 — service temporarily unavailable (e.g. a deploy's drain window).
 * Derived from the status (no typed code). Retried like 502/504.
 */
export class ServiceUnavailableError extends LexAPIError {
  static override readonly kind: string = "ServiceUnavailableError";
  constructor(
    message: string,
    status = 503,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("SERVICE_UNAVAILABLE", message, status, details, retryAfter, context);
    this.name = "ServiceUnavailableError";
  }
}

/** 500 — unexpected server failure (`INTERNAL`). Not retried by default. */
export class InternalServerError extends LexAPIError {
  static override readonly kind: string = "InternalServerError";
  constructor(
    message: string,
    status = 500,
    details?: unknown,
    retryAfter?: number,
    context?: LexAPIErrorContext,
  ) {
    super("INTERNAL", message, status, details, retryAfter, context);
    this.name = "InternalServerError";
  }
}

/** Transport-level failure: DNS, connection reset, etc. No HTTP response was received. */
export class NetworkError extends LexAPIError {
  static override readonly kind: string = "NetworkError";
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super("CONNECTION_ERROR", message, 0);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/** The caller's `AbortSignal` fired (status 0). Never retried. `cause` is the signal's reason. */
export class RequestAbortedError extends LexAPIError {
  static override readonly kind: string = "RequestAbortedError";
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super("ABORTED", message, 0);
    this.name = "RequestAbortedError";
    this.cause = cause;
  }
}

/**
 * A 2xx response whose body was not the JSON LexAPI sends (e.g. an HTML page
 * from a proxy). `body` holds the first 500 characters of the raw text.
 */
export class InvalidResponseError extends LexAPIError {
  static override readonly kind: string = "InvalidResponseError";

  constructor(message: string, status: number, rawText?: string, context?: LexAPIErrorContext) {
    super("INVALID_RESPONSE", message, status, undefined, undefined, {
      ...context,
      body: rawText === undefined ? undefined : rawText.slice(0, 500),
    });
    this.name = "InvalidResponseError";
  }
}

/**
 * An export stream ended (cleanly, at EOF) without its trailing `_done` line —
 * the server stopped mid-export (SDK contract §1.8). Raised after the rows
 * that did arrive were yielded; they are NOT a complete export.
 */
export class IncompleteExportError extends LexAPIError {
  static override readonly kind: string = "IncompleteExportError";
  /** Rows yielded before the stream ended. */
  readonly rowsRead: number;

  constructor(message: string, rowsRead: number) {
    super("INCOMPLETE_EXPORT", message, 0);
    this.name = "IncompleteExportError";
    this.rowsRead = rowsRead;
  }
}

/**
 * `true` for any error thrown by this SDK — from either build (ESM or
 * CommonJS) or another installed copy. Pass a class to narrow:
 * `isLexAPIError(err, NotFoundError)`.
 */
export function isLexAPIError<T extends LexAPIError = LexAPIError>(
  value: unknown,
  errorClass?: abstract new (...args: never[]) => T,
): value is T {
  return value instanceof (errorClass ?? LexAPIError);
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

/** SDK contract §1.2 quota-429 test. */
function isQuota429(body: unknown, headers: ResponseHeaders | undefined): boolean {
  const resetsAt = detailsField(detailsField(body, "usage"), "resetsAt");
  if (typeof resetsAt !== "string") return false;
  if (headers?.retryAfter !== undefined && headers.retryAfter.trim() !== "") return false;
  return detailsField(body, "retryAfter") === undefined;
}

function bodyField(body: unknown, key: string): unknown {
  return detailsField(body, key);
}

function usageField(record: Record<string, unknown>, key: string): unknown {
  return detailsField(record["usage"], key);
}
