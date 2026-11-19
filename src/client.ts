import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  HttpClient,
  type RequestOptions,
  type RetryOptions,
} from "./http.js";
import { createExportStream, type ExportParams, type ExportStream } from "./export.js";
import { parseResponseHeaders } from "./headers.js";
import { REPEATS_BEFORE_THROW, compactForm, count, stalled, startingPosition } from "./paging.js";
import { WebhooksAPI } from "./webhooks.js";
import type {
  CitationEdgeParams,
  CitationExtractResponse,
  CitationFilterParams,
  CitationNetworkParams,
  CitationNetworkResponse,
  CitationPathParams,
  CitationPathResponse,
  CitationStatsParams,
  CitationStatsResponse,
  CitedDocumentGroup,
  CitingDocumentGroup,
  CitedByResponse,
  CitesParams,
  CitesResponse,
  CounterpartsParams,
  CounterpartsResponse,
  DocumentByUrlRequest,
  DocumentByUrlResponse,
  DocumentContentBatchRequest,
  DocumentContentBatchResponse,
  DocumentContentRequest,
  DocumentContentResponse,
  DocumentMetadataRequest,
  DocumentMetadataResponse,
  DocumentVersionResponse,
  DocumentAtDateResponse,
  DocumentVersionsResponse,
  InfoResponse,
  NationalCoverageResponse,
  NationalDocumentListParams,
  NationalDocumentListResponse,
  NationalDocumentResponse,
  NationalSemanticCaseLawOptions,
  NationalSemanticCaseLawResponse,
  NationalSemanticLegislationOptions,
  NationalSemanticLegislationResponse,
  RecentDocumentsParams,
  RecentDocumentsResponse,
  RelatedDocumentsParams,
  RelatedDocumentsResponse,
  ResolveResponse,
  SearchRequest,
  SearchResponse,
  SemanticCaseLawSearchOptions,
  SemanticCaseLawSearchResponse,
  SemanticLegislationSearchOptions,
  SemanticLegislationSearchResponse,
  LegislationAsOfRequest,
  LegislationAsOfResponse,
  TranspositionParams,
  TranspositionResponse,
  VersionParams,
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
  /**
   * Per-attempt timeout in milliseconds, covering the response body (for
   * `export`: an idle timeout per read). The 95 s default sits above the
   * API's 90 s deadline on document reads, so that timeout comes back as a
   * typed, refunded 504; the CDN ends any wait at 100 s.
   */
  timeoutMs?: number;
  /**
   * Injectable fetch (used for testing / polyfills). Defaults to global fetch.
   * It is called with `redirect: "manual"` and must honour it: the SDK follows
   * redirects itself, and only within the API origin.
   */
  fetch?: typeof fetch;
  /** Retry policy. Default: 3 retries, 500 ms base, 30 s cap; read-only POST 5xx retries are opt-in. */
  retry?: RetryOptions;
  /** Optional suffix appended to the `User-Agent` header. */
  userAgentSuffix?: string;
}

/** Per-call overrides accepted by every SDK method. */
export interface CallOptions {
  /** Override the client-level timeout for this call only (per attempt, covering the response body). */
  timeoutMs?: number;
  /**
   * Cancel the call: aborts the in-flight request, any retry wait and (for
   * `export`) the stream. Rejects with `RequestAbortedError`; never retried.
   */
  signal?: AbortSignal;
}

/**
 * LexAPI client — European legal data, made queryable.
 *
 * Server-side only: API keys are secrets and browsers additionally forbid
 * setting the `User-Agent` header this SDK sends.
 *
 * Every JSON result carries the raw `subscription` / `usage` / `credits`
 * blocks plus an SDK-added `headers` object (`X-Source`, rate limits,
 * `X-Warning`, …) — see `ResponseHeaders`.
 *
 * ```ts
 * const client = new LexAPI({ apiKey: "lex_..." }); // or set LEXAPI_API_KEY
 * const info = await client.getInfo();
 * ```
 */
export class LexAPI {
  protected readonly http: HttpClient;

  /** Webhook subscriptions (`client.webhooks.list/create/get/update/delete/test/deliveries`). */
  readonly webhooks: WebhooksAPI;

  constructor(options: LexAPIOptions = {}) {
    const apiKey =
      options.apiKey ??
      (typeof process !== "undefined" ? process.env["LEXAPI_API_KEY"] : undefined);
    if (!apiKey) {
      throw new Error("apiKey is required (or set LEXAPI_API_KEY)");
    }
    if (options.fetch === undefined && typeof globalThis.fetch !== "function") {
      throw new Error("This runtime has no global fetch; pass one with the `fetch` option");
    }
    this.http = new HttpClient({
      apiKey,
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Looked up per call and invoked on the global object, which Cloudflare
      // Workers and browsers require.
      fetchFn: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      retry: {
        maxRetries: options.retry?.maxRetries ?? 3,
        baseDelayMs: options.retry?.baseDelayMs ?? 500,
        maxDelayMs: options.retry?.maxDelayMs ?? 30_000,
        retryReadOnlyPosts: options.retry?.retryReadOnlyPosts ?? false,
      },
      userAgentSuffix: options.userAgentSuffix,
    });
    this.webhooks = new WebhooksAPI(this.http);
  }

  /** Redacted view for `JSON.stringify` — never includes the API key. */
  toJSON(): Record<string, unknown> {
    return { client: "LexAPI", http: this.http.toJSON() };
  }

  /** Redacted view for `util.inspect` / `console.log` — never includes the API key. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `LexAPI { baseUrl: '${this.http.baseUrl}', apiKey: '[redacted]' }`;
  }

  /** Perform a JSON request and attach the parsed response headers (+ legacy header fields). */
  private async call<T extends object>(
    options: RequestOptions,
    extra: { corpusVersion?: boolean } = {},
  ): Promise<T> {
    const { data, response } = await this.http.requestJsonWithResponse<T>(options);
    return withHeaders(data, response, extra.corpusVersion === true);
  }

  /**
   * `GET /info` — API capabilities, subscription tier, and current usage.
   * Free operation (0 credits); useful as a connection probe.
   */
  async getInfo(options?: CallOptions): Promise<InfoResponse> {
    return this.call<InfoResponse>({
      method: "GET",
      path: "/info",
      free: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /search` — search EUR-Lex with structured filters.
   *
   * **Cost: 3 credits per result page** (`maxPages`, tier-clamped), charged
   * upfront and refunded for pages never fetched; a search that fails
   * before its first page is refunded in full. Identical searches within
   * 60 minutes are served from a result cache (`headers.searchCache: "hit"`,
   * same price) — pass `fresh: true` to force a re-fetch.
   *
   * At least one filter is required. Truncation and partial-result signals
   * are surfaced, not hidden: `truncated` / `truncatedAt` / `truncatedReason`
   * (tier-capped pagination), `partial` / `partialReason` (an upstream page
   * timed out, or `source: "corpus"` — EUR-Lex unreachable, answered from
   * the corpus mirror), `postFilteredBy` (`"date"` → raise `maxPages`),
   * `ignoredDocumentTypes`, `hint` (zero results → try semantic search), and
   * `xWarning` (the `X-Warning` header, e.g. `maxPages` clamped).
   */
  async search(request: SearchRequest, options?: CallOptions): Promise<SearchResponse> {
    return this.call<SearchResponse>({
      method: "POST",
      path: "/search",
      shape: { lists: ["results"], required: ["results"] },
      body: request,
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /documentContent` — fetch a single fully-parsed document by CELEX.
   *
   * **Cost: 5 credits, settled by source** — 1 from the LexAPI corpus
   * (`headers.source === "corpus"`), 4 from the Publications Office Cellar
   * API (`"cellar"` / `"cellar-oj"`), 5 for a browser fetch (`"live"`).
   *
   * Check `document.textAvailability.available` before reading
   * `document.content`: a document whose text EUR-Lex does not publish is a
   * 200 with metadata and `content: null` (billed 1 credit), with the reason
   * and — for base acts — a pointer to the consolidated version. Use
   * `language` / `acceptLanguages` for other renditions and
   * `include`/`fields`/`articleId` to trim the payload.
   */
  async getDocument(
    request: DocumentContentRequest,
    options?: CallOptions,
  ): Promise<DocumentContentResponse> {
    return this.call<DocumentContentResponse>({
      method: "POST",
      path: "/documentContent",
      shape: { fields: [{ path: "document", kind: "object" }], optionalObjects: ["document.content"], lists: ["document.content.articles"] },
      body: request,
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /documentContent/batch` — fetch multiple documents in one request.
   *
   * **Cost: 5 credits per processed item, settled by source** (corpus 1,
   * Cellar / OJ 4, browser 5; `headers.batch` has the source counts). The
   * batch is clamped to the tier ceiling (FREE=1, STARTER=5,
   * PROFESSIONAL=20, BUSINESS+=50); trimmed items are not charged. Clamping
   * is surfaced: `trimmed` / `trimmedTo` / `trimmedReason` and `xWarning`.
   * Per-CELEX failures are collected in `errors`; text-unavailable items
   * stay in `documents` (counted in `textUnavailable`).
   */
  async getDocumentsBatch(
    request: DocumentContentBatchRequest,
    options?: CallOptions,
  ): Promise<DocumentContentBatchResponse> {
    return this.call<DocumentContentBatchResponse>({
      method: "POST",
      path: "/documentContent/batch",
      shape: { lists: ["documents", "errors"] },
      body: request,
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /documents/recent` — recently-published documents (last `days`
   * days, default 7; up to `limit`, default 50).
   *
   * **Cost: 3 credits per result page** (~10 results each, tier-capped);
   * unfiltered requests are answered from Cellar in one query
   * (`headers.source === "cellar"`) and settle at a single page. `author`
   * arrays are sent as repeated query parameters; `documentType` and
   * `subdomain` take ONE value — EUR-Lex applies only the first of several
   * on this path (use `search` for multi-type / multi-subdomain queries). `languageFilter`
   * reports rows dropped by the language post-filter.
   */
  async getRecentDocuments(
    params: RecentDocumentsParams = {},
    options?: CallOptions,
  ): Promise<RecentDocumentsResponse> {
    return this.call<RecentDocumentsResponse>({
      method: "GET",
      path: "/documents/recent",
      shape: { lists: ["results"] },
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
      signal: options?.signal,
    });
  }

  /**
   * `POST /documents/url` — fetch a document by any EUR-Lex URL. Shaped like
   * `getDocument` plus `sourceUrl` and `extractedCelex` echo-backs. Same
   * settle-by-source pricing (corpus 1, Cellar 4, browser 5).
   */
  async getDocumentByUrl(
    request: DocumentByUrlRequest,
    options?: CallOptions,
  ): Promise<DocumentByUrlResponse> {
    return this.call<DocumentByUrlResponse>({
      method: "POST",
      path: "/documents/url",
      shape: { fields: [{ path: "document", kind: "object" }], optionalObjects: ["document.content"], lists: ["document.content.articles"] },
      body: request,
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /documents/metadata` — metadata only (title, dates, ECLI/ELI,
   * keywords, subjects, URLs). Skips the body parse: faster than
   * `getDocument`. **Cost: 5 credits, settled by source** (corpus 1, Cellar 4).
   */
  async getDocumentMetadata(
    request: DocumentMetadataRequest,
    options?: CallOptions,
  ): Promise<DocumentMetadataResponse> {
    return this.call<DocumentMetadataResponse>({
      method: "POST",
      path: "/documents/metadata",
      body: request,
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /resolve` — resolve any legal identifier (bare CELEX, EUR-Lex
   * URL, ELI URI, or ECLI) to the canonical CELEX plus access URLs.
   * 1 credit. ECLIs (and unmappable ELIs) resolve via the corpus
   * (`resolvedVia: "ecli-corpus"` / `"eli-corpus"`).
   */
  async resolve(identifier: string, options?: CallOptions): Promise<ResolveResponse> {
    return this.call<ResolveResponse>({
      method: "POST",
      path: "/resolve",
      body: { identifier },
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  // ── Point-in-time versions ────────────────────────────────────────
  // Versions are LexAPI's fetch snapshots (content-hash changes between
  // fetches), NOT the law in force on a date; history begins at first
  // ingestion. For the version of an EU act for a date, use legislationAsOf.

  /**
   * `GET /documents/{celex}/versions` — version history, newest first,
   * current version included and flagged. These are LexAPI's fetch
   * snapshots, not the law in force on a date; for the version of an EU act
   * for a date use `legislationAsOf`. 1 credit.
   */
  async listDocumentVersions(
    celex: string,
    params: VersionParams = {},
    options?: CallOptions,
  ): Promise<DocumentVersionsResponse> {
    return this.call<DocumentVersionsResponse>({
      method: "GET",
      path: `/documents/${encodeURIComponent(celex)}/versions`,
      shape: { lists: ["versions"] },
      query: { language: params.language },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /documents/{celex}/versions/{version}` — one immutable snapshot
   * including `parsedContent`. `corpusVersion` mirrors the
   * `X-Corpus-Version` response header. This is one of LexAPI's fetch
   * snapshots, not the law in force on a date; for the version of an EU act
   * for a date use `legislationAsOf`. 1 credit.
   */
  async getDocumentVersion(
    celex: string,
    version: number,
    params: VersionParams = {},
    options?: CallOptions,
  ): Promise<DocumentVersionResponse> {
    return this.call<DocumentVersionResponse>({
      method: "GET",
      path: `/documents/${encodeURIComponent(celex)}/versions/${version}`,
      shape: { fields: [{ path: "document", kind: "object" }] },
      query: { language: params.language },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    }, { corpusVersion: true });
  }

  /**
   * `GET /documents/{celex}/at/{date}` — the snapshot LexAPI held as current
   * at the end of `date` (`YYYY-MM-DD`, UTC), from its own fetch history
   * (`kind: "observation_snapshot"`). This is not the law in force on that
   * date: for the version of an EU act for a date use `legislationAsOf`
   * (`inForceLookup` points to it). The snapshot was the current one from
   * `document.observedFrom` until `document.observedUntil` (`null` for the
   * current version). A future date returns the current version with
   * `dateInFuture: true`.
   *
   * A date before the document entered the corpus rejects with
   * `NotFoundError` where `beforeTracking` is `true` (`trackedSince`); a date
   * next to a version stored before API 2.28.0 whose start LexAPI has no
   * record of rejects with `boundaryUnknown` `true` and `candidates`
   * (refunded). 1 credit.
   */
  async getDocumentAtDate(
    celex: string,
    date: string,
    params: VersionParams = {},
    options?: CallOptions,
  ): Promise<DocumentAtDateResponse> {
    return this.call<DocumentAtDateResponse>({
      method: "GET",
      path: `/documents/${encodeURIComponent(celex)}/at/${encodeURIComponent(date)}`,
      shape: { fields: [{ path: "document", kind: "object" }] },
      query: { language: params.language },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    }, { corpusVersion: true });
  }

  // ── Citations ─────────────────────────────────────────────────────

  /**
   * `POST /citations/extract` — crawl a document's EUR-Lex metadata page
   * for citations and persist them into the graph. Idempotent: an already
   * processed document returns `alreadyExtracted: true`. 5 credits,
   * refunded to 1 on `alreadyExtracted`.
   */
  async extractCitations(
    celexNumber: string,
    options?: CallOptions,
  ): Promise<CitationExtractResponse> {
    return this.call<CitationExtractResponse>({
      method: "POST",
      path: "/citations/extract",
      shape: { lists: ["citations"] },
      body: { celexNumber },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /citations/cites/{celexNumber}` — documents this one cites
   * (outbound edges), grouped by target. The document must first have been
   * crawled via `extractCitations` to appear here. 1 credit.
   *
   * `celexNumber` may be a national document id (e.g. `AT-NOR-10001597`);
   * `params.includeNational` also pulls in national neighbours of live
   * jurisdictions — BUSINESS, SCALE and ENTERPRISE only (`403
   * TierForbiddenError` below that, refunded in full). A national id whose
   * jurisdiction is not live is `404 NotFoundError`.
   *
   * Filters (API 2.11.0): `citationType`, `provenance`, `jurisdictions` and
   * `resolution` each take one value or a list (sent comma-separated). On a
   * national id, `unresolved: true` also returns the references the
   * document records that could not be turned into an edge
   * (`unresolved` / `unresolvedTruncated`), at no extra cost.
   */
  async getCites(
    celexNumber: string,
    params: CitesParams = {},
    options?: CallOptions,
  ): Promise<CitesResponse> {
    return this.call<CitesResponse>({
      method: "GET",
      path: `/citations/cites/${encodeURIComponent(celexNumber)}`,
      shape: { lists: ["cites", "unresolved"] },
      query: { ...edgeQuery(params), unresolved: params.unresolved },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /citations/cited-by/{celexNumber}` — documents that cite this one
   * (inbound edges), grouped by source. 1 credit. For legislation, inbound
   * amendment / corrigendum / repeal edges are refreshed from Cellar when
   * older than 7 days (waits ≤ ~2.5 s) — see `relationSync`.
   *
   * `celexNumber` may be a national document id; `params.includeNational`
   * also pulls in national neighbours of live jurisdictions — BUSINESS+
   * only (`403 TierForbiddenError` below that). Filters as on `getCites`.
   */
  async getCitedBy(
    celexNumber: string,
    params: CitationEdgeParams = {},
    options?: CallOptions,
  ): Promise<CitedByResponse> {
    return this.call<CitedByResponse>({
      method: "GET",
      path: `/citations/cited-by/${encodeURIComponent(celexNumber)}`,
      shape: { lists: ["citedBy"] },
      query: edgeQuery(params),
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * Walk every page of `getCites` (offset in edge rows) until a short or
   * empty page (SDK contract §1.4). Each page is a billed call (1 credit).
   * Edges are ordered by extraction time only, so edges extracted at the
   * same instant or during the walk can shift: an edge may repeat or be
   * missed. A target's edges can straddle a page boundary, so the same
   * `celexNumber` may appear in two consecutive pages — merge by
   * `celexNumber` if you need one group per document.
   * The walk also ends once the offset reaches `totalEdges`, when that is a
   * non-negative integer. It throws `InvalidResponseError` when a page echoes
   * an `offset` other than the one requested, or, when the answers carry
   * neither `totalEdges` nor `offset`, after three pages in a row that each
   * repeat the one before (comparing the list only; a page with either
   * signal ends a run). When a walk throws, the pages already yielded stay
   * valid; the page that showed the stall is not yielded and is on the
   * error's `body`. A starting `offset` or `limit` that is not a non-negative
   * (positive) integer is a `RangeError` before any request.
   */
  async *paginateCites(
    celexNumber: string,
    params: CitesParams = {},
    options?: CallOptions,
  ): AsyncGenerator<CitesResponse, void> {
    yield* paginateEdges((p) => this.getCites(celexNumber, p, options), (page) => page.cites, params);
  }

  /**
   * Walk every page of `getCitedBy` (offset in edge rows) until a short or
   * empty page (SDK contract §1.4). Each page is a billed call (1 credit);
   * edges may repeat or be missed if extractions happen during the walk. A source's edges can straddle a page boundary, so the same
   * `celexNumber` may appear in two consecutive pages.
   * The walk also ends once the offset reaches `totalEdges`, when that is a
   * non-negative integer. It throws `InvalidResponseError` when a page echoes
   * an `offset` other than the one requested, or, when the answers carry
   * neither `totalEdges` nor `offset`, after three pages in a row that each
   * repeat the one before (comparing the list only; a page with either
   * signal ends a run). When a walk throws, the pages already yielded stay
   * valid; the page that showed the stall is not yielded and is on the
   * error's `body`. A starting `offset` or `limit` that is not a non-negative
   * (positive) integer is a `RangeError` before any request.
   */
  async *paginateCitedBy(
    celexNumber: string,
    params: CitationEdgeParams = {},
    options?: CallOptions,
  ): AsyncGenerator<CitedByResponse, void> {
    yield* paginateEdges((p) => this.getCitedBy(celexNumber, p, options), (page) => page.citedBy, params);
  }

  /**
   * `GET /citations/network/{celexNumber}` — inbound and outbound
   * neighbourhood in one call, paginated per direction. 20 credits.
   *
   * If the server-side wall-clock budget expires the endpoint still
   * returns 200 with `partial: true`, an EMPTY `network`, and `null`
   * paging totals — check `partial` before treating the network as empty.
   *
   * `celexNumber` may be a national document id; `params.includeNational`
   * also pulls in national neighbours of live jurisdictions — BUSINESS+
   * only (`403 TierForbiddenError` below that). See `getCites`.
   */
  async getCitationNetwork(
    celexNumber: string,
    params: CitationNetworkParams = {},
    options?: CallOptions,
  ): Promise<CitationNetworkResponse> {
    return this.call<CitationNetworkResponse>({
      method: "GET",
      path: `/citations/network/${encodeURIComponent(celexNumber)}`,
      shape: { lists: ["network.cites", "network.citedBy", "unresolved"] },
      query: {
        ...filterQuery(params),
        limit: params.limit,
        offset: params.offset,
        language: params.language,
        includeNational: params.includeNational,
        unresolved: params.unresolved,
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /citations/path/{from}/{to}` — shortest citation path (BFS over
   * outbound edges). 20 credits. `found: false` is a graceful HTTP 200,
   * not an error. Default `maxDepth` 3 (max 8); the visited set is bounded
   * to 5000 nodes.
   *
   * `from`/`to` may be national document ids; `params.includeNational` also
   * follows national documents of live jurisdictions along the way —
   * BUSINESS+ only (`403 TierForbiddenError` below that). See `getCites`.
   */
  async getCitationPath(
    from: string,
    to: string,
    params: CitationPathParams = {},
    options?: CallOptions,
  ): Promise<CitationPathResponse> {
    return this.call<CitationPathResponse>({
      method: "GET",
      path: `/citations/path/${encodeURIComponent(from)}/${encodeURIComponent(to)}`,
      shape: { lists: ["path"] },
      query: {
        ...filterQuery(params),
        maxDepth: params.maxDepth,
        language: params.language,
        includeNational: params.includeNational,
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /citations/related/{celexNumber}` — bibliographic-coupling
   * neighbours (documents sharing the most outbound citation targets with
   * the seed). 20 credits. Returns a graceful empty list with `message`
   * when the seed has no outbound citations to couple on.
   *
   * `celexNumber` may be a national document id; `params.includeNational`
   * also considers national documents of live jurisdictions — BUSINESS+
   * only (`403 TierForbiddenError` below that). See `getCites`.
   */
  async getRelatedDocuments(
    celexNumber: string,
    params: RelatedDocumentsParams = {},
    options?: CallOptions,
  ): Promise<RelatedDocumentsResponse> {
    return this.call<RelatedDocumentsResponse>({
      method: "GET",
      path: `/citations/related/${encodeURIComponent(celexNumber)}`,
      shape: { lists: ["related"] },
      query: {
        ...filterQuery(params),
        limit: params.limit,
        language: params.language,
        includeNational: params.includeNational,
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /citations/stats` — global citation graph statistics. 20 credits.
   *
   * `params.includeNational` also counts national documents of live
   * jurisdictions — BUSINESS+ only (`403 TierForbiddenError` below that).
   *
   * **Back-compat:** 0.2.0's signature was `getCitationStats(options?:
   * CallOptions)`. Both the single-argument form (`getCitationStats({
   * timeoutMs, signal })`) and the current two-argument form
   * (`getCitationStats(params, options)`) keep working — overloaded here so
   * TypeScript callers on either shape type-check, and a first argument
   * that looks like `CallOptions` rather than `CitationStatsParams` is also
   * detected at runtime (for a non-literal variable or a JS caller, which
   * the overloads alone can't catch) and honoured as the per-call options
   * rather than silently read as `params` with the timeout or abort signal
   * dropped.
   */
  async getCitationStats(options?: CallOptions): Promise<CitationStatsResponse>;
  async getCitationStats(params: CitationStatsParams, options?: CallOptions): Promise<CitationStatsResponse>;
  async getCitationStats(
    params?: CitationStatsParams | CallOptions,
    options?: CallOptions,
  ): Promise<CitationStatsResponse> {
    // Back-compat: 0.2.0's signature was
    // `getCitationStats(options?: CallOptions)`. A caller passing a single
    // argument shaped like `CallOptions` (`{ timeoutMs }` / `{ signal }`,
    // and nothing from `CitationStatsParams`) is honoured as `options`, not
    // silently read as `params` with the timeout/signal dropped — this
    // can't be caught at the type level (TS object literals get an excess-
    // property error, but a non-literal variable or a JS caller wouldn't).
    let effectiveParams: CitationStatsParams | undefined;
    let effectiveOptions: CallOptions | undefined;
    if (isLegacyCitationStatsCallOptions(params)) {
      effectiveOptions = params;
    } else {
      effectiveParams = params;
      effectiveOptions = options;
    }
    return this.call<CitationStatsResponse>({
      method: "GET",
      path: "/citations/stats",
      shape: { lists: ["stats.mostCited", "stats.mostCiting"] },
      query: { includeNational: effectiveParams?.includeNational },
      timeoutMs: effectiveOptions?.timeoutMs,
      signal: effectiveOptions?.signal,
    });
  }

  /**
   * `GET /citations/transposition/{celexNumber}` — the measures the member
   * states notified to the Commission for an EU act (CELEX sector 3),
   * grouped by country, from the Publications Office's Cellar records of the
   * notifications (API 2.11.0). **A notification is not a finding that the
   * measure transposes the act, or transposes it completely** — `note` says
   * so on every answer. 5 credits, every plan; a 5xx is refunded.
   *
   * On BUSINESS, SCALE and ENTERPRISE, for live jurisdictions, the answer
   * also says which measures LexAPI holds (`id`, `resolved`, `resolution`,
   * `resolutionBasis`, `counts.resolved`, `source.lanes`) and adds the
   * documents whose national source records that they transpose or
   * implement the act (`provenance: "source"`); `resolvedOnly: true` keeps
   * only the held ones. Below BUSINESS, for a jurisdiction that is not live,
   * and while the national-source terms are not accepted (`termsRequired:
   * true` — never a 403) those fields are `null`.
   *
   * A CELEX that is not an EU act (sector 3) is `404 NotFoundError`.
   */
  async getTransposition(
    celexNumber: string,
    params: TranspositionParams = {},
    options?: CallOptions,
  ): Promise<TranspositionResponse> {
    return this.call<TranspositionResponse>({
      method: "GET",
      path: `/citations/transposition/${encodeURIComponent(celexNumber)}`,
      shape: { lists: ["jurisdictions"] },
      query: {
        jurisdictions: listParam(params.jurisdictions),
        resolvedOnly: params.resolvedOnly,
        language: params.language,
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /citations/counterparts/{id}` — a national document's counterparts
   * in the other live jurisdictions, through the EU acts it transposes or
   * implements (API 2.11.0). Each `via[]` entry is one EU act, with the
   * other jurisdictions' measures for it ranked `1` (the national source
   * records the relation), `2` (a notified measure LexAPI holds) or `3` (a
   * notified Cellar record LexAPI does not hold, `id: null`). An EU act
   * CELEX as `id` lists its own measures the same way.
   *
   * **20 credits; BUSINESS, SCALE and ENTERPRISE only** (`403
   * TierForbiddenError` below that, refunded). A lookup past its 20-second
   * server-side budget throws `TimeoutError` (503, `err.partial === true`),
   * refunded. The SDK does not retry it (the same lookup would hit the same
   * budget); retry yourself, or narrow with `jurisdictions`.
   */
  async getCounterparts(
    id: string,
    params: CounterpartsParams = {},
    options?: CallOptions,
  ): Promise<CounterpartsResponse> {
    return this.call<CounterpartsResponse>({
      method: "GET",
      path: `/citations/counterparts/${encodeURIComponent(id)}`,
      shape: { lists: ["via"] },
      query: {
        jurisdictions: listParam(params.jurisdictions),
        language: params.language,
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  // ── National law ──────────────────────────────────────────────────
  // Member-state (and non-EU) legal orders alongside EUR-Lex. BUSINESS and
  // above get full access; FREE/STARTER/PROFESSIONAL get it within a
  // monthly allowance of national calls (`X-National-Limit`/
  // `X-National-Remaining`/`X-National-Reset`, `result.headers.nationalAllowance`;
  // a used-up allowance is `NationalAllowanceExhaustedError`, 402). An
  // unlaunched or unknown jurisdiction answers 404 exactly like a path that
  // doesn't exist — call `getNationalCoverage()` first.

  /**
   * `GET /national/coverage` — which jurisdictions are live, what each one
   * covers (legislation / case law, semantic search, sources with their
   * attribution), and when each was last synced. Public: no API key or
   * allowance required, free.
   */
  async getNationalCoverage(options?: CallOptions): Promise<NationalCoverageResponse> {
    return this.call<NationalCoverageResponse>({
      method: "GET",
      path: "/national/coverage",
      shape: { lists: ["jurisdictions"] },
      free: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /{jurisdiction}/documents/{id}` — one national document by its
   * corpus id (e.g. `"AT-NOR-12345"`), analogous to `getDocument`.
   *
   * **Cost: 1 credit** — every national read is a corpus read (there is no
   * live-fetch fallback), so the 5-credit upfront reservation always
   * settles to 1 (an unknown id too). Check
   * `document.textAvailability.available` before reading `content`, and
   * always show `document.attribution` to the user alongside the text.
   * The document has one shape for every jurisdiction (API 2.8.0):
   * `documentKind` (`act` | `decision`), `decision` (court, chamber,
   * caseNumbers, citedNorms — `null` for acts; see `isNationalDecision`)
   * and the closed `content` key set.
   *
   * A document its source withdrew (a takedown, a pseudonymisation fix)
   * throws `DocumentWithdrawnError` (410) instead of answering — nothing of
   * it is served, not even the title; drop any copy you hold.
   */
  async getNationalDocument(
    jurisdiction: string,
    id: string,
    params: { language?: string } = {},
    options?: CallOptions,
  ): Promise<NationalDocumentResponse> {
    return this.call<NationalDocumentResponse>({
      method: "GET",
      path: `/${jurisdictionSegment(jurisdiction)}/documents/${encodeURIComponent(id)}`,
      shape: { fields: [{ path: "document", kind: "object" }], optionalObjects: ["document.content"], lists: ["document.content.articles"] },
      query: { language: params.language },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `GET /{jurisdiction}/documents` — browse a jurisdiction's corpus by
   * title (`q`), type, and in-force status. Newest-first by the document's
   * own date.
   *
   * **Cost: 3 credits per call** — flat; pagination does not multiply the
   * price, unlike `search`. **Paging:** `page` only reaches the first 1,000
   * rows (a 400 past that); page further with `cursor` (each response's
   * `nextCursor`), which works at any depth — see
   * `paginateNationalDocuments` for a ready-made walk. A slow page is a
   * retry-safe `TimeoutError` (504, refunded); the `total` count is capped
   * at 10,000 and flagged `totalExact: false` past that or on a slow count.
   */
  async listNationalDocuments(
    jurisdiction: string,
    params: NationalDocumentListParams = {},
    options?: CallOptions,
  ): Promise<NationalDocumentListResponse> {
    return this.call<NationalDocumentListResponse>({
      method: "GET",
      path: `/${jurisdictionSegment(jurisdiction)}/documents`,
      shape: { lists: ["results"] },
      query: {
        page: params.page,
        cursor: params.cursor,
        limit: params.limit,
        q: params.q,
        type: params.documentType,
        includeRepealed: params.includeRepealed,
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * Walk every page of `listNationalDocuments` via `cursor` (works past the
   * 1,000-row `page` ceiling, unlike passing `page` yourself). Each page is
   * a separate billed call. Stops after a page whose `hasMore` is not `true`,
   * whose `nextCursor` is absent, `null` or empty, or that is empty. A
   * `nextCursor` the walk already sent, or one that is not a string, throws
   * `InvalidResponseError`; the pages already yielded stay valid, and the
   * page that showed the stall is not yielded and is on the error's `body`.
   * Any `params.page` is ignored and never sent — pass
   * `params.cursor` only to resume a walk you saved partway through;
   * `page` together with `cursor` is a 400 ("Use either cursor or page,
   * not both"), so this strips `page` at runtime, not just in the type
   * (`Omit` alone only guards TypeScript callers — a JS caller, or one
   * using `as`, could otherwise still pass it through).
   */
  async *paginateNationalDocuments(
    jurisdiction: string,
    params: Omit<NationalDocumentListParams, "page"> = {},
    options?: CallOptions,
  ): AsyncGenerator<NationalDocumentListResponse, void> {
    const { page: _ignoredPage, ...rest } = params as NationalDocumentListParams;
    let cursor = rest.cursor;
    const sent = new Set<string>();
    for (;;) {
      if (typeof cursor === "string") sent.add(cursor);
      const page = await this.listNationalDocuments(
        jurisdiction,
        cursor !== undefined ? { ...rest, cursor } : { ...rest },
        options,
      );
      const results: unknown = page.results;
      const next: unknown = page.nextCursor;
      const ends =
        page.hasMore !== true || next === undefined || next === null || next === "" || !Array.isArray(results) || results.length === 0;
      if (!ends) {
        // The page that shows the stall is not yielded; it is on the error's `body`.
        if (typeof next !== "string") throw stalled("the server sent a page cursor that is not a string", page);
        if (sent.has(next)) throw stalled("the server repeated a page cursor", page);
      }
      yield page;
      if (ends) return;
      cursor = next as string;
    }
  }

  /**
   * `POST /{jurisdiction}/search/semantic` — embedding-based semantic
   * search over a jurisdiction's case law. Same request/response shape as
   * `semanticSearch`, plus `jurisdiction`/`documentId`/`attribution` and
   * `document` (the matched decision as the listing returns it — the same
   * fields in every jurisdiction, API 2.8.0) on every hit.
   *
   * **Cost: a flat 5 credits** — `hyde` is accepted but never changes the
   * price or the billing tier here: the national index never rewrites, so
   * the response reports `hyde: false` (never `true`) when requested.
   */
  async nationalSemanticSearch(
    jurisdiction: string,
    request: NationalSemanticCaseLawOptions,
    options?: CallOptions,
  ): Promise<NationalSemanticCaseLawResponse> {
    return this.call<NationalSemanticCaseLawResponse>({
      method: "POST",
      path: `/${jurisdictionSegment(jurisdiction)}/search/semantic`,
      shape: { lists: ["results"], required: ["results"] },
      body: nationalSemanticWireBody(request),
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /{jurisdiction}/legislation/semantic` — embedding-based semantic
   * search over a jurisdiction's legislation; article-level matches. Same
   * shape as `semanticLegislationSearch`, plus `jurisdiction`/`documentId`/
   * `attribution` and `document` (the matched act's listing summary) on
   * every hit; the index fields (`law_title`, `article_ref`, `section`,
   * `language`, `in_force`, `valid_from`, `valid_to`, `law_type`) are
   * always present, `null` when the index has nothing (API 2.8.0).
   *
   * **`asOf` (API 2.29.0)** labels each hit for a date (`asOfResolved`,
   * `asOfReason`, `asOfVersion`); the response adds `asOf` and
   * `asOfSummary`. The search runs over today's texts only. A hit is
   * resolved only when the publisher's dates, as of LexAPI's last recorded
   * read of the act (`asOfVersion.checkedAt`), show today's wording already
   * applied on the date; an unresolved hit keeps today's wording — it is not
   * established as the text for the date. LexAPI holds such dates for
   * Austria and Spain.
   *
   * `NationalSemanticLegislationOptions` has no `hyde` field, and this SDK
   * never forwards one on this call even if a caller bypasses the type
   * system — the server now validates `hyde` as a boolean on this route too
   * (400 otherwise), so a stray non-boolean value would 400 for nothing.
   *
   * **Cost: 5 credits.**
   */
  async nationalLegislationSemanticSearch(
    jurisdiction: string,
    request: NationalSemanticLegislationOptions,
    options?: CallOptions,
  ): Promise<NationalSemanticLegislationResponse> {
    return this.call<NationalSemanticLegislationResponse>({
      method: "POST",
      path: `/${jurisdictionSegment(jurisdiction)}/legislation/semantic`,
      shape: { lists: ["results"], required: ["results"] },
      body: nationalSemanticWireBody(request, { allowHyde: false, allowAsOf: true }),
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  // ── Semantic search ───────────────────────────────────────────────

  /**
   * `POST /search/semantic` — embedding-based semantic search over CJEU
   * case law. Use this (not `search`) for *concept* queries; EUR-Lex
   * keyword matching is literal.
   *
   * **Billing:** 5 credits per call — **15 credits with `hyde: true`**
   * (HyDE query rewriting; ~1–3 s extra latency). HyDE is best-effort: on
   * LLM failure the search falls back to plain retrieval, the response
   * reports `hyde: false`, and the 10-credit premium is **refunded
   * automatically**.
   *
   * Hits carry a ~600-char `snippet` by default; `includeText: true`
   * returns the full text instead. `hint` is present only on
   * low-confidence result sets. Fewer results than `limit`? The ~0.7
   * default relevance floor cut in — pass `minScore: 0.5` (or `0`).
   *
   * Persistent document identity is `(metadata.celex_id,
   * metadata.document_type)`; `case_id` is snapshot-scoped.
   */
  async semanticSearch(
    request: SemanticCaseLawSearchOptions,
    options?: CallOptions,
  ): Promise<SemanticCaseLawSearchResponse> {
    return this.call<SemanticCaseLawSearchResponse>({
      method: "POST",
      path: "/search/semantic",
      shape: { lists: ["results"], required: ["results"] },
      body: semanticWireBody(request, { legislation: false }),
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /legislation/semantic` — embedding-based semantic search over EU
   * legislation; results are article-level matches (`article_ref`,
   * `law_id`, `law_title`, `score`). `limit` is never above 50 here.
   *
   * **Consolidated texts:** when an act and its consolidated version match
   * the same article you get ONE hit — the consolidated article, labelled
   * `consolidated` / `consolidatedAsOf` / `baseCelex` / `consolidatedNote`,
   * with the authentic act's own match under `baseAct`. Consolidated texts
   * are not authentic; cite `baseCelex`.
   *
   * **`asOf` (YYYY-MM-DD):** each hit answers with the version in force on
   * that date (`asOfResolved`, `asOfVersion`, `matchedVersion`); a hit that
   * cannot be answered keeps its latest text with `asOfResolved: false` and
   * an `asOfReason`. The response adds `asOf` and `asOfSummary`.
   *
   * **In force today:** EU hits carry `inForce` (with `notInForceReason`,
   * `endOfValidity`, `entryIntoForce`) when the act's status is known;
   * `inForce: true` keeps only hits known to be in force today and reports
   * what it removed in `inForceFilter`.
   *
   * **Cost:** 5 credits for the search; with `asOf`, each live fetch of a
   * version the corpus does not hold reserves 5 and settles by outcome
   * (Cellar 4, browser 5, no text 1, failed 0) — at most 3 per request by
   * default. Corpus reads are free; an unaffordable fetch is skipped
   * (`insufficient_credits`), never a 402. The `hyde` option is case-law only.
   */
  async semanticLegislationSearch(
    request: SemanticLegislationSearchOptions,
    options?: CallOptions,
  ): Promise<SemanticLegislationSearchResponse> {
    return this.call<SemanticLegislationSearchResponse>({
      method: "POST",
      path: "/legislation/semantic",
      shape: { lists: ["results"], required: ["results"] },
      body: semanticWireBody(request, { legislation: true }),
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /legislation/as-of` — the version of an EU regulation, directive
   * or decision listed for a date: the newest consolidated version dated on
   * or before it, or the act as published in the Official Journal when none
   * is. With `provision`, also that article, annex or recital range of the
   * version. Requires LexAPI API 2.26.0.
   *
   * **Unresolved is a normal return, not an error:** when the version or
   * the text cannot be established the call resolves with
   * `asOfResolved: false`, an `asOfReason` and no `provision`. Use
   * `provision.text` only when `asOfResolved` is `true`; `asOfVersion` can
   * also be present on an unresolved `provision` answer.
   * An unknown act throws `NotFoundError`; invalid input throws
   * `InvalidCelexError` / `InvalidParamsError`. An API older than 2.26.0
   * has no such endpoint and also answers 404 (`NotFoundError`).
   * `err.unknownEndpoint` is `false` there (the API sends it from 2.27.0):
   * check `err.message.includes("Unknown API endpoint")`.
   *
   * Consolidated versions have no legal force; only the act as published in
   * the Official Journal (`baseCelex`) is authentic. The answer does not say
   * whether an individual provision applied on that date, and
   * `act.inForceToday` is about today, not `asOf`. A retroactive amendment
   * counts from the date of the amending act.
   *
   * **Cost:** 1 credit when no text is fetched; when the provision's text
   * has to be fetched, 4 (5 when it is fetched live from EUR-Lex) whatever
   * the answer, and 1 if the fetch fails or finds no text. A fetch reserves
   * up to 5 credits: a pool holding fewer gets
   * `asOfReason: "insufficient_credits"`.
   */
  async legislationAsOf(
    request: LegislationAsOfRequest,
    options?: CallOptions,
  ): Promise<LegislationAsOfResponse> {
    const body: Record<string, unknown> = { document: request.document, asOf: request.asOf };
    if (request.provision !== undefined) body["provision"] = request.provision;
    if (request.language !== undefined) body["language"] = request.language;
    return this.call<LegislationAsOfResponse>({
      method: "POST",
      path: "/legislation/as-of",
      shape: {
        fields: [
          { path: "document", kind: "string" },
          { path: "asOfResolved", kind: "boolean" },
          { path: "act", kind: "object" },
          { path: "provenance", kind: "object" },
        ],
      },
      body,
      idempotent: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  // ── Export ────────────────────────────────────────────────────────

  /**
   * `GET /export` — stream matching corpus rows as NDJSON (BUSINESS, SCALE
   * and ENTERPRISE; lower tiers get 403 `TierForbiddenError`). Metadata-only
   * rows are skipped unless `includeStubs: true`.
   *
   * Billing (credit plans, API 2.3.0): 1 credit per row written, at least 1
   * per export. The call is admitted for 1 credit, the matching rows are
   * counted, and the rest of 1 credit per row it can return is reserved; a
   * pool that cannot cover it throws `CreditsExhaustedError` before anything
   * streams. Unwritten rows are refunded when the stream ends; the settled
   * charge is `stream.done?.credits` (`charged`).
   *
   * Returns a single-pass async iterator over document rows. The leading
   * `_meta` envelope is parsed before this resolves (`stream.meta`); the
   * trailing `_done` line is exposed as `stream.done` after iteration —
   * check `stream.truncated` (`_done.truncated` once read; the header / `_meta`
   * hints before) to detect rows the export did not reach instead of assuming
   * it was complete.
   *
   * ```ts
   * const stream = await client.export({ documentTypeCode: "regulation", limit: 1000 });
   * console.log(stream.meta?.totalMatching, stream.headers.total);
   * for await (const row of stream) process(row.celex, row.parsedContent);
   * if (stream.truncated) console.warn(`not every row reached (${stream.done?.truncatedBy}) — narrow the filters or resume with changedSince`);
   * ```
   */
  async export(params: ExportParams = {}, options?: CallOptions): Promise<ExportStream> {
    // Mirrors the API's 400 exactly: a positive integer, nothing else.
    if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 1)) {
      throw new RangeError(`limit must be a positive integer, got ${String(params.limit)}`);
    }
    const response = await this.http.requestRaw({
      method: "GET",
      path: "/export",
      accept: "application/x-ndjson, application/json",
      query: {
        documentType: listParam(params.documentType),
        documentTypeCode: listParam(params.documentTypeCode),
        author: listParam(params.author),
        subdomain: listParam(params.subdomain),
        language: params.language,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        fetchedSince: timestampParam(params.fetchedSince),
        changedSince: timestampParam(params.changedSince),
        includeHtml: params.includeHtml,
        includeContent: params.includeContent,
        includeStubs: params.includeStubs,
        limit: params.limit,
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
    return createExportStream(response, {
      idleTimeoutMs: options?.timeoutMs ?? this.http.timeoutMs,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }
}

/**
 * Map camel-cased SDK semantic options to the wire shape (`min_score`,
 * `include: ["text"]`). `asOf` and `inForce` are legislation options: never
 * sent on case-law search, even when set on the request object.
 */
function semanticWireBody(
  request: SemanticCaseLawSearchOptions & SemanticLegislationSearchOptions,
  { legislation }: { legislation: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = { query: request.query };
  if (request.limit !== undefined) body["limit"] = request.limit;
  if (request.minScore !== undefined) body["min_score"] = request.minScore;
  if (request.language !== undefined) body["language"] = request.language;
  if (request.includeText) body["include"] = ["text"];
  if (request.filters !== undefined) body["filters"] = request.filters;
  if (request.hyde !== undefined) body["hyde"] = request.hyde;
  if (legislation && request.asOf !== undefined) body["asOf"] = request.asOf;
  if (legislation && request.inForce !== undefined) body["inForce"] = request.inForce;
  return body;
}

/**
 * Same mapping as `semanticWireBody`, for the national options types: those
 * deliberately don't extend `SemanticSearchOptions` (a narrower `language`,
 * exact `filters` interfaces — see `NationalSemanticCaseLawOptions`), so
 * `filters` is read as `unknown` here rather than `Record<string, unknown>`
 * to avoid the missing-index-signature assignability error. `asOf` is sent
 * only for legislation (`allowAsOf`).
 */
function nationalSemanticWireBody(
  request: {
    query: string;
    limit?: number;
    minScore?: number;
    language?: string;
    includeText?: boolean;
    filters?: unknown;
    hyde?: boolean;
    asOf?: string;
  },
  { allowHyde = true, allowAsOf = false }: { allowHyde?: boolean; allowAsOf?: boolean } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = { query: request.query };
  if (request.limit !== undefined) body["limit"] = request.limit;
  if (request.minScore !== undefined) body["min_score"] = request.minScore;
  if (request.language !== undefined) body["language"] = request.language;
  if (request.includeText) body["include"] = ["text"];
  if (request.filters !== undefined) body["filters"] = request.filters;
  // Legislation never sends hyde, even if a caller bypassing the type
  // system set one on the (typed hyde-less) request object — the server
  // validates it strictly as a boolean on this route too (400 otherwise).
  if (allowHyde && request.hyde !== undefined) body["hyde"] = request.hyde;
  if (allowAsOf && request.asOf !== undefined) body["asOf"] = request.asOf;
  return body;
}

/**
 * The jurisdiction path segment: lower-cased (the routes are registered in
 * lower case) and URL-encoded like every other caller-supplied segment, so a
 * stray "/" or "?" in a jurisdiction argument cannot reach another route.
 */
function jurisdictionSegment(jurisdiction: string): string {
  return encodeURIComponent(jurisdiction.trim().toLowerCase());
}

/**
 * True when `value` looks like a 0.2.0-era `getCitationStats(options?)`
 * call (a `CallOptions`: `timeoutMs` and/or `signal`, never
 * `includeNational`) rather than the current `CitationStatsParams`.
 */
function isLegacyCitationStatsCallOptions(
  value: CitationStatsParams | CallOptions | undefined,
): value is CallOptions {
  if (!value || typeof value !== "object") return false;
  if ("includeNational" in value) return false;
  return "timeoutMs" in value || "signal" in value;
}

/** The API 2.11.0 edge filters, each comma-joined when given as a list. */
function filterQuery(params: CitationFilterParams): Record<string, string | undefined> {
  return {
    citationType: listParam(params.citationType),
    provenance: listParam(params.provenance),
    jurisdictions: listParam(params.jurisdictions),
    resolution: listParam(params.resolution),
  };
}

function edgeQuery(params: CitationEdgeParams): Record<string, string | number | boolean | undefined> {
  return {
    ...filterQuery(params),
    limit: params.limit,
    offset: params.offset,
    language: params.language,
    includeNational: params.includeNational,
  };
}

/** A `Date` is sent as its UTC ISO string; strings pass through for the server to validate. */
function timestampParam(value: string | Date | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : value;
}

/** Comma-join list filters (the export endpoint accepts comma-separated or repeated values). */
function listParam(value: string | ReadonlyArray<string> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.join(",");
}

type EdgeGroup = CitedDocumentGroup | CitingDocumentGroup;

/** A group's edge rows: its `citationCount` when that is a count, else the length of its edge list. */
function edgeRows(group: EdgeGroup): number {
  return count(group.citationCount) ?? (Array.isArray(group.citations) ? group.citations.length : 0);
}

async function* paginateEdges<
  T extends { limit?: number; offset?: number; totalEdges?: number },
  P extends CitationEdgeParams,
>(
  fetchPage: (params: P) => Promise<T>,
  groupsIn: (page: T) => readonly EdgeGroup[] | undefined,
  params: P,
): AsyncGenerator<T, void> {
  const start = startingPosition(params.offset, params.limit, 100);
  const limit = start.limit;
  let offset = start.offset;
  let previous: string | undefined;
  let repeats = 0;
  for (;;) {
    const page = await fetchPage({ ...params, limit, offset });
    const listed: unknown = groupsIn(page);
    const groups: readonly EdgeGroup[] = Array.isArray(listed) ? listed : [];
    const echoed = count(page.offset);
    const totalEdges = count(page.totalEdges);
    // The page that shows a stall is not yielded; it is on the error's `body`.
    if (echoed !== undefined && echoed !== offset) throw stalled("the server did not advance", page);
    if (echoed === undefined && totalEdges === undefined) {
      // No position signal: only the same list, page after page, is a stall.
      const form = compactForm(groups);
      repeats = form === previous ? repeats + 1 : 0;
      previous = form;
      if (repeats >= REPEATS_BEFORE_THROW) throw stalled("the server repeated the same page", page);
    } else {
      // A page with a position signal ends any run of repeats.
      repeats = 0;
      previous = undefined;
    }
    yield page;
    // SDK contract §1.4: offsets count edge rows; advance by the sum of the
    // page's citationCounts and stop at the first page shorter than the page
    // size, or once the offset reaches `totalEdges`. (`totalCitations` counts
    // distinct document pairs — raw rows can outnumber it — so it never ends
    // the walk.)
    const echoedLimit = count(page.limit);
    const pageLimit = echoedLimit !== undefined && echoedLimit > 0 ? echoedLimit : limit;
    const rows = groups.reduce((n, g) => n + edgeRows(g), 0);
    offset += rows;
    if (rows === 0 || rows < pageLimit) return;
    if (totalEdges !== undefined && offset >= totalEdges) return;
  }
}

/**
 * Attach parsed response headers (`headers`) and the legacy header-derived
 * fields (`xWarning`, `corpusVersion`) to a JSON body so callers can't miss
 * header-only signals.
 */
function withHeaders<T extends object>(data: T, response: Response, corpusVersion: boolean): T {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
  const headers = parseResponseHeaders(response);
  const out: Record<string, unknown> = { ...data, headers };
  if (headers.warning !== undefined) out["xWarning"] = headers.warning;
  if (corpusVersion && headers.corpusVersion !== undefined) {
    out["corpusVersion"] = headers.corpusVersion;
  }
  return out as T;
}
