import {
  InvalidResponseError,
  LexAPIError,
  NetworkError,
  RateLimitedError,
  RequestAbortedError,
  TimeoutError,
  normalizeRetryAfterSeconds,
} from "./errors.js";
import { parseResponseHeaders } from "./headers.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://lex-api.com/api/v1";
/**
 * 95 s per attempt: above the 90 s hard timeout the API puts on a single live
 * EUR-Lex fetch (so such a fetch ends in the server's typed, refunded 504
 * rather than a client abort that may still be billed), and below
 * Cloudflare's 100 s proxy timeout. A request that runs several upstream
 * fetches (Cellar, then the browser; a batch) can still exceed it.
 */
export const DEFAULT_TIMEOUT_MS = 95_000;

/** Retry policy knobs (SDK contract §1.2). */
export interface RetryOptions {
  /** Max retries after the initial attempt. Default 3. Set 0 to disable retries. */
  maxRetries?: number;
  /** Exponential backoff base. Default 500 ms. */
  baseDelayMs?: number;
  /** Cap on any single wait (computed or server-directed). Default 30 000 ms. */
  maxDelayMs?: number;
  /**
   * SDK contract §1.2 opt-in (default `false`): also retry the eight
   * read-only POSTs (`search`, `getDocument`, `getDocumentsBatch`,
   * `getDocumentByUrl`, `getDocumentMetadata`, `resolve`, `semanticSearch`,
   * `semanticLegislationSearch`) on an **app-origin** 502/503/504 — those
   * are refunded in full, so the retry is billing-safe. App-origin = a
   * non-empty `X-LexAPI-Version` or a `RateLimit-Limit` header; anything
   * else is treated as a proxy answer and never retried on a billed call. Never applies to mutating calls (webhook
   * writes, `extractCitations`).
   */
  retryReadOnlyPosts?: boolean;
}

export interface HttpClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
  retry: Required<RetryOptions>;
  userAgentSuffix?: string | undefined;
}

/** Query values; arrays are sent as repeated parameters (`?a=x&a=y`). */
export type QueryParams = Record<
  string,
  string | number | boolean | undefined | ReadonlyArray<string | number | boolean>
>;

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: QueryParams;
  body?: unknown;
  /** Per-call timeout override (per attempt, covering the response body). */
  timeoutMs?: number | undefined;
  /** Caller cancellation: aborts the in-flight attempt and any retry wait. */
  signal?: AbortSignal | undefined;
  /** `Accept` header override (default `application/json`). */
  accept?: string;
  /**
   * One of the eight read-only POSTs of SDK contract §1.2 — retried on
   * app-origin 502/503/504 when `retryReadOnlyPosts` is on.
   */
  idempotent?: boolean;
  /**
   * A free operation (0 credits: `/info`, webhook reads). A retry cannot
   * charge, so proxy-origin 5xx/520/524 and post-send transport errors are
   * retried too (SDK contract §1.2).
   */
  free?: boolean;
}

/** Context handed to a success handler; the attempt's inactivity timer is still running. */
export interface AttemptContext {
  /** Aborts when the attempt times out or the caller aborts. */
  signal: AbortSignal;
  /** The response (inactivity) timeout in ms. */
  timeoutMs: number;
  /** Restart the inactivity timer — call on every body chunk. */
  touch: () => void;
}

/**
 * Error codes of a transport failure where the request PROVABLY NEVER
 * REACHED THE SERVER (SDK contract §1.2): DNS failure, connection refused /
 * unreachable, connect timeout, TLS handshake failure. `fetch` cannot tell a connection closed
 * before the response from one closed mid-response (a reset, "other side
 * closed"), so those are NOT treated as never-reached: on a billed call they
 * surface as `NetworkError` instead of being retried.
 */
const NEVER_REACHED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  // TLS handshake failures — the request was never sent.
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Cloudflare: web server down / connection timed out / origin unreachable — never reached the app. */
const NEVER_REACHED_STATUSES = new Set([521, 522, 523]);
/** Statuses whose retry depends on origin (app vs proxy). */
const ORIGIN_DEPENDENT_STATUSES = new Set([502, 503, 504]);
/** Proxy-only statuses (Cloudflare unknown error / origin timeout): the app may have charged. */
const PROXY_STATUSES = new Set([520, 524]);

/** `true` when a transport error (or one of its causes) carries a never-reached-the-app code. */
export function isNeverReachedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NEVER_REACHED_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * App-origin response (SDK contract §1.2): it carries a non-empty
 * `X-LexAPI-Version` header (every app response, lex-api #299 on) or a
 * `RateLimit-Limit` header (the app's per-key rate limiter sets `RateLimit-*`
 * on every billable app response; proxies never do). A JSON body with an
 * `error` member is NOT enough on its own. Anything else is treated as
 * proxy-origin — unknown origin is never assumed to be the app.
 */
export function isAppOrigin(error: LexAPIError): boolean {
  return error.headers?.apiVersion !== undefined || error.headers?.rateLimit?.limit !== undefined;
}

/**
 * Browsers forbid setting the `User-Agent` header (and this SDK is
 * server-side only anyway — API keys are secrets). Only send the UA
 * header on non-browser runtimes.
 */
function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Single request core used by every SDK method.
 *
 * - `x-api-key` auth + `User-Agent: lexapi-typescript/<version>` on every
 *   request (UA omitted on browser runtimes, where it cannot be set). The key
 *   lives in a private field and never appears in `util.inspect`,
 *   `console.log` or `JSON.stringify` output.
 * - One inactivity timeout per attempt (SDK contract §1.6): it runs until
 *   the response head arrives and restarts on every body chunk, for JSON
 *   bodies and export streams alike.
 * - Caller `AbortSignal`: aborts the attempt and any retry wait; throws
 *   `RequestAbortedError`, never retried.
 * - Retries follow the billing-safety rule of SDK contract §1.2 — only when
 *   a retry cannot charge twice (see `shouldRetryStatus` and PLAN.md §1.2).
 * - Server-directed waits: `Retry-After` on any status; on a 429 only, then
 *   `RateLimit-Reset` and the JSON `retryAfter` field. `X-RateLimit-*` is
 *   never read.
 */
export class HttpClient {
  readonly #apiKey: string;
  private readonly opts: Omit<HttpClientOptions, "apiKey">;
  private readonly userAgent: string;

  constructor(opts: HttpClientOptions) {
    const { apiKey, ...rest } = opts;
    this.#apiKey = apiKey;
    this.opts = rest;
    this.userAgent = opts.userAgentSuffix
      ? `lexapi-typescript/${VERSION} ${opts.userAgentSuffix}`
      : `lexapi-typescript/${VERSION}`;
  }

  /** API base URL. */
  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** Client-level per-attempt timeout (ms). */
  get timeoutMs(): number {
    return this.opts.timeoutMs;
  }

  /** Redacted view for `JSON.stringify` — never includes the API key. */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.opts.baseUrl, apiKey: "[redacted]" };
  }

  /** Redacted view for `util.inspect` / `console.log`. */
  [INSPECT](): string {
    return `HttpClient { baseUrl: '${this.opts.baseUrl}', apiKey: '[redacted]' }`;
  }

  /** Perform a request and parse the JSON body (204 / empty body yields `{}`). */
  async requestJson<T>(options: RequestOptions): Promise<T> {
    const { data } = await this.requestJsonWithResponse<T>(options);
    return data;
  }

  /**
   * Like `requestJson`, but also exposes the raw `Response` (for header
   * signals). The body is read inside the attempt, under its timeout.
   */
  async requestJsonWithResponse<T>(options: RequestOptions): Promise<{ data: T; response: Response }> {
    return this.execute(options, async (response, ctx) => ({
      data: (await readJsonBody(response, ctx.touch)) as T,
      response,
    }));
  }

  /**
   * Perform a request and return the raw successful `Response` without
   * consuming the body (streaming endpoints such as `/export`). The attempt
   * timeout covers only the response headers; the caller applies its own
   * idle timeout to body reads. Non-2xx responses are parsed and thrown as
   * typed errors; the retry policy applies before the first body byte.
   */
  async requestRaw(options: RequestOptions): Promise<Response> {
    return this.execute(options, async (response) => response);
  }

  private async execute<R>(
    options: RequestOptions,
    onSuccess: (response: Response, ctx: AttemptContext) => Promise<R>,
  ): Promise<R> {
    const { method, path, query, body, signal } = options;
    const url = `${this.opts.baseUrl}${path}${buildQuery(query)}`;
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;
    const { maxRetries, baseDelayMs, maxDelayMs, retryReadOnlyPosts } = this.opts.retry;
    const isGet = method === "GET";
    const free = isGet && options.free === true;

    const headers: Record<string, string> = {
      "x-api-key": this.#apiKey,
      accept: options.accept ?? "application/json",
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
      throwIfAborted(signal, method, path);

      // §1.6: one inactivity timer per attempt — runs until the response
      // head arrives, then restarts on every body chunk (`touch`).
      const controller = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const touch = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      };
      touch();
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let error: LexAPIError;
      let response: Response | undefined;
      let retryTransport = false;
      try {
        response = await this.opts.fetchFn(url, {
          method,
          headers,
          ...(serializedBody !== undefined ? { body: serializedBody } : {}),
          signal: controller.signal,
        });
        touch();
        if (response.ok) {
          return await onSuccess(response, { signal: controller.signal, timeoutMs, touch });
        }
        error = await parseErrorResponse(response, touch);
      } catch (cause) {
        if (signal?.aborted) {
          throw new RequestAbortedError(`Request ${method} ${path} was aborted`, signal.reason);
        }
        if (cause instanceof LexAPIError && !timedOut) throw cause; // e.g. InvalidResponseError
        const failure = timedOut
          ? new TimeoutError(`No response bytes for ${timeoutMs}ms (${method} ${path})`, 0)
          : new NetworkError(
              response === undefined
                ? `Network error calling ${method} ${path}`
                : `Connection lost while reading the response to ${method} ${path}`,
              cause,
            );
        // §1.2: never reached the app → any method; after send → free calls only.
        const neverReached = !timedOut && response === undefined && isNeverReachedError(cause);
        retryTransport = attempt < maxRetries && (neverReached || free);
        if (!retryTransport) throw failure;
        error = failure;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      if (retryTransport) {
        await sleep(fullJitterBackoff(attempt, baseDelayMs, maxDelayMs), signal, method, path);
        continue;
      }
      if (attempt < maxRetries && shouldRetryStatus(error, { isGet, free, readOnly: options.idempotent === true && retryReadOnlyPosts })) {
        const waitMs =
          error.retryAfter !== undefined
            ? Math.min(error.retryAfter * 1000, maxDelayMs)
            : fullJitterBackoff(attempt, baseDelayMs, maxDelayMs);
        await sleep(waitMs, signal, method, path);
        continue;
      }
      throw error;
    }
  }
}

/** SDK contract §1.2 decision table for an HTTP error response. */
function shouldRetryStatus(
  error: LexAPIError,
  call: { isGet: boolean; free: boolean; readOnly: boolean },
): boolean {
  const status = error.status;
  if (status === 429) return !(error instanceof RateLimitedError && error.quotaExhausted);
  if (NEVER_REACHED_STATUSES.has(status)) return true;
  if (ORIGIN_DEPENDENT_STATUSES.has(status)) {
    if (isAppOrigin(error)) return call.isGet || call.readOnly;
    return call.free;
  }
  if (PROXY_STATUSES.has(status)) return call.free;
  return false;
}

/** Read a body as text, restarting the inactivity timer on every chunk. */
async function readBodyText(response: Response, touch?: () => void): Promise<string> {
  if (response.body === null || touch === undefined) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    touch();
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

/**
 * Read a JSON body (SDK contract §1.3): a 204 or an empty body is a
 * successful empty object; a non-empty non-JSON body is `InvalidResponseError`.
 */
async function readJsonBody(response: Response, touch?: () => void): Promise<unknown> {
  if (response.status === 204) return {};
  const text = await readBodyText(response, touch);
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidResponseError(
      `Expected a JSON body (HTTP ${response.status}, content-type ${response.headers.get("content-type") ?? "none"})`,
      response.status,
      text,
      { headers: parseResponseHeaders(response) },
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined, method: string, path: string): void {
  if (signal?.aborted) {
    throw new RequestAbortedError(`Request ${method} ${path} was aborted`, signal.reason);
  }
}

/** Parse a non-2xx response into the typed error hierarchy. */
export async function parseErrorResponse(response: Response, touch?: () => void): Promise<LexAPIError> {
  let body: unknown;
  try {
    const text = await readBodyText(response, touch);
    body = text.trim() === "" ? undefined : (JSON.parse(text) as unknown);
  } catch (cause) {
    // A body that is not JSON (proxy HTML/text) leaves `body` undefined; an
    // aborted or broken read (timeout / caller abort / reset) propagates.
    if (!(cause instanceof SyntaxError)) throw cause;
    body = undefined;
  }
  // §1.2 retry-after resolution, steps 1–2 (step 3, the JSON field, is
  // applied in fromResponse on a 429; a quota 429 drops the value).
  const hint =
    headerRetryAfterSeconds(response) ??
    (response.status === 429 ? resetHeaderSeconds(response, "ratelimit-reset") : undefined);
  return LexAPIError.fromResponse(response.status, body, hint, parseResponseHeaders(response));
}

/**
 * `Retry-After` header — delta-seconds or an HTTP-date (§1.2). Empty or
 * unparseable values count as absent; numbers go through the epoch guard.
 */
function headerRetryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const header = raw.trim();
  if (header === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(header)) return normalizeRetryAfterSeconds(Number(header));
  if (/^[-+]?\d/.test(header)) return undefined;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return undefined;
}

function resetHeaderSeconds(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return normalizeRetryAfterSeconds(seconds);
}

/** Full-jitter exponential backoff: `random() * min(cap, base * 2^attempt)`. */
function fullJitterBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
}

/** Sleep that a caller's `AbortSignal` interrupts (rejecting with `RequestAbortedError`). */
function sleep(ms: number, signal: AbortSignal | undefined, method: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAbortedError(`Request ${method} ${path} was aborted`, signal.reason));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RequestAbortedError(`Request ${method} ${path} was aborted during a retry wait`, signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function buildQuery(query?: QueryParams): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value as ReadonlyArray<string | number | boolean>) {
        params.append(key, String(item));
      }
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
