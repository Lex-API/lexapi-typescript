/**
 * Hand-curated types mirroring LexAPI's `openapi.yaml` (LexAPI 2.0.0) and
 * `docs.md`, cross-checked against the server's controllers.
 *
 * Validated against: lex-api `main` @ 633eb67 (2026-10-26, PR #298).
 *
 * Conventions:
 * - `type: [X, 'null']` becomes `X | null`; properties outside a `required`
 *   list are optional.
 * - Open string enums (`"a" | "b" | (string & {})`) are used where the server
 *   may add values (forward compatibility) — known values still autocomplete.
 * - Fields the SDK adds from response headers are documented as "SDK-added".
 */

import type { ResponseHeaders } from "./headers.js";

// ── Common enums ────────────────────────────────────────────────────

/** Subscription tiers. `SCALE` was added with the 2026-07 pricing. */
export type SubscriptionTier =
  | "FREE"
  | "STARTER"
  | "PROFESSIONAL"
  | "BUSINESS"
  | "SCALE"
  | "ENTERPRISE"
  | (string & {});

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

/** A single value or a list of values (the API accepts both on list filters). */
export type OneOrMany<T> = T | T[];

// ── Subscription / usage / credits blocks ───────────────────────────

export interface SubscriptionInfo {
  tier?: SubscriptionTier;
  maxPages?: number;
  maxBatchSize?: number;
  maxWebhooks?: number;
  /** Semantic endpoints only: the effective result cap for this call. */
  maxResults?: number;
  /** `credits` = monthly credit pool (pricing v2); `daily` = legacy daily-call model. */
  pricingMode?: "credits" | "daily";
  /** Legacy daily-call ceiling. `null` for credit-pool (v2) accounts. */
  dailyLimit?: number | null;
  /** Monthly credit allowance. `null` for legacy daily-call accounts. */
  monthlyCredits?: number | null;
  /** e.g. `"120 requests/minute"`. `"0 requests/minute"` means unlimited (hand-priced plans). */
  rateLimit?: string;
}

/**
 * Caller's current usage counters at request time. Dual-mode: credits over
 * the monthly window for v2 accounts, API calls for the day on legacy
 * accounts. Prefer the richer `credits` block on v2 responses.
 */
export interface UsageInfo {
  current?: number;
  limit?: number;
  remaining?: number;
  /** Documented by the spec; not currently emitted by the server. */
  unit?: "credits" | "calls";
  /** When the counter resets (ISO date-time). */
  resetsAt?: string | null;
  /** Legacy daily-call plans only: calls this request counted (always 1). */
  unitsCharged?: number;
}

/**
 * Pricing-v2 credit-pool state. Present on responses for credit-pool
 * accounts (alongside the back-compat `usage` block); absent for legacy
 * daily-call accounts.
 */
export interface CreditsInfo {
  /**
   * Credits this request cost (0 for free operations such as /info). On
   * operations that settle by source (document reads, searches, HyDE, asOf
   * fetches) refunds are applied after the response is sent, so this can
   * show the upfront charge; the next call's envelope reflects the refund.
   */
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

/**
 * Parsed response headers attached by the SDK to every JSON response
 * (`result.headers`). See {@link ResponseHeaders}.
 */
export interface WithResponseHeaders {
  /** SDK-added: parsed LexAPI response headers (source, rate limits, warnings, …). */
  headers?: ResponseHeaders;
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

export interface InfoResponse extends CreditedResponse, WithResponseHeaders {
  service?: string;
  version?: string;
  description?: string;
  /** Self-describing capability map (per-endpoint method, path, parameters). */
  endpoints?: Record<string, unknown>;
  searchFilters?: InfoSearchFilters;
  supportedLanguages?: Language[];
}

// ── Payload control (field selection) ───────────────────────────────

/**
 * `include` / `fields` token. The spec's enum lists
 * metadata/fullText/articles/recitals/sections/tables/annexes; the
 * `DocumentContent` description additionally documents `paragraphs`.
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

/**
 * Opt-in language fallback for documents with no text in the requested
 * language: an ordered list of ISO codes the caller can consume, or `"any"`.
 */
export type AcceptLanguages = Language[] | "any";

// ── Document shapes ─────────────────────────────────────────────────

/** A top-level article extracted from the document body. */
export interface Article {
  /** Stable id (e.g. `art_17`, `art_6a` for an inserted article). */
  id?: string;
  /** e.g. `"Article 17"` — the heading as published. */
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
  /** `null` for an unnumbered section heading. */
  number: string | null;
  /** `null` when the heading has no title text. */
  title: string | null;
  articleRange?: [string, string] | null;
}

/** Preamble recital — also the element type of `paragraphs[]` (numbered prose). */
export interface Recital {
  /** `null` when the recital's number could not be read from the markup. */
  number: number | null;
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
 * `recitals[]`. With `include`/`fields` selection any key can be omitted.
 */
export interface DocumentContent {
  fullText?: string;
  articles?: Article[];
  /** Legislative preamble recitals. Empty `[]` on case-law — see `paragraphs`. */
  recitals?: Recital[];
  /** Judgment grounds (case-law), text outside articles, or fullText splits. */
  paragraphs?: Recital[];
  sections?: Section[];
  /** Genuine data tables only (layout-table noise is filtered out server-side). */
  tables?: Table[];
  annexes?: Annex[];
}

/** Why a document response carries no text. */
export type TextUnavailableReason =
  | "not_in_language"
  | "not_published_yet"
  | "no_machine_readable_rendition"
  | "too_large"
  | "unknown"
  | (string & {});

/** Pointer to a consolidated version (CONSLEG, CELEX sector 0) of a base act. */
export interface ConsolidatedVersionHint {
  /** e.g. `"02006R1907-20260622"` — pass back to `getDocument` (a normal, separately charged read). */
  celex: string;
  /** Consolidation date (`YYYY-MM-DD`), from the CELEX suffix. */
  date: string;
  /** `cellar` — Publications Office list; `corpus` — Cellar was unreachable, newest version LexAPI holds. */
  source: "cellar" | "corpus" | (string & {});
  /** `newestConsolidated` only — lower-case ISO codes the version exists in. */
  availableLanguages?: string[];
}

/**
 * Whether a document response carries its text, and if not, why. Present on
 * every document response. A text-unavailable document is a `200` with
 * metadata and `content: null` (billed 1 credit), not a 404.
 */
export interface TextAvailability {
  available: boolean;
  /** Absent when `available` is true. */
  reason?: TextUnavailableReason;
  retryable?: boolean;
  /**
   * ISO codes whose text could be served. `null` = unknown; `[]` = known to
   * be none. Those are different facts — do not collapse them.
   */
  availableLanguages?: string[] | null;
  /** Where EUR-Lex itself points for the text (e.g. the European Parliament site). */
  externalSource?: string;
  /** e.g. `"cellar-manifestations"`, `"parse-worker"` (our own `too_large` verdict). */
  source?: string;
  checkedAt?: string;
  /** Base acts only: newest consolidated version dated on or before today, in the requested language. */
  latestConsolidated?: ConsolidatedVersionHint;
  /** Base acts only: the next consolidated version dated after today, in the requested language. */
  upcomingConsolidated?: ConsolidatedVersionHint;
  /** Base acts only: the newest consolidated version when it has NO text in the requested language. */
  newestConsolidated?: ConsolidatedVersionHint;
}

/** Normalized metadata for a single document. */
export interface DocumentMetadata {
  /** Canonical CELEX. Always present on metadata responses. */
  celex?: string;
  /** Legacy alias for `celex` (metadata endpoint back-compat). */
  celexNumber?: string;
  /** `null` when the document is genuinely sparse — never `"Unknown Title"`. */
  title?: string | null;
  /**
   * Present only when `title` is NOT in the requested language: the ISO
   * 639-1 code of the language it is in (`en` for the English fallback).
   * Absent means the title is in the requested language.
   */
  titleLanguage?: string;
  /** Prose form of the document, e.g. `"Regulation"`. */
  documentType?: string | null;
  /** Stable enum slug for `documentType` (e.g. `"regulation"`). */
  documentTypeCode?: DocumentTypeCode | null;
  /** `null` for placeholder authors (e.g. consolidated texts' "Provisional data"). */
  author?: string | null;
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

/** Canonical EUR-Lex URLs for a document. */
export interface DocumentUrls {
  html?: string;
  metadata?: string;
  pdf?: string;
  xml?: string;
}

/** Fully-parsed document: metadata + structured content. */
export interface Document extends DocumentMetadata {
  /** ISO code of the language rendition actually served. */
  language?: string;
  /** Present only on a fallback — the language originally requested. */
  languageRequested?: string;
  /** Present only on a fallback — the language served instead. */
  languageFallback?: string;
  /**
   * `null` when EUR-Lex publishes this document's notice but not its text —
   * check `textAvailability.available` before reading it.
   */
  content?: DocumentContent | null;
  /** Present on every document response. */
  textAvailability?: TextAvailability;
  urls?: DocumentUrls;
  fetchedAt?: string;
  /** Monotonic corpus version of this CELEX (corpus-served documents). */
  version?: number;
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
  | "consolidated_text"
  | "abstract"
  | (string & {});

/** A single entry in a search results page. */
export interface SearchResult {
  /** Title with HTML entities decoded and sentence-spacing restored. */
  title?: string;
  /** Legacy field. Same value as `celex`. May be `""` for rare listings without a parseable CELEX. */
  celexNumber?: string;
  /** Canonical CELEX alias. `null` for rare listings without a parseable CELEX. */
  celex?: string | null;
  /** Legacy field. Same value as `documentType`. */
  form?: string | null;
  documentType?: string | null;
  documentTypeCode?: DocumentTypeCode | null;
  date?: string;
  dateOfDocument?: string | null;
  dateOfDocumentISO?: string | null;
  /** Qualifier EUR-Lex appends to the date (e.g. `"Date of signature"`). */
  dateType?: string | null;
  ecli?: string | null;
  /** EUR-Lex internal reference number, when listed. */
  internalNumber?: string | null;
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
  /**
   * Free-text search. Prefer 1–3 distinctive terms; quotes force
   * exact-phrase matching. `"*"` (or only wildcard/quote characters) means
   * no text constraint — a filter-only search.
   */
  query?: string;
  /** Bypass the 60-minute result cache and re-fetch from EUR-Lex. Same price. Default `false`. */
  fresh?: boolean;
  textScope?: TextScope;
  dateFrom?: string;
  dateTo?: string;
  year?: number | number[];
  month?: number | number[];
  /** Multi-value arrays fan out to one EUR-Lex search per resolved form code. */
  documentType?: OneOrMany<DocumentType>;
  author?: OneOrMany<Author>;
  procedure?: OneOrMany<Procedure>;
  domain?: Domain;
  /**
   * One subdomain or several. Several are ORed when the EUR-Lex web service
   * answers (`headers.searchSource === "soap"`, the normal path). If the
   * search falls back to EUR-Lex result pages (no `searchSource`), EUR-Lex
   * applies only the FIRST subdomain; the Cellar listing fallback does not
   * take several at all. Pass one subdomain when the result set must be exact.
   */
  subdomain?: OneOrMany<Subdomain>;
  language?: Language;
  /**
   * EUR-Lex result pages to fetch (3 credits per page, unfetched pages
   * refunded). Clamped to the subscription tier (FREE=1, STARTER=5,
   * PROFESSIONAL=20, BUSINESS/SCALE/ENTERPRISE=100); if clamped, the response
   * carries an `X-Warning` header (surfaced as `xWarning`).
   */
  maxPages?: number;
}

export interface SearchResponse extends CreditedResponse, WithResponseHeaders {
  searchParameters?: Omit<SearchRequest, "fresh" | "maxPages">;
  /** Total matching documents on EUR-Lex. */
  totalResults?: number;
  /** Total result pages available on EUR-Lex. */
  totalPages?: number;
  pagesFetched?: number;
  /** Number of results in this response. */
  resultCount?: number;
  results?: SearchResult[];
  /**
   * Present only when the search returned nothing: routes the caller to
   * semantic search (EUR-Lex keyword search is literal).
   */
  hint?: string;
  /**
   * `"corpus"` when EUR-Lex was unreachable and the answer came from the
   * LexAPI corpus mirror — always with `partial: true` (possibly incomplete,
   * title-only text matching).
   */
  source?: "corpus" | (string & {});
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
   * requested pages, or the answer came from the corpus fallback. Check
   * `partialReason`.
   */
  partial?: boolean;
  partialReason?: string;
  /**
   * Comma-joined dimensions on which a controller-side post-filter dropped
   * rows (`author`, `date`). `"date"` signals the recall-vs-pagination
   * trade-off: raise `maxPages` to widen recall on tight date filters.
   */
  postFilteredBy?: string;
  /** Requested types that resolve to no EUR-Lex form code (reported, not silently dropped). */
  ignoredDocumentTypes?: string[];
  fetchedAt?: string;
  /** SDK-added: the `X-Warning` response header (e.g. `maxPages` clamped). */
  xWarning?: string;
}

// ── POST /documentContent ───────────────────────────────────────────

export interface DocumentContentRequest {
  /** CELEX, incl. corrigenda (`32013R0952R(04)`) and consolidated forms (`02016R0679-20180524`). */
  celexNumber: string;
  /** Force a fresh upstream read, bypassing the corpus row and the HTML fetch cache (billed at the live rate). */
  bypassCorpus?: boolean;
  /**
   * Language rendition to return (whole document). Falls back to English
   * when unavailable — see `languageRequested`/`languageFallback`.
   */
  language?: Language;
  /**
   * Opt-in fallback when the requested language has no text: the first
   * accepted language that does is served instead (labelled like the
   * automatic English fallback).
   */
  acceptLanguages?: AcceptLanguages;
  /** Trim the response payload to the listed pieces. */
  include?: IncludeSelection;
  /** Alias accepted alongside `include`. */
  fields?: IncludeSelection;
  /** Narrow `content.articles` to one article (`art_17`, `17`, `Article 17`, `6a`). */
  articleId?: string;
}

export interface DocumentContentResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  document: Document;
}

// ── POST /documentContent/batch ─────────────────────────────────────

export interface DocumentContentBatchRequest {
  /** Truncated to the tier batch ceiling (FREE=1, STARTER=5, PROFESSIONAL=20, BUSINESS+=50). */
  celexNumbers: string[];
  bypassCorpus?: boolean;
  language?: Language;
  acceptLanguages?: AcceptLanguages;
  include?: IncludeSelection;
  fields?: IncludeSelection;
  articleId?: string;
}

/** One failed CELEX from a batch fetch — as the server sends it: `{ celex, error }`. */
export interface BatchDocumentError {
  /** The CELEX that failed. */
  celex?: string;
  /** Free-text failure message (not a stable slug). */
  error?: string;
  /** @deprecated Never sent by the server — read `celex`. */
  celexNumber?: string;
  /** @deprecated Never sent by the server — read `error`. */
  message?: string;
  [key: string]: unknown;
}

export interface DocumentContentBatchResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  /** Number of CELEX numbers in the request body. */
  requested: number;
  /** Number actually processed after tier clamping. */
  processed: number;
  successful: number;
  failed: number;
  /**
   * Returned documents that carry metadata but no text (`content: null`).
   * They stay in `documents[]`, not `errors[]`.
   */
  textUnavailable?: number;
  /**
   * Present and `true` when the request exceeded the tier batch ceiling.
   * Check `trimmedTo`/`trimmedReason` — trimmed entries were dropped
   * server-side (and not charged).
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
  /**
   * ONE document type. The endpoint applies only the first type of a list
   * (no fan-out, unlike `/search`), so the SDK accepts a single value.
   */
  documentType?: DocumentType;
  /** One author or several (sent as repeated params; EUR-Lex ORs them). */
  author?: OneOrMany<Author>;
  domain?: Domain;
  /**
   * ONE subdomain. A subdomain filter sends the request to EUR-Lex result
   * pages, where EUR-Lex reads only the first `DTS_SUBDOM` value
   * (lex-api `server/utils/urlBuilder.js`), so the SDK accepts a single value.
   */
  subdomain?: Subdomain;
  /** Result language (default `en`). */
  language?: Language;
  /** Maximum number of results to return. Default 50 (3 credits per ~10 results, tier-capped). */
  limit?: number;
}

export interface RecentDocumentsResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  /** Echo of the resolved query parameters (with computed `dateFrom`/`dateTo`). */
  parameters?: {
    days?: number;
    dateFrom?: string;
    dateTo?: string;
    documentType?: string | string[] | null;
    author?: string | string[] | null;
    domain?: string | null;
    subdomain?: string | string[] | null;
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
    /** Rows kept leniently because their language list was too short to trust. */
    partialMetadataKept?: number;
  };
  fetchedAt?: string;
  /** SDK-added: `X-Warning` response header, when present. */
  xWarning?: string;
}

// ── POST /documents/url ─────────────────────────────────────────────

export interface DocumentByUrlRequest {
  /** Any `eur-lex.europa.eu` URL containing a CELEX (path segment or `uri=` param). */
  url: string;
  /** Force a fresh upstream read (accepted by the server; billed at the live rate). */
  bypassCorpus?: boolean;
  include?: IncludeSelection;
  fields?: IncludeSelection;
  articleId?: string;
}

export interface DocumentByUrlResponse extends CreditedResponse, WithResponseHeaders {
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

export interface DocumentMetadataResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  /** Metadata-only — no `content`. Includes the canonical EUR-Lex URLs. */
  metadata: DocumentMetadata & {
    /**
     * Sector-3 base acts only, and only when a recent document read already
     * looked it up (cached ~24 h). Absent means "not looked up", not "none exists".
     */
    latestConsolidated?: ConsolidatedVersionHint;
    upcomingConsolidated?: ConsolidatedVersionHint;
    newestConsolidated?: ConsolidatedVersionHint;
    urls?: DocumentUrls;
  };
}

// ── POST /resolve ───────────────────────────────────────────────────

export type IdentifierType = "celex" | "url" | "eli" | "ecli";

/**
 * Which resolution path matched. `celex`/`url`/`eli` resolve purely from the
 * identifier; `ecli-corpus` / `eli-corpus` mean a corpus lookup answered.
 */
export type ResolvedVia = "celex" | "url" | "eli" | "ecli-corpus" | "eli-corpus" | (string & {});

export interface ResolveResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  /** Echo of the caller's input. */
  identifier: string;
  identifierType: IdentifierType;
  resolvedVia: ResolvedVia;
  celex: string;
  urls: DocumentUrls;
}

// ── Citations ───────────────────────────────────────────────────────

/**
 * Classification of a citation edge. `amendment`, `repeal` and
 * `corrigendum` are structural relations (from Cellar for legislation).
 */
export type CitationType =
  | "reference"
  | "amendment"
  | "repeal"
  | "corrigendum"
  | "implementation"
  | "legal-basis"
  | "proposal";

/**
 * Where a neighbour's title came from: the corpus (in the requested
 * language, or another language), a citation row, the edge itself, or
 * `unknown` (no title anywhere).
 */
export type TitleSource =
  | "corpus"
  | "corpus-fallback-lang"
  | "citation-source"
  | "citation-target"
  | "edge"
  | "unknown"
  | (string & {});

/**
 * Freshness of the target's inbound structural edges (amendment /
 * corrigendum / repeal), refreshed from Cellar at most once every 7 days.
 */
export interface RelationSync {
  source?: "cellar";
  /**
   * `fresh` (nothing to do), `refreshed` (during this request), `pending`
   * (refresh took >2.5 s and finishes in the background — this response
   * shows the previously stored edges), `cooldown`/`error` (Cellar failed
   * recently), `skipped` (see `reason`).
   */
  status?: "fresh" | "refreshed" | "pending" | "cooldown" | "error" | "skipped" | (string & {});
  /** Present when `status` is `skipped`. */
  reason?: "not-applicable" | "disabled" | "busy" | "budget" | (string & {});
  /** Last completed refresh when known; null when never refreshed. */
  syncedAt?: string | null;
}

/** Edge shape emitted on fresh extraction. */
export interface CitationEdgeSummary {
  /** The citing document. */
  sourceCelex?: string;
  targetCelex?: string;
  /** Whether the edge was found pointing out of (`outbound`) or into (`inbound`) the extracted document. */
  direction?: "outbound" | "inbound" | (string & {});
  citationType?: CitationType;
  /** Surrounding text around the citation on the source metadata page, when available. */
  contextSnippet?: string | null;
}

export interface CitationExtractResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  message?: string;
  /** Present on fresh extraction. Omitted when `alreadyExtracted` is true. */
  document?: {
    celexNumber?: string;
    title?: string | null;
  };
  /** Number of citation edges persisted (or already on file). */
  citationCount?: number;
  /** Edges that were just extracted. Omitted when `alreadyExtracted: true`. */
  citations?: CitationEdgeSummary[];
  /** True when the document had already been processed (settles at 1 credit). */
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
  titleSource?: TitleSource;
  /** Edges of this source in THIS page (raw citation rows). */
  citationCount?: number;
  /** A `…_RES` variant of the source was collapsed into this group. */
  hasResume?: boolean;
  /** A `…_SUM` variant of the source was collapsed into this group. */
  hasSummary?: boolean;
  citations?: CitationEdgeDetail[];
}

/** All edges from the source document into one target (cites grouping). */
export interface CitedDocumentGroup {
  celexNumber?: string;
  title?: string | null;
  titleSource?: TitleSource;
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
  /** Language preferred for neighbour titles (default `en`). */
  language?: Language;
}

export interface CitedByResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  /** The CELEX whose inbound edges are being listed. */
  targetDocument: string;
  /** Total inbound edges matching the filter (across all pages). */
  totalCitations?: number;
  /** Citing documents in THIS page (not the global distinct total). */
  uniqueDocuments?: number;
  limit?: number;
  offset?: number;
  citedBy: CitingDocumentGroup[];
  relationSync?: RelationSync;
}

export interface CitesResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  /** The CELEX whose outbound edges are being listed. */
  sourceDocument: string;
  totalCitations?: number;
  /** Cited documents in THIS page (not the global distinct total). */
  uniqueDocuments?: number;
  limit?: number;
  offset?: number;
  cites: CitedDocumentGroup[];
}

/** A neighbour in the citation graph, deduplicated across edge types. */
export interface CitationNeighbour {
  celexNumber?: string;
  title?: string | null;
  titleSource?: TitleSource;
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
  /** Language preferred for neighbour titles (default `en`). */
  language?: Language;
}

export interface CitationNetworkResponse extends CreditedResponse, WithResponseHeaders {
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
   * `network` arrays are empty and paging totals `null`. Do not treat an
   * empty partial network as "no citations".
   */
  partial?: boolean;
  partialReason?: "TIMEOUT";
  message?: string;
  /** The server-side budget that expired (only on partial responses). */
  timeoutMs?: number;
  relationSync?: RelationSync;
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

export interface CitationStatsResponse extends CreditedResponse, WithResponseHeaders {
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
  /** When these (cached) statistics were computed. */
  cachedAt?: string;
  /** How long the statistics are cached, in seconds. */
  cacheTtlSeconds?: number;
}

export interface CitationPathNode {
  celexNumber: string;
  /** Enriched at read time from the corpus where available. */
  title: string | null;
  titleSource?: TitleSource;
}

export interface CitationPathParams {
  /** Hop budget (default 3, max 8). */
  maxDepth?: number;
  /** Language preferred for node titles (default `en`). */
  language?: Language;
}

export interface CitationPathResponse extends CreditedResponse, WithResponseHeaders {
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
  titleSource?: TitleSource;
  /** Number of citation targets the related document shares with the seed. */
  sharedCount: number;
  sharedTargets?: string[];
}

export interface RelatedDocumentsParams {
  /** Max neighbours (default 10, max 50). */
  limit?: number;
  /** Language preferred for titles (default `en`). */
  language?: Language;
}

export interface RelatedDocumentsResponse extends CreditedResponse, WithResponseHeaders {
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
  /** Max results. Clamped to the tier ceiling (legislation: never above 50). Default 10. */
  limit?: number;
  /**
   * Drop results below this cosine similarity (wire: `min_score`).
   * Unset applies the upstream's default relevance floor of ~0.7 — if you
   * got fewer results than `limit`, the floor cut in; pass `0.5` (or lower)
   * to widen recall, `0` to disable the floor entirely.
   */
  minScore?: number;
  /** Language of returned content (a preference on legislation). Default `en`. */
  language?: SemanticLanguage;
  /**
   * Set `true` to receive the full text in each hit (wire:
   * `include: ["text"]`). By default each hit carries a ~600-char `snippet`
   * instead — about a 10-50x payload reduction.
   */
  includeText?: boolean;
  /** Free-form filter object forwarded to the semantic backend. */
  filters?: Record<string, unknown>;
}

/** Options for `semanticSearch` (case law) — adds HyDE query rewriting. */
export interface SemanticCaseLawSearchOptions extends SemanticSearchOptions {
  /**
   * Enable HyDE query rewriting (case-law endpoint only): an LLM drafts the
   * passage a relevant judgment would contain and retrieval fuses
   * plain-query and hypothetical-passage rankings.
   *
   * **Billing: 15 credits instead of 5**, and adds ~1–3 s of latency.
   * Best-effort: if generation fails the search falls back to plain
   * retrieval, the response reports `hyde: false`, and the 10-credit
   * premium is **automatically refunded**.
   */
  hyde?: boolean;
}

/** Options for `semanticLegislationSearch` — adds point-in-time `asOf`. */
export interface SemanticLegislationSearchOptions extends SemanticSearchOptions {
  /**
   * Answer each hit with the version in force on this date (`YYYY-MM-DD`,
   * 1952-01-01 … today UTC): the act as published before its first
   * consolidation, otherwise the consolidated version in force on that
   * date. Omit for the latest version.
   *
   * **Billing:** 5 credits for the search; each live fetch of a version the
   * corpus does not hold reserves 5 just before it starts and settles by
   * outcome (Cellar 4, browser 5, no text 1, failed/timed out 0) — at most
   * `SEMANTIC_ASOF_MAX_FETCHES` (default 3) per request. A fetch the pool
   * cannot cover is skipped (`asOfReason: "insufficient_credits"`). An
   * invalid `asOf` is a 400 (refunded in full).
   */
  asOf?: string;
}

/** Single case-law match from `/search/semantic`. */
export interface SemanticCaseLawResult {
  /**
   * Snapshot-scoped id — regenerated when the upstream index is rebuilt.
   * Do NOT store as a long-term identifier; use
   * `(metadata.celex_id, metadata.document_type)` for persistent joins.
   */
  case_id?: string | null;
  /** Cosine similarity, 0–1. */
  score?: number;
  /** Full matched-document text — present ONLY with `includeText: true`. */
  text?: string;
  /** ~600-character preview — present by default (replaced by `text` with `includeText`). */
  snippet?: string;
  case_name?: string | null;
  case_number?: string | null;
  ecli?: string | null;
  court?: string | null;
  parties?: string | null;
  /** LLM-generated digest of the ruling. */
  summary?: string | null;
  decision_date?: string | null;
  jurisdiction?: string | null;
  language?: string | null;
  /**
   * Structured analytics — present ONLY where the upstream extractor was
   * confident; omitted otherwise (never `null`).
   */
  outcome?: string;
  outcome_detail?: string;
  party_role?: string;
  claimed_amount?: number;
  awarded_amount?: number;
  currency?: string;
  award_percentage?: number;
  legal_area?: string | string[];
  legislation_cited?: string[];
  duration_days?: number;
  was_appealed?: boolean;
  appeal_outcome?: string;
  extraction_confidence?: number;
  extraction_model?: string;
  extracted_at?: string;
  /** Always includes `celex_id` when available — the persistent identity key. */
  metadata?: {
    celex_id?: string;
    document_type?: string | null;
    /** Position of the match within the judgment, when available. */
    paragraph_number?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Semantic-specific quota counters (legacy daily-call plans only). */
export interface SemanticUsageInfo {
  current?: number;
  limit?: number;
  remaining?: number;
  /** Semantic-quota units this call consumed (always 1). */
  unitsCharged?: number;
}

export interface SemanticCaseLawSearchResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  searchType?: "semantic-case-law";
  query?: string;
  resultCount?: number;
  results: SemanticCaseLawResult[];
  /**
   * Present only on best-effort responses (low-confidence hits) — its
   * presence is itself the low-confidence signal. Omitted (never `null`) otherwise.
   */
  hint?: string;
  /**
   * Present only when the request set `hyde: true`. `false` means generation
   * failed, the search fell back to plain retrieval, and the 10-credit
   * premium was refunded.
   */
  hyde?: boolean;
  /** Present only when HyDE ran: the LLM-drafted hypothetical judgment passage. */
  hypotheticalDocument?: string;
  /** Opaque upstream pass-through; shape not stable — use `tookMs` for timing. */
  metadata?: Record<string, unknown>;
  /** Server-measured wall-clock time for this request, in ms. */
  tookMs?: number;
  /** Legacy daily-call plans only. */
  semanticUsage?: SemanticUsageInfo;
}

/**
 * Why an `asOf` hit could not be answered for that date; the hit then keeps
 * its latest text (`asOfResolved: false`). Never silently wrong text.
 *
 * - `not_yet_adopted` — `asOf` is before the date of the act.
 * - `not_yet_in_force` — the act existed but had not yet entered into force.
 * - `no_longer_in_force` — `asOf` is after the act's end of validity.
 * - `in_force_dates_unknown` — the act's in-force dates could not be established.
 * - `not_in_language` — the version in force has no text in that language.
 * - `text_unavailable` — the version in force has no text.
 * - `article_not_in_version` — that article/annex/recital does not exist in the version in force.
 * - `part_not_resolvable` — the match is a part that cannot be looked up by date (e.g. a table).
 * - `article_unknown` — the hit has no article identity.
 * - `version_list_unavailable` — the list of consolidated versions could not be read.
 * - `version_lookup_cap` — too many version-list lookups (per request, or per account per minute).
 * - `fetch_budget_exhausted` — this request's live-fetch limit was reached.
 * - `fetch_pending` — that version is already being fetched; ask again shortly.
 * - `fetch_capacity` — too many live fetches in flight; ask again shortly.
 * - `fetch_failed` / `fetch_timeout` — the live fetch failed or ran out of time.
 * - `request_deadline` — the request ran out of time.
 * - `insufficient_credits` — the credit pool could not cover that fetch.
 * - `credit_check_failed` — the credit check did not answer; no fetch was made.
 */
export type AsOfReason =
  | "not_yet_adopted"
  | "not_yet_in_force"
  | "no_longer_in_force"
  | "in_force_dates_unknown"
  | "not_in_language"
  | "text_unavailable"
  | "article_not_in_version"
  | "part_not_resolvable"
  | "article_unknown"
  | "version_list_unavailable"
  | "version_lookup_cap"
  | "fetch_budget_exhausted"
  | "fetch_pending"
  | "fetch_capacity"
  | "fetch_failed"
  | "fetch_timeout"
  | "request_deadline"
  | "insufficient_credits"
  | "credit_check_failed"
  | (string & {});

/** Every documented {@link AsOfReason} value, in spec order (runtime list). */
export const AS_OF_REASONS = [
  "not_yet_adopted",
  "not_yet_in_force",
  "no_longer_in_force",
  "in_force_dates_unknown",
  "not_in_language",
  "text_unavailable",
  "article_not_in_version",
  "part_not_resolvable",
  "article_unknown",
  "version_list_unavailable",
  "version_lookup_cap",
  "fetch_budget_exhausted",
  "fetch_pending",
  "fetch_capacity",
  "fetch_failed",
  "fetch_timeout",
  "request_deadline",
  "insufficient_credits",
  "credit_check_failed",
] as const;

/** The version an `asOf` hit's text comes from. */
export interface AsOfVersion {
  celex?: string;
  /** Consolidation date; `null` for the act as published. */
  date?: string | null;
  kind?: "consolidated" | "as_published" | (string & {});
}

/** Single article-level match from `/legislation/semantic`. */
export interface SemanticLegislationResult {
  /** Index hit id (snapshot-scoped; `asof:<celex>:<ref>` when `asOf` swapped the text). */
  id?: string;
  /** Cosine similarity, 0–1 (of the indexed text — see `matchedVersion`). */
  score?: number;
  /** Full article text — present ONLY with `includeText: true`. */
  text?: string;
  /** Compact preview of the matched text — present by default. */
  snippet?: string;
  /** Article identifier (e.g. `art_17`) — usable as `articleId` on `getDocument`. */
  article_ref?: string | null;
  /** CELEX identifier of the parent legal act. */
  law_id?: string | null;
  law_title?: string | null;
  /** Language of the matched text (the request's `language` is a preference). */
  language?: string;
  section?: string | null;
  chapter?: string | null;
  exact_match_law_id?: boolean;
  /** `true` on a consolidated text; absent otherwise. */
  consolidated?: boolean;
  /** Consolidated texts only — the consolidation date (`YYYY-MM-DD`). */
  consolidatedAsOf?: string;
  /** Consolidated texts only — the act this text consolidates; cite it as the authentic source. */
  baseCelex?: string;
  /**
   * Consolidated texts only — "The act as amended, consolidated as of
   * <date>; not the authentic text. …" Only the Official Journal text is authentic.
   */
  consolidatedNote?: string;
  /** Present when the act as published matched the same article; its own match. */
  baseAct?: {
    law_id?: string;
    article_ref?: string | null;
    score?: number | null;
  };
  /** `asOf` requests only — echo of the request's `asOf`. */
  asOf?: string;
  /** `asOf` requests only — whether this hit carries the text in force on `asOf`. */
  asOfResolved?: boolean;
  /** Why `asOfResolved` is false; the hit then keeps its latest text. */
  asOfReason?: AsOfReason;
  /** `asOf` requests only — the version this hit's text comes from. */
  asOfVersion?: AsOfVersion;
  /**
   * Present when `asOf` swapped the text — the version the index matched
   * (`score` is its similarity, not the in-force text's).
   */
  matchedVersion?: {
    id?: string | null;
    law_id?: string;
    consolidatedAsOf?: string | null;
  };
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SemanticLegislationSearchResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  searchType?: "semantic-legislation";
  query?: string;
  resultCount?: number;
  results: SemanticLegislationResult[];
  /** `asOf` requests only — echo of the request's `asOf`. */
  asOf?: string;
  /** `asOf` requests only. */
  asOfSummary?: {
    /** Live fetches attempted, including failed and timed-out ones (those cost 0). */
    liveFetches?: number;
    /** Hits returned with `asOfResolved: false`. */
    unresolved?: number;
  };
  /** Present only on best-effort responses — see `SemanticCaseLawSearchResponse.hint`. */
  hint?: string;
  /** Opaque upstream pass-through; shape not stable — use `tookMs` for timing. */
  metadata?: Record<string, unknown>;
  tookMs?: number;
  /** Legacy daily-call plans only. */
  semanticUsage?: SemanticUsageInfo;
}

// ── National law ────────────────────────────────────────────────────
// Member-state (and non-EU, e.g. UK) legal orders LexAPI serves alongside
// EUR-Lex. BUSINESS and above get full access; FREE/STARTER/PROFESSIONAL get
// it within a monthly allowance of national calls (lex-api PR #306) —
// see `X-National-Limit`/`X-National-Remaining`/`X-National-Reset`
// (`ResponseHeaders.nationalAllowance`) and `NationalAllowanceExhaustedError`.
// A jurisdiction not yet launched answers 404, exactly like one that doesn't
// exist — call `getNationalCoverage()` first to see what is live.

/** Availability block shared by `legislation` and `caseLaw` on a coverage entry. */
export interface NationalCoverageAvailability {
  available: boolean;
  description?: string;
  /** Approximate document count. */
  documents?: number;
  /** Earliest date covered (`YYYY-MM-DD` or a year), when known. */
  from?: string;
}

/** `caseLaw` adds the courts covered. */
export interface NationalCaseLawCoverageAvailability extends NationalCoverageAvailability {
  courts?: string[];
}

/** Whether semantic search is indexed for this jurisdiction, per domain. */
export interface NationalSemanticSearchAvailability {
  legislation: boolean;
  caseLaw: boolean;
}

/** One upstream data source a jurisdiction's corpus is built from. */
export interface NationalSource {
  name: string;
  url: string;
  licence: string;
  attribution: string;
}

/** One jurisdiction's entry on `GET /national/coverage`. */
export interface NationalJurisdictionCoverage {
  /** ISO 3166-1 alpha-2, e.g. `"AT"`. Non-EU legal orders (e.g. `"UK"`) are included too. */
  code: string;
  name: string;
  /** Whether customers can call this jurisdiction's endpoints today. */
  live: boolean;
  /** `null` before launch. */
  launchedAt?: string | null;
  legislation: NationalCoverageAvailability;
  caseLaw: NationalCaseLawCoverageAvailability;
  semanticSearch: NationalSemanticSearchAvailability;
  sources: NationalSource[];
  /** When this jurisdiction's corpus was last synced. `null` if never. */
  lastSyncAt?: string | null;
}

/**
 * `GET /national/coverage` — public, free, no API key or allowance headers
 * required. Call this before `getNationalDocument` / `listNationalDocuments`
 * / `nationalSemanticSearch` / `nationalLegislationSemanticSearch` to check
 * whether a jurisdiction is live, so a 404 is never a surprise.
 */
export interface NationalCoverageResponse extends WithResponseHeaders {
  updatedAt: string;
  jurisdictions: NationalJurisdictionCoverage[];
}

/**
 * How a national lane labels the text it serves (`content.source.textBasis`
 * server-side) — present only for lanes that write it; absent elsewhere.
 */
export interface NationalTextBasis {
  /** e.g. `"as announced"`, `"official consolidated text"`, `"superseded"`, `"none"`. */
  basis: string;
  /** The date the text speaks for (never "valid until"). */
  asOf?: string;
  newerConsolidationExists?: boolean;
  newestPdfOnlyDate?: string;
  newerPdfOnly?: string[];
  amendedSince?: boolean;
  /** ELI of the act this text was consolidated from, when applicable. */
  textFrom?: string;
}

/** Summary fields shared by a `listNationalDocuments` row and a full `NationalDocument`. */
export interface NationalDocumentSummary {
  /** The national corpus id (e.g. `"AT-NOR-12345"`), analogous to a CELEX number. */
  id: string;
  /** ISO 3166-1 alpha-2 jurisdiction code. */
  jurisdiction: string;
  language: string;
  title?: string | null;
  documentType?: string | null;
  ecli?: string | null;
  eli?: string | null;
  dateOfDocument?: string | null;
  /** Monotonic corpus version for this id. */
  version?: number;
  fetchedAt?: string;
  /** Present only once a lane has confirmed the act is no longer in force (the last day in force). */
  validTo?: string;
  /** Present only alongside `validTo`. */
  inForce?: boolean;
}

/** Full national document — `GET /{jurisdiction}/documents/{id}`. */
export interface NationalDocument extends NationalDocumentSummary {
  /** `null` when the jurisdiction's source publishes no text for this id — check `textAvailability`. */
  content?: DocumentContent | null;
  textAvailability?: TextAvailability;
  /** The jurisdiction's source attribution — always show this to users alongside the text. */
  attribution: string;
  textBasis?: NationalTextBasis;
}

/**
 * `GET /{jurisdiction}/documents/{id}`. No `success` field (unlike the EU
 * document endpoints). Credit cost: every national read is a corpus read
 * (there is no live-fetch fallback) — reserved at the `document_fetch`
 * weight (5) and settled to the corpus-hit weight (1).
 */
export interface NationalDocumentResponse extends CreditedResponse, WithResponseHeaders {
  document: NationalDocument;
}

export interface NationalDocumentListParams {
  page?: number;
  /** Default 20, max 100. */
  limit?: number;
  /** Case-insensitive title search. */
  q?: string;
  /** Case-insensitive substring match on `documentType` (wire param: `type`). */
  documentType?: string;
  /** Repealed acts are hidden by default; `true` includes them. */
  includeRepealed?: boolean;
}

/**
 * `GET /{jurisdiction}/documents`. No `success` field. 3 credits per call
 * (flat — pagination does not multiply the price, unlike `search`).
 */
export interface NationalDocumentListResponse extends CreditedResponse, WithResponseHeaders {
  jurisdiction: string;
  total: number;
  page: number;
  limit: number;
  includeRepealed: boolean;
  results: NationalDocumentSummary[];
}

/** Filters honoured by `POST /{jurisdiction}/search/semantic` (unknown keys are rejected with 400). */
export interface NationalCaseLawFilters {
  court?: string;
  date_from?: string;
  date_to?: string;
  ecli?: string;
  language?: string;
  [key: string]: unknown;
}

/** Filters honoured by `POST /{jurisdiction}/legislation/semantic`. `law_id`/`in_force`/`law_type` are clausly's own names, accepted as aliases. */
export interface NationalLegislationFilters {
  id?: string;
  law_id?: string;
  inForce?: boolean;
  in_force?: boolean;
  documentType?: string;
  law_type?: string;
  language?: string;
  [key: string]: unknown;
}

/**
 * Options for `nationalSemanticSearch`. `hyde` is accepted for API
 * compatibility but is always a no-op here: the national index never
 * rewrites, so the response reports `hyde: false` (never `true`) when the
 * request set it, and billing stays the flat 5 credits (no 15-credit tier).
 */
export interface NationalSemanticCaseLawOptions extends SemanticSearchOptions {
  hyde?: boolean;
  filters?: NationalCaseLawFilters;
}

/** Options for `nationalLegislationSemanticSearch`. No `hyde`, no `asOf` — both are EU-only. */
export interface NationalSemanticLegislationOptions extends SemanticSearchOptions {
  filters?: NationalLegislationFilters;
}

/** Single hit from `nationalSemanticSearch`, same shape as {@link SemanticCaseLawResult} plus national fields. */
export interface NationalSemanticCaseLawResult extends SemanticCaseLawResult {
  /** The national corpus id this hit resolved to (also mirrored into `metadata.celex_id`). */
  documentId?: string;
  /** ISO 3166-1 alpha-2 jurisdiction code. */
  jurisdiction?: string;
  /** Present only once a lane has confirmed the act is no longer in force. */
  validTo?: string;
  /** Present only alongside `validTo`. */
  inForce?: boolean;
  attribution?: string;
}

/**
 * Single hit from `nationalLegislationSemanticSearch`, same shape as
 * {@link SemanticLegislationResult} plus national fields. NOTE: `in_force`
 * and `valid_to` are deliberately snake_case here — that is what the server
 * actually sends (a quirk of the national controller, unlike the camelCase
 * `inForce`/`validTo` used everywhere else in this SDK) — do not "fix" the
 * casing without changing the server first.
 */
export interface NationalSemanticLegislationResult extends SemanticLegislationResult {
  documentId?: string;
  jurisdiction?: string;
  /** Only ever sent as `false`, when a confirmed repeal overrides the hit toward NOT in force. */
  in_force?: false;
  /** Present only alongside `in_force: false`. */
  valid_to?: string;
  attribution?: string;
}

/**
 * `POST /{jurisdiction}/search/semantic` — national case-law semantic
 * search. Like the EU semantic endpoints, this route does not run
 * `attachCreditsEnvelope`, so `credits` is normally absent from the body
 * (optional via `CreditedResponse`).
 */
export interface NationalSemanticCaseLawResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  searchType?: "semantic-case-law";
  jurisdiction?: string;
  query?: string;
  resultCount?: number;
  results: NationalSemanticCaseLawResult[];
  /** Present only when the request set `hyde: true` — always `false` (see {@link NationalSemanticCaseLawOptions}). */
  hyde?: boolean;
  metadata?: Record<string, unknown>;
  hint?: string;
  /** The jurisdiction's source attribution — always show this to users alongside results. */
  attribution?: string;
  tookMs?: number;
  semanticUsage?: SemanticUsageInfo;
  subscription?: { tier?: SubscriptionTier; maxResults?: number };
}

/** `POST /{jurisdiction}/legislation/semantic` — national legislation semantic search. */
export interface NationalSemanticLegislationResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  searchType?: "semantic-legislation";
  jurisdiction?: string;
  query?: string;
  resultCount?: number;
  results: NationalSemanticLegislationResult[];
  metadata?: Record<string, unknown>;
  hint?: string;
  attribution?: string;
  tookMs?: number;
  semanticUsage?: SemanticUsageInfo;
  subscription?: { tier?: SubscriptionTier; maxResults?: number };
}

// ── Webhooks ────────────────────────────────────────────────────────

/** Operational state. `FAILED` is set automatically when one delivery fails all 7 attempts (~24 h). */
export type WebhookStatus = "ACTIVE" | "PAUSED" | "FAILED";

export type DeliveryStatus = "PENDING" | "SUCCESS" | "FAILED" | "RETRYING";

/**
 * Filters for `documents.new`, in the /search vocabulary but matched against
 * document TITLES and metadata. Every filter given must match; `{}` matches
 * every new EU-law document (sectors 1–6), never consolidated texts. A
 * `subdomain` REPLACES that default (`"consolidated"` alone = consolidated
 * texts only). Unsupported filters (`procedure`, `textScope: "text"`,
 * `domain: "NATIONAL_LAW"`, boolean operators, unknown types/authors) are
 * refused with 400 and a `details` list.
 */
export interface WebhookCriteria {
  /**
   * Every term (or "quoted phrase") must match whole words of the title
   * (case/accent-insensitive; 4+ char terms match word starts; `tax*`
   * matches word starts at any length). `OR`/`NOT`/`NEAR`/`-term` are refused.
   */
  query?: string;
  /** Same values as /search; `regulation`/`directive`/`decision` match every sub-type. */
  documentType?: OneOrMany<DocumentType | (string & {})>;
  /**
   * Same values as /search (`commission`, `council`, `parliament`,
   * `court-of-justice`/`cjeu`/`ecj`/`court`, `general-court`,
   * `civil-service-tribunal`, `ecb`, `eca`, `eesc`, `cor`, `efsa`, or codes
   * like `COM`). `member-states` and `ema` are refused.
   */
  author?: OneOrMany<string>;
  /** Lower-case subdomain names: `treaties`, `international`, `legislation`, `preparatory`, `case-law`, `consolidated`. */
  subdomain?: OneOrMany<string>;
  /** Lower bound on the document date (`YYYY-MM-DD`). */
  dateFrom?: string;
  dateTo?: string;
  year?: number | number[];
  /** Accepted for compatibility — all match titles. */
  textScope?: "title" | "title-text" | "any";
  domain?: "EU_LAW" | "ALL";
  language?: string;
}

/** Summary shape used in list responses. The `secret` is never included here. */
export interface WebhookListItem {
  id?: string;
  name?: string;
  url?: string;
  status?: WebhookStatus;
  searchCriteria?: WebhookCriteria | null;
  /**
   * What is wrong with the stored `searchCriteria`; empty when nothing is.
   * Non-empty only for criteria saved before a validation rule existed —
   * such criteria are skipped (never widened) until fixed with `update`.
   */
  criteriaErrors?: string[];
  /** Watched base-act CELEX numbers (`watchlist.changes`). */
  watchCelex?: string[];
  lastChecked?: string | null;
  lastTriggered?: string | null;
  consecutiveFailures?: number;
  /** Total delivery attempts ever made (success and failure combined). */
  deliveryCount?: number;
  createdAt?: string;
}

/** A single delivery attempt. */
export interface WebhookDelivery {
  id?: string;
  /** Present on `recentDeliveries` (raw rows); not on `/deliveries` items. */
  webhookId?: string;
  status?: DeliveryStatus;
  /** The JSON payload that was POSTed (or queued) to the webhook URL. */
  payload?: Record<string, unknown>;
  /** HTTP status code returned by the webhook URL. */
  responseStatus?: number | null;
  /** Truncated response body (max 500 chars). */
  responseBody?: string | null;
  errorMessage?: string | null;
  attemptCount?: number;
  nextRetryAt?: string | null;
  deliveredAt?: string | null;
  createdAt?: string;
  [key: string]: unknown;
}

/** Delivery retry schedule reported on `GET /webhooks/{id}`. */
export interface WebhookRetryPolicy {
  /** e.g. 7 */
  maxAttempts?: number;
  /** e.g. 24 */
  windowHours?: number;
  /** e.g. `[1, 5, 30, 120, 360, 900]` */
  delaysMinutes?: number[];
}

/** Full webhook details (no `secret`). */
export interface WebhookDetail {
  id?: string;
  name?: string;
  url?: string;
  status?: WebhookStatus;
  searchCriteria?: WebhookCriteria | null;
  criteriaErrors?: string[];
  watchCelex?: string[];
  lastChecked?: string | null;
  lastTriggered?: string | null;
  consecutiveFailures?: number;
  retryPolicy?: WebhookRetryPolicy;
  /** @deprecated No longer returned by the server — read `retryPolicy.maxAttempts`. */
  maxRetries?: number;
  createdAt?: string;
  updatedAt?: string;
  /** Up to 20 most recent delivery attempts, newest first. */
  recentDeliveries?: WebhookDelivery[];
}

export interface WebhookListResponse extends WithResponseHeaders {
  success: boolean;
  count?: number;
  webhooks: WebhookListItem[];
}

/** Needs `searchCriteria`, `watchCelex`, or both. */
export interface WebhookCreateRequest {
  /** User-friendly label for the webhook. */
  name: string;
  /** HTTPS endpoint to POST matching documents to. */
  url: string;
  /**
   * Optional HMAC-SHA256 signing secret. If omitted, the server generates
   * a 32-byte hex value and returns it in the create response — the ONLY
   * time it is exposed. Store it.
   */
  secret?: string;
  /** New documents matching these filters trigger a `documents.new` delivery. */
  searchCriteria?: WebhookCriteria;
  /**
   * Base-act CELEX numbers to watch — amendments, corrigenda, repeals and
   * new consolidated versions trigger a `watchlist.changes` delivery. Plan
   * limit per webhook: STARTER 100, PROFESSIONAL 500, BUSINESS 1000, SCALE
   * 2000, ENTERPRISE 5000.
   */
  watchCelex?: string[];
}

/**
 * Partial update — only the supplied fields are changed. `watchCelex`
 * replaces the whole list; `searchCriteria: null` removes the criteria (one
 * of the two must remain). Setting `status` to `ACTIVE` resets
 * `consecutiveFailures`; moving a `FAILED`/`PAUSED` webhook to `ACTIVE`
 * also re-queues its deliveries from the last 7 days that ran out of
 * retries (`requeuedDeliveries`).
 */
export interface WebhookUpdateRequest {
  name?: string;
  url?: string;
  searchCriteria?: WebhookCriteria | null;
  watchCelex?: string[];
  status?: WebhookStatus;
}

/** Returned by `POST /webhooks`. The `secret` is included here only. */
export interface WebhookCreateResponse extends WithResponseHeaders {
  success: boolean;
  message?: string;
  webhook: {
    id: string;
    name: string;
    url: string;
    /** HMAC-SHA256 signing secret. Store this — it is not returned again. */
    secret?: string;
    status: WebhookStatus;
    searchCriteria?: WebhookCriteria | null;
    watchCelex?: string[];
    createdAt: string;
  };
}

/** Returned by `PUT /webhooks/{id}` — summary fields only. */
export interface WebhookUpdateResponse extends WithResponseHeaders {
  success: boolean;
  message?: string;
  webhook: {
    id?: string;
    name?: string;
    url?: string;
    status?: WebhookStatus;
    searchCriteria?: WebhookCriteria | null;
    criteriaErrors?: string[];
    watchCelex?: string[];
    updatedAt?: string;
  };
  /** Present when the request set `status: "ACTIVE"` — deliveries queued again. */
  requeuedDeliveries?: number;
}

/** Returned by `GET /webhooks/{id}`. */
export interface WebhookResponse extends WithResponseHeaders {
  success: boolean;
  webhook: WebhookDetail;
}

/** Returned by `DELETE /webhooks/{id}`. */
export interface WebhookDeleteResponse extends WithResponseHeaders {
  success: boolean;
  message?: string;
}

/**
 * Result of a synchronous test delivery. `success: true` means the
 * upstream responded 2xx; non-2xx and network errors both yield
 * `success: false` plus a populated `delivery.errorMessage`. Test
 * deliveries are not recorded in the delivery history.
 */
export interface WebhookTestResponse extends WithResponseHeaders {
  success: boolean;
  message?: string;
  delivery: {
    status?: "SUCCESS" | "FAILED";
    responseStatus?: number | null;
    /** Truncated upstream response body (max 500 chars). */
    responseBody?: string | null;
    errorMessage?: string | null;
  };
}

export interface WebhookDeliveriesParams {
  /** Max deliveries to return. Default 50. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
}

export interface WebhookDeliveriesResponse extends WithResponseHeaders {
  success: boolean;
  /** Total deliveries for this webhook (across all pages). */
  total?: number;
  limit?: number;
  offset?: number;
  deliveries: WebhookDelivery[];
}

// ── Webhook delivery payloads (what LexAPI POSTs to your URL) ────────

/** A document as delivered by `documents.new` and `watchlist.changes`. */
export interface WebhookChangeDocument {
  celex?: string;
  /** English title (another official language when no English title exists yet); null if metadata never arrived. */
  title?: string | null;
  url?: string;
  documentType?: string | null;
  documentTypeCode?: string | null;
  /** Publications Office resource-type codes, e.g. `["CONS_TEXT"]`. */
  resourceTypes?: string[];
  author?: string | null;
  authorCodes?: string[];
  dateOfDocumentISO?: string | null;
  /** The document date as dd/mm/yyyy. */
  dateOfDocument?: string | null;
  /** Consolidated versions only — the date the version applies from (may be in the future). */
  consolidationDate?: string | null;
  /** When the document appeared on EUR-Lex — the clock webhooks match on. */
  addedAt?: string | null;
  /** Upper-case ISO codes with a published expression. Check before fetching a consolidated version. */
  availableLanguages?: string[];
  /** Alias of `celex` (earlier payload shape). */
  celexNumber?: string;
  /** Alias of `documentType` (earlier payload shape). */
  form?: string | null;
}

/** Fields shared by every signed delivery. */
export interface WebhookDeliveryEnvelope {
  /** Time of THIS attempt (re-signed on every retry) — use it for a replay window. */
  timestamp: string;
  webhook: { id: string; name: string };
  /** `id` is stable across retries (also `X-Webhook-Delivery`) — dedupe on it. Absent on `webhook.test`. */
  delivery?: { id: string; attempt: number };
}

export interface WebhookDocumentsNewPayload extends WebhookDeliveryEnvelope {
  event: "documents.new";
  searchCriteria?: WebhookCriteria | null;
  data: {
    /** Documents in this delivery (max 100). */
    count: number;
    /** Every new match from the same hourly check — larger than `count` when split across deliveries. */
    totalAvailable?: number;
    documents: WebhookChangeDocument[];
  };
}

export type WatchlistRelation =
  | "amended_by"
  | "corrected_by"
  | "repealed_by"
  | "consolidated_version"
  | (string & {});

export interface WebhookWatchlistChange {
  watchedCelex: string;
  relation: WatchlistRelation;
  document: WebhookChangeDocument;
}

export interface WebhookWatchlistChangesPayload extends WebhookDeliveryEnvelope {
  event: "watchlist.changes";
  data: {
    /** Changes in this delivery (max 100). */
    count: number;
    changes: WebhookWatchlistChange[];
  };
}

/** Sent by `webhooks.test()`. */
export interface WebhookTestPayload extends WebhookDeliveryEnvelope {
  event: "webhook.test";
  data: {
    message: string;
    searchCriteria?: WebhookCriteria | null;
  };
}

/** Discriminated union of every payload LexAPI delivers — switch on `event`. */
export type WebhookPayload =
  | WebhookDocumentsNewPayload
  | WebhookWatchlistChangesPayload
  | WebhookTestPayload;

// ── Point-in-time versions ──────────────────────────────────────────

/**
 * One entry in a document's version history.
 *
 * Versions are LexAPI *observation snapshots* (content-hash changes between
 * fetches), not legal in-force reconstructions — for the text in force on a
 * date use a consolidated CELEX, or `semanticLegislationSearch({ asOf })`.
 * `fetchedAt` is when THIS version was fetched — version N is "current"
 * from there until version N+1's `fetchedAt`.
 */
export interface VersionEntry {
  version: number;
  isCurrent: boolean;
  /**
   * Equal hashes mean no text change. A different hash usually means EUR-Lex
   * changed the text — or the current version was re-parsed in place by an
   * improved parser.
   */
  contentHash: string;
  fetchedAt: string;
  title?: string | null;
  documentType?: string | null;
  documentTypeCode?: string | null;
  /** Present on single-snapshot responses only (not in history listings). */
  parsedContent?: Record<string, unknown> | null;
}

export interface DocumentVersionsResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  celex: string;
  language: string;
  currentVersion: number;
  /** When the document first entered the corpus — history starts here. */
  trackedSince: string;
  /** Server restatement of the observation-snapshot semantics. */
  semantics: string;
  /** Newest first; the current version is included and flagged. */
  versions: VersionEntry[];
}

export interface DocumentVersionResponse extends CreditedResponse, WithResponseHeaders {
  success: boolean;
  celex: string;
  language: string;
  /** Present on `/at/{date}` responses only — the requested date. */
  asOf?: string;
  semantics: string;
  document: VersionEntry;
  /** SDK-added: mirrors the `X-Corpus-Version` response header. */
  corpusVersion?: number;
}

/** Shared params for the version endpoints. */
export interface VersionParams {
  /** 2-letter ISO language of the tracked corpus row (default `en`). */
  language?: string;
}
