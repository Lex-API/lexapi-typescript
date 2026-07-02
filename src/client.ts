import { LexAPIError } from "./errors.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://lex-api.com/api/v1";

export interface LexAPIOptions {
  /** LexAPI key (`lex_...`). Falls back to `LEXAPI_API_KEY`. */
  apiKey?: string;
  /** API base URL. Defaults to production. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 60_000. */
  timeoutMs?: number;
  /** Injectable fetch (used for testing / polyfills). Defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Minimal LexAPI client scaffold (P0: GET /info). */
export class LexAPI {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: LexAPIOptions = {}) {
    const apiKey =
      options.apiKey ??
      (typeof process !== "undefined" ? process.env["LEXAPI_API_KEY"] : undefined);
    if (!apiKey) {
      throw new Error("apiKey is required (or set LEXAPI_API_KEY)");
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** GET /info — API capabilities, subscription tier, and current usage. */
  async getInfo(): Promise<Record<string, unknown>> {
    return this.request("GET", "/info");
  }

  private async request(method: string, path: string): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        "user-agent": `lexapi-typescript/${VERSION}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.ok) {
      return (await response.json()) as Record<string, unknown>;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const header = response.headers.get("retry-after");
    const headerRetryAfter =
      header !== null && !Number.isNaN(Number(header)) ? Number(header) : undefined;
    throw LexAPIError.fromResponse(response.status, body, headerRetryAfter);
  }
}
