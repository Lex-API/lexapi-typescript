import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  HttpClient,
  type RetryOptions,
} from "./http.js";
import type { InfoResponse } from "./types.js";

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "./http.js";

export interface LexAPIOptions {
  /**
   * LexAPI key (`lex_...`). Falls back to the `LEXAPI_API_KEY` environment
   * variable when `process` exists. Keys are server-side secrets — never
   * ship them in client-side code.
   */
  apiKey?: string;
  /** API base URL. Defaults to production (`https://lex-api.com/api/v1`). */
  baseUrl?: string;
  /** Per-request timeout in milliseconds (per attempt). Default 60_000. */
  timeoutMs?: number;
  /** Injectable fetch (used for testing / polyfills). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Retry policy. Default: 3 retries, 500 ms base, 30 s cap. */
  retry?: RetryOptions;
  /** Optional suffix appended to the `User-Agent` header. */
  userAgentSuffix?: string;
}

/** Per-call overrides accepted by every SDK method. */
export interface CallOptions {
  /** Override the client-level timeout for this call only. */
  timeoutMs?: number;
}

/**
 * LexAPI client — European legal data, made queryable.
 *
 * Server-side only: API keys are secrets and browsers additionally forbid
 * setting the `User-Agent` header this SDK sends.
 *
 * ```ts
 * const client = new LexAPI({ apiKey: "lex_..." }); // or set LEXAPI_API_KEY
 * const info = await client.getInfo();
 * ```
 */
export class LexAPI {
  protected readonly http: HttpClient;

  constructor(options: LexAPIOptions = {}) {
    const apiKey =
      options.apiKey ??
      (typeof process !== "undefined" ? process.env["LEXAPI_API_KEY"] : undefined);
    if (!apiKey) {
      throw new Error("apiKey is required (or set LEXAPI_API_KEY)");
    }
    this.http = new HttpClient({
      apiKey,
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchFn: options.fetch ?? fetch,
      retry: {
        maxRetries: options.retry?.maxRetries ?? 3,
        baseDelayMs: options.retry?.baseDelayMs ?? 500,
        maxDelayMs: options.retry?.maxDelayMs ?? 30_000,
      },
      userAgentSuffix: options.userAgentSuffix,
    });
  }

  /**
   * `GET /info` — API capabilities, subscription tier, and current usage.
   * Free operation (0 credits); useful as a connection probe.
   */
  async getInfo(options?: CallOptions): Promise<InfoResponse> {
    return this.http.requestJson<InfoResponse>({
      method: "GET",
      path: "/info",
      timeoutMs: options?.timeoutMs,
    });
  }
}
