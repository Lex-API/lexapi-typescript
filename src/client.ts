import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  HttpClient,
  type RetryOptions,
} from "./http.js";
import type {
  CitationEdgeParams,
  CitationExtractResponse,
  CitationNetworkParams,
  CitationNetworkResponse,
  CitationPathResponse,
  CitationStatsResponse,
  CitedByResponse,
  CitesResponse,
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
  RelatedDocumentsResponse,
  ResolveResponse,
  SearchRequest,
  SearchResponse,
  SemanticCaseLawSearchOptions,
  SemanticCaseLawSearchResponse,
  SemanticLegislationSearchResponse,
  SemanticSearchOptions,
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

  // ── Citations ─────────────────────────────────────────────────────

  /**
   * `POST /citations/extract` — crawl a document's EUR-Lex metadata page
   * for citations and persist them into the graph. Idempotent: an already
   * processed document returns immediately with `alreadyExtracted: true`.
   */
  async extractCitations(
    celexNumber: string,
    options?: CallOptions,
  ): Promise<CitationExtractResponse> {
    return this.http.requestJson<CitationExtractResponse>({
      method: "POST",
      path: "/citations/extract",
      body: { celexNumber },
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `GET /citations/cites/{celexNumber}` — documents this one cites
   * (outbound edges), grouped by target. The document must first have been
   * crawled via `extractCitations` to appear here.
   */
  async getCites(
    celexNumber: string,
    params: CitationEdgeParams = {},
    options?: CallOptions,
  ): Promise<CitesResponse> {
    return this.http.requestJson<CitesResponse>({
      method: "GET",
      path: `/citations/cites/${encodeURIComponent(celexNumber)}`,
      query: { citationType: params.citationType, limit: params.limit, offset: params.offset },
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `GET /citations/cited-by/{celexNumber}` — documents that cite this one
   * (inbound edges), grouped by source.
   */
  async getCitedBy(
    celexNumber: string,
    params: CitationEdgeParams = {},
    options?: CallOptions,
  ): Promise<CitedByResponse> {
    return this.http.requestJson<CitedByResponse>({
      method: "GET",
      path: `/citations/cited-by/${encodeURIComponent(celexNumber)}`,
      query: { citationType: params.citationType, limit: params.limit, offset: params.offset },
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `GET /citations/network/{celexNumber}` — inbound and outbound
   * neighbourhood in one call, paginated per direction.
   *
   * If the server-side wall-clock budget expires the endpoint still
   * returns 200 with `partial: true`, an EMPTY `network`, and `null`
   * paging totals — check `partial` before treating the network as empty.
   */
  async getCitationNetwork(
    celexNumber: string,
    params: CitationNetworkParams = {},
    options?: CallOptions,
  ): Promise<CitationNetworkResponse> {
    return this.http.requestJson<CitationNetworkResponse>({
      method: "GET",
      path: `/citations/network/${encodeURIComponent(celexNumber)}`,
      query: { citationType: params.citationType, limit: params.limit, offset: params.offset },
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `GET /citations/path/{from}/{to}` — shortest citation path (BFS over
   * outbound edges). `found: false` is a graceful HTTP 200, not an error.
   * Default `maxDepth` 3 (max 8); the visited set is bounded to 5000 nodes.
   */
  async getCitationPath(
    from: string,
    to: string,
    params: { maxDepth?: number } = {},
    options?: CallOptions,
  ): Promise<CitationPathResponse> {
    return this.http.requestJson<CitationPathResponse>({
      method: "GET",
      path: `/citations/path/${encodeURIComponent(from)}/${encodeURIComponent(to)}`,
      query: { maxDepth: params.maxDepth },
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `GET /citations/related/{celexNumber}` — bibliographic-coupling
   * neighbours (documents sharing the most outbound citation targets with
   * the seed). Returns a graceful empty list with `message` when the seed
   * has no outbound citations to couple on.
   */
  async getRelatedDocuments(
    celexNumber: string,
    params: { limit?: number } = {},
    options?: CallOptions,
  ): Promise<RelatedDocumentsResponse> {
    return this.http.requestJson<RelatedDocumentsResponse>({
      method: "GET",
      path: `/citations/related/${encodeURIComponent(celexNumber)}`,
      query: { limit: params.limit },
      timeoutMs: options?.timeoutMs,
    });
  }

  /** `GET /citations/stats` — global citation graph statistics. */
  async getCitationStats(options?: CallOptions): Promise<CitationStatsResponse> {
    return this.http.requestJson<CitationStatsResponse>({
      method: "GET",
      path: "/citations/stats",
      timeoutMs: options?.timeoutMs,
    });
  }

  // ── Semantic search ───────────────────────────────────────────────

  /**
   * `POST /search/semantic` — embedding-based semantic search over CJEU
   * case law. Use this (not `search`) for *concept* queries; EUR-Lex
   * keyword matching is literal.
   *
   * **Billing:** 5 credits per call — **15 credits with `hyde: true`**
   * (HyDE query rewriting: an LLM drafts the passage a relevant judgment
   * would contain and retrieval fuses both rankings; ~1–3 s extra
   * latency). HyDE is best-effort: on LLM failure the search falls back
   * to plain retrieval, the response reports `hyde: false`, and the
   * 10-credit premium is **refunded automatically** — verify via
   * `credits.operation_weight`.
   *
   * The response exposes `hint` (present only on low-confidence,
   * best-effort result sets — its presence is itself the signal), `hyde`
   * (whether HyDE actually ran), and `hypotheticalDocument` (the drafted
   * passage, present only when HyDE ran).
   *
   * Fewer results than `limit`? The upstream's ~0.7 default relevance
   * floor cut in — pass `minScore: 0.5` (or `0`) to widen recall.
   *
   * Persistent document identity is `(metadata.celex_id,
   * metadata.document_type)`; `case_id` is snapshot-scoped and does not
   * survive index rebuilds.
   */
  async semanticSearch(
    request: SemanticCaseLawSearchOptions,
    options?: CallOptions,
  ): Promise<SemanticCaseLawSearchResponse> {
    return this.http.requestJson<SemanticCaseLawSearchResponse>({
      method: "POST",
      path: "/search/semantic",
      body: semanticWireBody(request),
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `POST /legislation/semantic` — embedding-based semantic search over EU
   * legislation; results are article-level matches (`article_ref`,
   * `law_id`, `law_title`, `score`).
   *
   * Costs 5 credits. The `hyde` option is case-law only and is therefore
   * not accepted here (the server ignores it on this endpoint). The same
   * ~0.7 default relevance floor applies — lower `minScore` to widen
   * recall; `hint` is present only on low-confidence result sets.
   */
  async semanticLegislationSearch(
    request: SemanticSearchOptions,
    options?: CallOptions,
  ): Promise<SemanticLegislationSearchResponse> {
    return this.http.requestJson<SemanticLegislationSearchResponse>({
      method: "POST",
      path: "/legislation/semantic",
      body: semanticWireBody(request),
      timeoutMs: options?.timeoutMs,
    });
  }
}

/** Map camel-cased SDK semantic options to the wire shape (`min_score`, `include: ["text"]`). */
function semanticWireBody(
  request: SemanticSearchOptions & { hyde?: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = { query: request.query };
  if (request.limit !== undefined) body["limit"] = request.limit;
  if (request.minScore !== undefined) body["min_score"] = request.minScore;
  if (request.language !== undefined) body["language"] = request.language;
  if (request.includeText) body["include"] = ["text"];
  if (request.filters !== undefined) body["filters"] = request.filters;
  if (request.hyde !== undefined) body["hyde"] = request.hyde;
  return body;
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
