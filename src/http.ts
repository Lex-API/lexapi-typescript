import {
  LexAPIError,
  NetworkError,
  TimeoutError,
  normalizeRetryAfterSeconds,
} from "./errors.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://lex-api.com/api/v1";
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Retry policy knobs (SDK contract §1.2). */
export interface RetryOptions {
  /** Max retries after the initial attempt. Default 3. Set 0 to disable retries. */
  maxRetries?: number;
  /** Exponential backoff base. Default 500 ms. */
  baseDelayMs?: number;
  /** Cap on any single wait (computed or server-directed). Default 30 000 ms. */
  maxDelayMs?: number;
}

export interface HttpClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
  retry: Required<RetryOptions>;
  userAgentSuffix?: string | undefined;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: QueryParams;
  body?: unknown;
  /** Per-call timeout override. */
  timeoutMs?: number | undefined;
}

/** Statuses the SDK retries (429 rate limit, 502/503/504 transient upstream). */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Browsers forbid setting the `User-Agent` header (and this SDK is
 * server-side only anyway — API keys are secrets). Only send the UA
 * header on non-browser runtimes.
 */
function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Single request core used by every SDK method.
 *
 * - `x-api-key` auth + `User-Agent: lexapi-typescript/<version>` on every request
 *   (UA omitted on browser runtimes, where it cannot be set).
 * - Timeout per attempt via `AbortController`.
 * - Retries: up to `maxRetries` (default 3) on 429/502/503/504 and on
 *   transport-level network errors, with exponential backoff + full jitter.
 *   Server-directed waits win over computed backoff, resolved in order:
 *   `Retry-After` header → `RateLimit-Reset` header → JSON `retryAfter` body
 *   field (epoch-guarded — the field was buggy epoch-seconds until a pending
 *   server fix, which is why the HEADER is authoritative) → backoff.
 * - Non-idempotent methods (anything but GET) are retried ONLY on 429 —
 *   never on 5xx or network errors, where the request may have been applied.
 */
export class HttpClient {
  private readonly opts: HttpClientOptions;
  private readonly userAgent: string;

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.userAgent = opts.userAgentSuffix
      ? `lexapi-typescript/${VERSION} ${opts.userAgentSuffix}`
      : `lexapi-typescript/${VERSION}`;
  }

  /** Perform a request and parse the JSON body (204 yields `undefined`). */
  async requestJson<T>(options: RequestOptions): Promise<T> {
    const { data } = await this.requestJsonWithResponse<T>(options);
    return data;
  }

  /** Like `requestJson`, but also exposes the raw `Response` (for header signals). */
  async requestJsonWithResponse<T>(options: RequestOptions): Promise<{ data: T; response: Response }> {
    const response = await this.requestRaw(options);
    if (response.status === 204) {
      return { data: undefined as T, response };
    }
    return { data: (await response.json()) as T, response };
  }

  /**
   * Perform a request and return the raw successful `Response` without
   * consuming the body (used by streaming endpoints such as `/export`).
   * Non-2xx responses are parsed and thrown as typed errors; the retry
   * policy applies before the first body byte is consumed.
   */
  async requestRaw(options: RequestOptions): Promise<Response> {
    const { method, path, query, body } = options;
    const url = `${this.opts.baseUrl}${path}${buildQuery(query)}`;
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;
    const { maxRetries, baseDelayMs, maxDelayMs } = this.opts.retry;

    const headers: Record<string, string> = {
      "x-api-key": this.opts.apiKey,
      accept: "application/json",
    };
    if (!isBrowserRuntime()) {
      headers["user-agent"] = this.userAgent;
    }
    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      serializedBody = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, {
          method,
          headers,
          ...(serializedBody !== undefined ? { body: serializedBody } : {}),
          timeoutMs,
        });
      } catch (cause) {
        if (cause instanceof TimeoutError) throw cause; // client-side timeout: not retried
        // Transport-level network error. Only safe to retry idempotent GETs —
        // a non-GET may have been applied server-side before the connection died.
        if (attempt < maxRetries && method === "GET") {
          await sleep(fullJitterBackoff(attempt, baseDelayMs, maxDelayMs));
          continue;
        }
        throw new NetworkError(`Network error calling ${method} ${path}`, cause);
      }

      if (response.ok) return response;

      const error = await parseErrorResponse(response);
      const retryable =
        RETRYABLE_STATUSES.has(response.status) &&
        (method === "GET" || response.status === 429);
      if (attempt < maxRetries && retryable) {
        const serverWaitSeconds = serverDirectedWaitSeconds(response, error);
        const waitMs =
          serverWaitSeconds !== undefined
            ? Math.min(serverWaitSeconds * 1000, maxDelayMs)
            : fullJitterBackoff(attempt, baseDelayMs, maxDelayMs);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    try {
      return await this.opts.fetchFn(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new TimeoutError(`Request timed out after ${init.timeoutMs}ms`, 0);
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse a non-2xx response into the typed error hierarchy. */
export async function parseErrorResponse(response: Response): Promise<LexAPIError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return LexAPIError.fromResponse(response.status, body, headerRetryAfterSeconds(response));
}

/** `Retry-After` header — delta-seconds or an HTTP-date. */
function headerRetryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return undefined;
}

/**
 * Server-directed wait, resolved in the SDK contract's precedence order:
 * `Retry-After` header → `RateLimit-Reset` header (draft IETF delta-seconds)
 * → JSON `retryAfter` body field (already epoch-normalized on the error).
 */
function serverDirectedWaitSeconds(response: Response, error: LexAPIError): number | undefined {
  const header = headerRetryAfterSeconds(response);
  if (header !== undefined) return header;
  const rateLimitReset = response.headers.get("ratelimit-reset");
  if (rateLimitReset !== null) {
    const seconds = Number(rateLimitReset);
    if (Number.isFinite(seconds)) return normalizeRetryAfterSeconds(seconds);
  }
  return error.retryAfter;
}

/** Full-jitter exponential backoff: `random() * min(cap, base * 2^attempt)`. */
function fullJitterBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildQuery(query?: QueryParams): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
