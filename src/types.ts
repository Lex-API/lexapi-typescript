/**
 * Hand-curated types mirroring `openapi.yaml` (LexAPI 2.0.0).
 * Field names and nullability follow the spec exactly — `type: [X, 'null']`
 * becomes `X | null`, and properties outside a `required` list are optional.
 */

// ── Common enums ────────────────────────────────────────────────────

export type SubscriptionTier = "FREE" | "STARTER" | "PROFESSIONAL" | "BUSINESS" | "ENTERPRISE";

/** ISO 639-1 code (24 official EU languages). */
export type Language =
  | "en" | "fr" | "de" | "es" | "it" | "pl" | "nl" | "pt" | "ro" | "bg" | "cs" | "da"
  | "el" | "et" | "fi" | "ga" | "hr" | "hu" | "lt" | "lv" | "mt" | "sk" | "sl" | "sv";

export type Domain = "EU_LAW" | "NATIONAL_LAW" | "ALL";

export type Subdomain =
  | "LEGISLATION"
  | "CONSLEG"
  | "TREATIES"
  | "EU_CASE_LAW"
  | "LEGAL_PROCEDURE"
  | "INTER_AGREE"
  | "PRE_ACTS"
  | "PAR_QUESTION"
  | "NAT_CASE_LAW";

/** User-facing document-type filter enum (request side). */
export type DocumentType =
  | "judgment"
  | "opinion"
  | "order"
  | "regulation"
  | "directive"
  | "decision"
  | "recommendation"
  | "communication"
  | "proposal"
  | "report"
  | "resolution"
  | "declaration"
  | "treaty"
  | "protocol"
  | "agreement"
  | "written-question"
  | "oral-question"
  | "consolidated-text"
  | "guideline"
  | "implementing"
  | "staff-working-document";

export type Author =
  | "commission"
  | "council"
  | "parliament"
  | "court-of-justice"
  | "general-court"
  | "ecb"
  | "eca"
  | "eesc"
  | "cor"
  | "ema"
  | "efsa";

export type Procedure =
  | "ordinary"
  | "codecision"
  | "consent"
  | "consultation"
  | "budget"
  | "implementing"
  | "delegated"
  | "comitology"
  | "appointment"
  | "non-legislative";

export type TextScope = "title" | "text" | "title-text" | "any";

// ── Subscription / usage / credits blocks ───────────────────────────

export interface SubscriptionInfo {
  tier?: SubscriptionTier;
  maxPages?: number;
  maxBatchSize?: number;
  maxWebhooks?: number;
  /** `credits` = monthly credit pool (pricing v2); `daily` = legacy daily-call model. */
  pricingMode?: "credits" | "daily";
  /** Legacy daily-call ceiling. `null` for credit-pool (v2) accounts. */
  dailyLimit?: number | null;
  /** Monthly credit allowance. `null` for legacy daily-call accounts. */
  monthlyCredits?: number | null;
  /** e.g. "120 requests/minute" */
  rateLimit?: string;
}

/**
 * Caller's current usage counters at request time. Dual-mode: credits over
 * the monthly window for v2 accounts, API calls for the day on legacy
 * accounts — read `unit` to disambiguate.
 */
export interface UsageInfo {
  current?: number;
  limit?: number;
  remaining?: number;
  unit?: "credits" | "calls";
  /** When the counter resets (ISO date-time). */
  resetsAt?: string;
}

/**
 * Pricing-v2 credit-pool state. Present on responses for credit-pool
 * accounts (alongside the back-compat `usage` block); absent for legacy
 * daily-call accounts.
 */
export interface CreditsInfo {
  /** Credits this specific request cost (0 for free operations such as /info). */
  operation_weight?: number;
  /** Credits used in the current monthly window. */
  current?: number;
  /** Total pool this window (included + topup). */
  limit?: number;
  remaining?: number;
  /** Monthly credit allowance for the tier. */
  included?: number;
  /** Purchased top-up credits, spent after the monthly allowance; never expire. */
  topup?: number;
  /** When the monthly allowance resets. May be null until first set. */
  resetsAt?: string | null;
}

/** Shape shared by every LexAPI response that reports quota state. */
export interface CreditedResponse {
  subscription?: SubscriptionInfo;
  usage?: UsageInfo;
  credits?: CreditsInfo;
}

// ── GET /info ───────────────────────────────────────────────────────

export interface InfoSearchFilters {
  textScope?: TextScope[];
  domain?: Domain[];
  subdomain?: Subdomain[];
  documentType?: DocumentType[];
  author?: Author[];
  procedure?: Procedure[];
}

export interface InfoResponse extends CreditedResponse {
  service?: string;
  version?: string;
  description?: string;
  /** Self-describing capability map (per-endpoint method, path, parameters). */
  endpoints?: Record<string, unknown>;
  searchFilters?: InfoSearchFilters;
  supportedLanguages?: Language[];
}

// ── Payload control (Phase 4 field selection) ───────────────────────

/**
 * `include` / `fields` token. The spec's enum lists
 * metadata/fullText/articles/recitals/sections/tables/annexes; the
 * `DocumentContent` description additionally documents `paragraphs` as
 * part of the accepted include set.
 */
export type IncludeToken =
  | "metadata"
  | "fullText"
  | "articles"
  | "recitals"
  | "paragraphs"
  | "sections"
  | "tables"
  | "annexes";

/** Array form, or a comma-separated string like `"metadata,articles"`. */
export type IncludeSelection = IncludeToken[] | string;

// ── Document shapes ─────────────────────────────────────────────────

/** A top-level article extracted from the document body. */
export interface Article {
  /** Stable id from the EUR-Lex `eli-subdivision` (e.g. `art_17`). */
  id?: string;
  /** e.g. `"Article 17"` */
  number: string;
  title?: string | null;
  /** Plain-text body of the article (paragraphs joined). */
  content: string;
}

/**
 * Chapter/section hierarchy node. `articleRange` is
 * `[firstArticleId, lastArticleId]` when the section directly contains
 * articles; `null` for chapters whose children are sub-sections.
 */
export interface Section {
  type: "chapter" | "section";
  number: string;
  title: string;
  articleRange?: [string, string] | null;
}

/** Preamble recital — also the element type of `paragraphs[]` (numbered prose). */
export interface Recital {
  number: number;
  text: string;
}

export interface Annex {
  title?: string;
  content?: string;
}

export interface Table {
  caption?: string;
  headers?: string[];
  rows?: string[][];
}

/**
 * Structured document body. Case-law CELEXes (sector 6) emit numbered
 * grounds in `paragraphs[]` with empty `recitals[]`; legislation keeps
 * `recitals[]` — the two arrays are mutually exclusive on one document.
 * With `include`/`fields` selection any of these keys can be omitted.
 */
export interface DocumentContent {
  fullText?: string;
  articles?: Article[];
  /** Legislative preamble recitals. Empty `[]` on case-law — see `paragraphs`. */
  recitals?: Recital[];
  /** Judgment grounds (case-law) or fullText splits when no structured extractor matched. */
  paragraphs?: Recital[];
  sections?: Section[];
  /** Genuine data tables only (layout-table noise is filtered out server-side). */
  tables?: Table[];
  annexes?: Annex[];
}

/** Normalized metadata for a single document. */
export interface DocumentMetadata {
  /** Canonical CELEX. Always present on metadata responses. */
  celex?: string;
  /** Legacy alias for `celex` (metadata endpoint back-compat). */
  celexNumber?: string;
  /** `null` when the document is genuinely sparse — never `"Unknown Title"`. */
  title?: string | null;
  /** Prose form of the document, e.g. `"Regulation"`. */
  documentType?: string | null;
  /** Stable enum slug for `documentType` (e.g. `"regulation"`). */
  documentTypeCode?: DocumentTypeCode | null;
  author?: string;
  /** Legacy DD/MM/YYYY string as published by EUR-Lex. Prefer `dateOfDocumentISO`. */
  dateOfDocument?: string | null;
  /** ISO-8601 date parsed from `dateOfDocument`. */
  dateOfDocumentISO?: string | null;
  dateOfEffect?: string | null;
  dateOfEffectISO?: string | null;
  dateOfPublication?: string | null;
  dateOfPublicationISO?: string | null;
  /** Qualifier EUR-Lex appends to dates (e.g. `"Date of signature"`). */
  dateType?: string | null;
  /** European Case Law Identifier (recovered from htmlMetadata for sector-6 rows). */
  ecli?: string | null;
  /** European Legislation Identifier path. */
  eli?: string | null;
  /** Court case number; joined-case ranges come as one string (`"C-171/24 to C-177/24"`). */
  caseNumber?: string | null;
  /** Parsed party names from case-law titles. */
  parties?: string | null;
  /** EUROVOC keywords, deduplicated case-insensitively. */
  keywords?: string[];
  /** EUR-Lex directory codes (e.g. `"13.30.99.00 Other sectors"`). */
  directoryCodes?: string[];
  subject?: string[];
}

/** Fully-parsed document: metadata + structured content. */
export interface Document extends DocumentMetadata {
  /** ISO code of the language rendition actually served. */
  language?: string;
  /** Present only on a fallback — the language originally requested. */
  languageRequested?: string;
  /** Present only on a fallback — the language served instead (`en`). */
  languageFallback?: string;
  content?: DocumentContent;
  urls?: {
    html?: string;
    metadata?: string;
  };
}

/**
 * Response-side document-type slug. The spec enumerates the known values,
 * but unknown prose is slugified server-side (e.g. `staff working document`
 * → `staff_working_document`), so unknown strings must be tolerated.
 */
export type DocumentTypeCode =
  | "regulation"
  | "directive"
  | "decision"
  | "recommendation"
  | "opinion"
  | "ag_opinion"
  | "judgment"
  | "order"
  | "communication"
  | "proposal"
  | "report"
  | "resolution"
  | "declaration"
  | "treaty"
  | "protocol"
  | "agreement"
  | "guideline"
  | "staff_working_document"
  | "abstract"
  | (string & {});

/** A single entry in a search results page. */
export interface SearchResult {
  /** Title with HTML entities decoded and sentence-spacing restored. */
  title?: string;
  /** Legacy field. Same value as `celex`. */
  celexNumber?: string;
  /** Canonical CELEX alias. */
  celex?: string;
  /** Legacy field. Same value as `documentType`. */
  form?: string | null;
  documentType?: string | null;
  documentTypeCode?: DocumentTypeCode | null;
  date?: string;
  dateOfDocumentISO?: string | null;
  author?: string | null;
  /**
   * Upper-case 2-letter ISO codes the document is published in. Empty `[]`
   * for rows that don't expose the field (case-law, preparatory documents).
   */
  availableLanguages?: string[];
  url?: string;
}

// ── POST /search ────────────────────────────────────────────────────

/**
 * Search filters. At least one of `query`, `dateFrom`, `dateTo`, `year`,
 * `month`, `documentType`, `author`, `procedure`, `domain`, or `subdomain`
 * is required — a completely empty body fails with 400.
 */
export interface SearchRequest {
  /** Free-text search. Prefer 1–3 distinctive terms; quotes force exact-phrase matching. */
  query?: string;
  textScope?: TextScope;
  dateFrom?: string;
  dateTo?: string;
  year?: number | number[];
  month?: number | number[];
  /** Multi-value arrays fan out to one EUR-Lex search per resolved form code. */
  documentType?: DocumentType | DocumentType[];
  author?: Author | Author[];
  procedure?: Procedure | Procedure[];
  domain?: Domain;
  subdomain?: Subdomain | Subdomain[];
  language?: Language;
  /**
   * EUR-Lex result pages to fetch. Clamped to the subscription tier
   * (FREE=1, STARTER=5, PROFESSIONAL=20, BUSINESS=100); if clamped, the
   * response carries an `X-Warning` header (surfaced as `xWarning`).
   */
  maxPages?: number;
}

export interface SearchResponse extends CreditedResponse {
  searchParameters?: SearchRequest;
  /** Total matching documents on EUR-Lex. */
  totalResults?: number;
  /** Total result pages available on EUR-Lex. */
  totalPages?: number;
  pagesFetched?: number;
  /** Number of results in this response. */
  resultCount?: number;
  results?: SearchResult[];
  /**
   * Present and `true` when the result set was capped by the tier
   * `maxPages` limit and more pages exist on EUR-Lex. Check
   * `truncatedAt`/`truncatedReason` — do not ignore silently.
   */
  truncated?: boolean;
  /** Approximate result count at the truncation boundary (`pagesFetched * 10`). */
  truncatedAt?: number;
  truncatedReason?: string;
  /**
   * Present and `true` when an upstream timeout dropped one of the
   * requested pages; the pages collected before the failure are still in
   * `results`. Check `partialReason`.
   */
  partial?: boolean;
  partialReason?: string;
  /**
   * Comma-joined dimensions on which a controller-side post-filter dropped
   * rows (`author`, `date`, `documentType`). `"date"` signals the
   * recall-vs-pagination trade-off: raise `maxPages` to widen recall on
   * tight date filters.
   */
  postFilteredBy?: string;
  /** Requested types that resolve to no EUR-Lex form code (reported, not silently dropped). */
  ignoredDocumentTypes?: string[];
  fetchedAt?: string;
  /**
   * SDK-added: contents of the `X-Warning` response header when present
   * (e.g. `maxPages` clamped to the tier ceiling). Not part of the JSON body.
   */
  xWarning?: string;
}

// ── POST /documentContent ───────────────────────────────────────────

export interface DocumentContentRequest {
  celexNumber: string;
  /** Force a live scrape, bypassing the corpus cache. */
  bypassCorpus?: boolean;
  /**
   * Language rendition to return (whole document). Falls back to English
   * when unavailable — see `languageRequested`/`languageFallback` on the
   * document.
   */
  language?: Language;
  /** Trim the response payload to the listed pieces. */
  include?: IncludeSelection;
  /** Alias accepted alongside `include`. */
  fields?: IncludeSelection;
  /** Narrow `content.articles` to a single article (`art_17`, `17`, or `Article 17`). */
  articleId?: string;
}

export interface DocumentContentResponse extends CreditedResponse {
  success: boolean;
  document: Document;
}

// ── POST /documentContent/batch ─────────────────────────────────────

export interface DocumentContentBatchRequest {
  /** Truncated to the tier batch ceiling (FREE=1, STARTER=5, PROFESSIONAL=20, BUSINESS=50). */
  celexNumbers: string[];
  bypassCorpus?: boolean;
  language?: Language;
  include?: IncludeSelection;
  fields?: IncludeSelection;
  articleId?: string;
}

/** One failed CELEX from a batch fetch. */
export interface BatchDocumentError {
  celexNumber?: string;
  /** Short error slug (includes upstream timeouts as `"FetchTimeoutError" | "TIMEOUT"`). */
  error?: string;
  message?: string;
}

export interface DocumentContentBatchResponse extends CreditedResponse {
  success: boolean;
  /** Number of CELEX numbers in the request body. */
  requested: number;
  /** Number actually processed after tier clamping. */
  processed: number;
  successful: number;
  failed: number;
  /**
   * Present and `true` when the request exceeded the tier batch ceiling.
   * Mirrors the `X-Warning` header (also surfaced as `xWarning`). Check
   * `trimmedTo`/`trimmedReason` — trimmed entries were silently dropped
   * server-side.
   */
  trimmed?: boolean;
  trimmedTo?: number;
  trimmedReason?: string;
  documents: Document[];
  /** Per-CELEX failures — the batch does not abort on individual errors. */
  errors: BatchDocumentError[];
  /** SDK-added: `X-Warning` response header (batch clamped), when present. */
  xWarning?: string;
}

// ── GET /documents/recent ───────────────────────────────────────────

export interface RecentDocumentsParams {
  /** How many days back from today to include. Default 7. */
  days?: number;
  documentType?: DocumentType;
  author?: Author;
  domain?: Domain;
  subdomain?: Subdomain;
  /** Result language (default `en`). */
  language?: Language;
  /** Maximum number of results to return. Default 50. */
  limit?: number;
}

export interface RecentDocumentsResponse extends CreditedResponse {
  success: boolean;
  /** Echo of the resolved query parameters (with computed `dateFrom`/`dateTo`). */
  parameters?: {
    days?: number;
    dateFrom?: string;
    dateTo?: string;
    documentType?: string | null;
    author?: string | null;
    domain?: string | null;
    subdomain?: string | null;
    language?: string;
    limit?: number;
  };
  totalResults?: number;
  resultCount?: number;
  results: SearchResult[];
  /** Present only when the language post-filter dropped rows. */
  languageFilter?: {
    requested: string;
    kept: number;
    beforeFilter: number;
  };
  fetchedAt?: string;
  /** SDK-added: `X-Warning` response header, when present. */
  xWarning?: string;
}

// ── POST /documents/url ─────────────────────────────────────────────

export interface DocumentByUrlRequest {
  /** Any `eur-lex.europa.eu` URL containing a CELEX (path segment or `uri=` param). */
  url: string;
  include?: IncludeSelection;
  fields?: IncludeSelection;
  articleId?: string;
}

export interface DocumentByUrlResponse extends CreditedResponse {
  success: boolean;
  /** The exact URL passed in the request body. */
  sourceUrl: string;
  /** CELEX number extracted from `sourceUrl`, uppercased. */
  extractedCelex: string;
  document: Document;
}

// ── POST /documents/metadata ────────────────────────────────────────

export interface DocumentMetadataRequest {
  celexNumber: string;
  bypassCorpus?: boolean;
}

export interface DocumentMetadataResponse extends CreditedResponse {
  success: boolean;
  /** Metadata-only — no `content`. Includes the canonical EUR-Lex URLs. */
  metadata: DocumentMetadata & {
    urls?: {
      html?: string;
      metadata?: string;
      pdf?: string;
      xml?: string;
    };
  };
}

// ── POST /resolve ───────────────────────────────────────────────────

export type IdentifierType = "celex" | "url" | "eli" | "ecli";

export interface ResolveResponse {
  success: boolean;
  /** Echo of the caller's input. */
  identifier: string;
  identifierType: IdentifierType;
  /** Which resolution path matched. Pure path for celex/url/eli; corpus lookup for ecli. */
  resolvedVia: IdentifierType;
  celex: string;
  urls: {
    metadata?: string;
    html?: string;
    pdf?: string;
    xml?: string;
  };
}

// ── Citations ───────────────────────────────────────────────────────

/** Classification of a citation edge. */
export type CitationType =
  | "reference"
  | "amendment"
  | "repeal"
  | "implementation"
  | "legal-basis"
  | "proposal";

/** Edge shape emitted on fresh extraction. */
export interface CitationEdgeSummary {
  targetCelex?: string;
  citationType?: CitationType;
  /** Surrounding text around the citation on the source metadata page, when available. */
  contextSnippet?: string | null;
}

export interface CitationExtractResponse {
  success: boolean;
  message?: string;
  /** Present on fresh extraction. Omitted when `alreadyExtracted` is true. */
  document?: {
    celexNumber?: string;
    title?: string | null;
  };
  /** Number of citation edges persisted (or already on file). */
  citationCount?: number;
  /** Edges that were just extracted. Empty array when `alreadyExtracted: true`. */
  citations?: CitationEdgeSummary[];
  /** True when the document had already been processed (extraction is idempotent). */
  alreadyExtracted?: boolean;
}

/** A single citation edge with classification, context, and timestamp. */
export interface CitationEdgeDetail {
  citationType?: CitationType;
  contextSnippet?: string | null;
  extractedAt?: string;
}

/** All edges from one source document into the target (cited-by grouping). */
export interface CitingDocumentGroup {
  celexNumber?: string;
  title?: string | null;
  citationCount?: number;
  citations?: CitationEdgeDetail[];
}

/** All edges from the source document into one target (cites grouping). */
export interface CitedDocumentGroup {
  celexNumber?: string;
  title?: string | null;
  citationCount?: number;
  citations?: CitationEdgeDetail[];
}

/** Pagination filters shared by the cites / cited-by endpoints. */
export interface CitationEdgeParams {
  /** Filter to a single citation type. */
  citationType?: CitationType;
  /** Max edges to return per page. Default 100. */
  limit?: number;
  /** Pagination offset (in edges, not documents). Default 0. */
  offset?: number;
}

export interface CitedByResponse {
  success: boolean;
  /** The CELEX whose inbound edges are being listed. */
  targetDocument: string;
  /** Total inbound edges matching the filter (across all pages). */
  totalCitations?: number;
  uniqueDocuments?: number;
  limit?: number;
  offset?: number;
  citedBy: CitingDocumentGroup[];
}

export interface CitesResponse {
  success: boolean;
  /** The CELEX whose outbound edges are being listed. */
  sourceDocument: string;
  totalCitations?: number;
  uniqueDocuments?: number;
  limit?: number;
  offset?: number;
  cites: CitedDocumentGroup[];
}

/** A neighbour in the citation graph, deduplicated across edge types. */
export interface CitationNeighbour {
  celexNumber?: string;
  title?: string | null;
  /** Number of edges to/from this neighbour. */
  count?: number;
  /** Union of `citationType` values across all edges to/from it. */
  types?: CitationType[];
}

export interface CitationNetworkParams {
  /** Filter both directions to a single citation type. */
  citationType?: CitationType;
  /** Max edges to fetch per direction (default 100, max 500). */
  limit?: number;
  /** Pagination offset (in edges, applied to both directions). */
  offset?: number;
}

export interface CitationNetworkResponse {
  success: boolean;
  /** The centre CELEX. */
  document: string;
  network: {
    celexNumber: string;
    /** Unique outbound neighbours in THIS PAGE — see `paging.citesTotal` for the unbounded total. */
    citesCount: number;
    /** Unique inbound neighbours in THIS PAGE — see `paging.citedByTotal` for the unbounded total. */
    citedByCount: number;
    cites: CitationNeighbour[];
    citedBy: CitationNeighbour[];
  };
  paging: {
    /** Effective per-direction limit after clamping. */
    limit: number;
    offset: number;
    /** Total outbound edges matching the query. `null` when the response is partial. */
    citesTotal: number | null;
    /** Total inbound edges matching the query. `null` when the response is partial. */
    citedByTotal: number | null;
  };
  /**
   * Present and `true` when the server-side wall-clock budget expired —
   * `network` arrays are empty and paging totals `null`. Retry with a
   * smaller `limit` or use the per-direction endpoints. Do not treat an
   * empty partial network as "no citations".
   */
  partial?: boolean;
  partialReason?: "TIMEOUT";
  message?: string;
  /** The server-side budget that expired (only on partial responses). */
  timeoutMs?: number;
}

export interface CitationStatsTopCited {
  celexNumber?: string;
  title?: string | null;
  citedByCount?: number;
}

export interface CitationStatsTopCiting {
  celexNumber?: string;
  title?: string | null;
  citesCount?: number;
}

export interface CitationStatsResponse {
  success: boolean;
  stats: {
    totalCitations: number;
    uniqueSourceDocuments: number;
    uniqueTargetDocuments: number;
    /** Top-10 most-cited documents. */
    mostCited: CitationStatsTopCited[];
    /** Top-10 documents with the most outbound citations. */
    mostCiting: CitationStatsTopCiting[];
  };
}

export interface CitationPathNode {
  celexNumber: string;
  /** Enriched at read time from the corpus where available. */
  title: string | null;
}

export interface CitationPathResponse {
  success: boolean;
  from: string;
  to: string;
  /** `false` is a graceful HTTP 200, not an error — see `message`. */
  found: boolean;
  /** Number of edges (0 for self-loops). `null` when `found` is false. */
  pathLength?: number | null;
  /** The depth budget actually used. */
  maxDepth?: number;
  path: CitationPathNode[];
  /** Present when `found` is false. */
  message?: string;
}

export interface RelatedDocument {
  celexNumber: string;
  title?: string | null;
  /** Number of citation targets the related document shares with the seed. */
  sharedCount: number;
  sharedTargets?: string[];
}

export interface RelatedDocumentsResponse {
  success: boolean;
  celexNumber: string;
  method: "bibliographic-coupling";
  /** Outbound citations on the seed, used to compute coupling. */
  seedCitationCount?: number;
  count: number;
  related: RelatedDocument[];
  /** Present when the seed has no outbound citations to couple on. */
  message?: string;
}

// ── Semantic search ─────────────────────────────────────────────────

/** Languages accepted by the semantic endpoints (narrower than `Language`). */
export type SemanticLanguage =
  | "en" | "fr" | "de" | "es" | "it" | "sl" | "el" | "nl" | "pt" | "pl";

/**
 * SDK-side options for the semantic endpoints. Camel-cased; the SDK maps
 * them to the wire shape (`min_score`, `include: ["text"]`).
 */
export interface SemanticSearchOptions {
  /** Natural-language query to embed. */
  query: string;
  /** Max results. Clamped to the caller's tier ceiling. Default 10. */
  limit?: number;
  /**
   * Drop results below this cosine similarity (wire: `min_score`).
   * Unset applies the upstream's default relevance floor of ~0.7 — if you
   * got fewer results than `limit`, the floor cut in; pass `0.5` (or lower)
   * to widen recall, `0` to disable the floor entirely.
   */
  minScore?: number;
  /** Language of returned content. Default `en`. */
  language?: SemanticLanguage;
  /**
   * Set `true` to receive the full document text in each hit (wire:
   * `include: ["text"]`). By default each hit carries a ~600-char snippet
   * instead — about a 10-50x payload reduction.
   */
  includeText?: boolean;
  /** Free-form filter object forwarded to the semantic backend. */
  filters?: Record<string, unknown>;
}

/** Options for `semanticSearch` (case law) — adds HyDE query rewriting. */
export interface SemanticCaseLawSearchOptions extends SemanticSearchOptions {
  /**
   * Enable HyDE query rewriting (case-law endpoint only; ignored by
   * `/legislation/semantic`): an LLM drafts the passage a relevant
   * judgment would contain and retrieval fuses plain-query and
   * hypothetical-passage rankings. Markedly better recall on short or
   * keyword-style queries.
   *
   * **Billing: 15 credits instead of 5**, and adds ~1–3 s of latency (one
   * LLM call). Best-effort: if generation fails the search transparently
   * falls back to plain retrieval, the response reports `hyde: false`,
   * and the 10-credit premium is **automatically refunded**
   * (`credits.operation_weight` reflects the base rate).
   *
   * Must be a JSON boolean — string values are rejected with 400.
   */
  hyde?: boolean;
}

/** Single case-law match from `/search/semantic`. */
export interface SemanticCaseLawResult {
  /**
   * Snapshot-scoped UUID — regenerated when the upstream index is rebuilt.
   * Do NOT store as a long-term identifier; use
   * `(metadata.celex_id, metadata.document_type)` for persistent joins.
   */
  case_id?: string | null;
  /** Cosine similarity, 0–1. */
  score?: number;
  /** Matching passage; replaced with the full document text when a parsed copy is available. */
  text?: string;
  case_name?: string | null;
  case_number?: string | null;
  ecli?: string | null;
  court?: string | null;
  /** Always includes `celex_id` when available — the persistent identity key. */
  metadata?: {
    celex_id?: string;
    document_type?: string | null;
    [key: string]: unknown;
  };
}

/** Semantic-specific quota counters (legacy daily-call plans only). */
export interface SemanticUsageInfo {
  current?: number;
  limit?: number;
  remaining?: number;
}

export interface SemanticCaseLawSearchResponse {
  success: boolean;
  searchType?: "semantic-case-law";
  query?: string;
  resultCount?: number;
  results: SemanticCaseLawResult[];
  /**
   * Present only on best-effort responses (low-confidence hits below your
   * `minScore`, or noise-floor fallback) — its presence is itself the
   * low-confidence signal. Omitted entirely (never `null`) otherwise.
   */
  hint?: string;
  /**
   * Present only when the request set `hyde: true`. Reports whether HyDE
   * rewriting actually ran; `false` means generation failed, the search
   * fell back to plain retrieval, and the 10-credit premium was refunded.
   */
  hyde?: boolean;
  /**
   * Present only when HyDE ran (`hyde: true` in the response): the
   * LLM-drafted hypothetical judgment passage whose embedding was fused
   * into retrieval — useful for debugging why results matched.
   */
  hypotheticalDocument?: string;
  /** Opaque upstream pass-through; shape not stable — use `tookMs` for timing. */
  metadata?: Record<string, unknown>;
  /** Server-measured wall-clock time for this request, in ms. */
  tookMs?: number;
  semanticUsage?: SemanticUsageInfo;
  subscription?: SubscriptionInfo & { maxResults?: number };
  usage?: UsageInfo;
  credits?: CreditsInfo;
}

/** Single article-level match from `/legislation/semantic`. */
export interface SemanticLegislationResult {
  /** Cosine similarity, 0–1. */
  score?: number;
  /** Matching article text from the embedding index. */
  text?: string;
  /** Article identifier (e.g. `Article 17`). */
  article_ref?: string | null;
  /** CELEX identifier of the parent legal act. */
  law_id?: string | null;
  law_title?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SemanticLegislationSearchResponse {
  success: boolean;
  searchType?: "semantic-legislation";
  query?: string;
  resultCount?: number;
  results: SemanticLegislationResult[];
  /** Present only on best-effort responses — see `SemanticCaseLawSearchResponse.hint`. */
  hint?: string;
  /** Opaque upstream pass-through; shape not stable — use `tookMs` for timing. */
  metadata?: Record<string, unknown>;
  tookMs?: number;
  semanticUsage?: SemanticUsageInfo;
  subscription?: SubscriptionInfo & { maxResults?: number };
  usage?: UsageInfo;
  credits?: CreditsInfo;
}
