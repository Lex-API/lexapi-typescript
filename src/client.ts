import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  HttpClient,
  type RetryOptions,
} from "./http.js";
import type {
  DocumentByUrlRequest,
  DocumentByUrlResponse,
  DocumentContentBatchRequest,
  DocumentContentBatchResponse,
  DocumentContentRequest,
  DocumentContentResponse,
  DocumentMetadataRequest,
  DocumentMetadataResponse,
  InfoResponse,
  RecentDocumentsParams,
  RecentDocumentsResponse,
  ResolveResponse,
  SearchRequest,
  SearchResponse,
} from "./types.js";

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

  /**
   * `POST /search` — search EUR-Lex with structured filters.
   *
   * At least one filter is required. Truncation and partial-result signals
   * are surfaced on the response rather than hidden: check `truncated` /
   * `truncatedAt` / `truncatedReason` (tier-capped pagination), `partial` /
   * `partialReason` (an upstream page timed out), `postFilteredBy`
   * (controller-side post-filter dropped rows — `"date"` means raising
   * `maxPages` widens recall), `ignoredDocumentTypes`, and `xWarning`
   * (the `X-Warning` response header, e.g. `maxPages` tier clamping).
   */
  async search(request: SearchRequest, options?: CallOptions): Promise<SearchResponse> {
    const { data, response } = await this.http.requestJsonWithResponse<SearchResponse>({
      method: "POST",
      path: "/search",
      body: request,
      timeoutMs: options?.timeoutMs,
    });
    return withHeaderSignals(data, response);
  }

  /**
   * `POST /documentContent` — fetch a single fully-parsed document by CELEX.
   *
   * Corpus-first with live-scrape fallback (`bypassCorpus: true` forces a
   * live read). Use `include`/`fields`/`articleId` to trim the payload.
   */
  async getDocument(
    request: DocumentContentRequest,
    options?: CallOptions,
  ): Promise<DocumentContentResponse> {
    return this.http.requestJson<DocumentContentResponse>({
      method: "POST",
      path: "/documentContent",
      body: request,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `POST /documentContent/batch` — fetch multiple documents in one request.
   *
   * The batch is clamped to the tier ceiling (FREE=1, STARTER=5,
   * PROFESSIONAL=20, BUSINESS=50). Clamping is surfaced, not silent: check
   * `trimmed` / `trimmedTo` / `trimmedReason` on the body and `xWarning`
   * (the `X-Warning` header). Per-CELEX failures are collected in `errors`
   * instead of aborting the batch.
   */
  async getDocumentsBatch(
    request: DocumentContentBatchRequest,
    options?: CallOptions,
  ): Promise<DocumentContentBatchResponse> {
    const { data, response } = await this.http.requestJsonWithResponse<DocumentContentBatchResponse>({
      method: "POST",
      path: "/documentContent/batch",
      body: request,
      timeoutMs: options?.timeoutMs,
    });
    return withHeaderSignals(data, response);
  }

  /**
   * `GET /documents/recent` — recently-published documents (last `days`
   * days, default 7). Page fetching is tier-clamped like `/search`;
   * `xWarning` carries the `X-Warning` header when clamping fired, and
   * `languageFilter` reports rows dropped by the language post-filter.
   */
  async getRecentDocuments(
    params: RecentDocumentsParams = {},
    options?: CallOptions,
  ): Promise<RecentDocumentsResponse> {
    const { data, response } = await this.http.requestJsonWithResponse<RecentDocumentsResponse>({
      method: "GET",
      path: "/documents/recent",
      query: {
        days: params.days,
        documentType: params.documentType,
        author: params.author,
        domain: params.domain,
        subdomain: params.subdomain,
        language: params.language,
        limit: params.limit,
      },
      timeoutMs: options?.timeoutMs,
    });
    return withHeaderSignals(data, response);
  }

  /**
   * `POST /documents/url` — fetch a document by any EUR-Lex URL. The
   * response is shaped like `getDocument` plus `sourceUrl` and
   * `extractedCelex` echo-backs.
   */
  async getDocumentByUrl(
    request: DocumentByUrlRequest,
    options?: CallOptions,
  ): Promise<DocumentByUrlResponse> {
    return this.http.requestJson<DocumentByUrlResponse>({
      method: "POST",
      path: "/documents/url",
      body: request,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `POST /documents/metadata` — metadata only (title, dates, ECLI/ELI,
   * keywords, subjects). Skips the body parse: significantly faster and
   * cheaper than `getDocument`.
   */
  async getDocumentMetadata(
    request: DocumentMetadataRequest,
    options?: CallOptions,
  ): Promise<DocumentMetadataResponse> {
    return this.http.requestJson<DocumentMetadataResponse>({
      method: "POST",
      path: "/documents/metadata",
      body: request,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `POST /resolve` — resolve any legal identifier (bare CELEX, EUR-Lex
   * URL, ELI URI, or ECLI) to the canonical CELEX plus access URLs.
   */
  async resolve(identifier: string, options?: CallOptions): Promise<ResolveResponse> {
    return this.http.requestJson<ResolveResponse>({
      method: "POST",
      path: "/resolve",
      body: { identifier },
      timeoutMs: options?.timeoutMs,
    });
  }
}

/**
 * Merge header-only signals into the parsed body so callers can't miss
 * them: `X-Warning` announces tier clamping (maxPages / batch size).
 */
function withHeaderSignals<T extends object>(data: T, response: Response): T {
  const warning = response.headers.get("x-warning");
  if (warning !== null && typeof data === "object" && data !== null) {
    return { ...data, xWarning: warning };
  }
  return data;
}
