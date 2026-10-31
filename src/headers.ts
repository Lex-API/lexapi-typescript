/**
 * LexAPI response headers, parsed into one typed object.
 *
 * Several facts are only reported in headers — which upstream answered (and
 * therefore what a document read settles at), whether a search came from
 * the result cache, rate-limit headroom — so every JSON response the SDK
 * returns carries them as `result.headers`. Absent headers are `undefined`.
 */

/** Draft-6 IETF `RateLimit-*` headers (sent on every `/api/v1` response). */
export interface RateLimitInfo {
  /** Requests allowed per window (`RateLimit-Limit`). */
  limit?: number;
  /** Requests left in the current window (`RateLimit-Remaining`). */
  remaining?: number;
  /** Seconds until the window resets (`RateLimit-Reset` — a delta, not a timestamp). */
  reset?: number;
  /** e.g. `"120;w=60"` (`RateLimit-Policy`). */
  policy?: string;
}

/**
 * How a `/documentContent/batch` was served. Counts overlap and do not map
 * one-to-one onto prices: `liveFetches` is every item that needed a fetch
 * and was not served by Cellar or an OJ issue (so it includes failed and
 * text-unavailable items), and `textUnavailable` overlaps the other buckets.
 */
export interface BatchSourceCounts {
  /** Items served from the LexAPI corpus (`X-Batch-Corpus-Hits`). */
  corpusHits?: number;
  /** Items answered by the Publications Office Cellar API (`X-Batch-Cellar-Served`). */
  cellarServed?: number;
  /** Items recovered from an Official Journal issue (`X-Batch-OJ-Recovered`). */
  ojRecovered?: number;
  /** Items that needed a fetch not served by Cellar/OJ — includes failed and text-unavailable ones (`X-Batch-Live-Fetches`). */
  liveFetches?: number;
  /** Items returned with metadata but no text (`X-Batch-Text-Unavailable`). */
  textUnavailable?: number;
}

export interface ResponseHeaders {
  /**
   * Which source answered (`X-Source`): `corpus` (1 credit), `cellar` /
   * `cellar-oj` (4 credits), `live` (browser fetch, 5 credits).
   */
  source?: "corpus" | "cellar" | "cellar-oj" | "live" | (string & {});
  /** `/search` upstream (`X-Search-Source`): `soap`, `cellar`, `corpus`; absent for EUR-Lex result pages. */
  searchSource?: "soap" | "cellar" | "corpus" | (string & {});
  /** `/search` result cache (`X-Search-Cache`): `hit`, `miss`, `bypass`. */
  searchCache?: "hit" | "miss" | "bypass" | (string & {});
  /** Language rendition actually served (`X-Language`). */
  language?: string;
  /** Present only when another language was served instead (`X-Language-Fallback`). */
  languageFallback?: string;
  /** `false` when the document has metadata but no text (`X-Text-Available`). */
  textAvailable?: boolean;
  /** Monotonic corpus version for this CELEX (`X-Corpus-Version`). */
  corpusVersion?: number;
  /** When the current corpus version was fetched (`X-Corpus-FetchedAt`). */
  corpusFetchedAt?: string;
  /** Internal live-fetch cache state, informational (`X-Cache`). */
  cache?: string;
  /** Tier clamping notice (`X-Warning`). */
  warning?: string;
  /** Requested document types with no EUR-Lex form code (`X-Ignored-DocumentTypes`). */
  ignoredDocumentTypes?: string[];
  /** Post-filter dimensions (`X-PostFiltered-By`). */
  postFilteredBy?: string;
  /** Rows kept by the post-filter (`X-PostFiltered-Kept`). */
  postFilteredKept?: string;
  /** Number of EUR-Lex searches a multi-value `documentType` fanned out to (`X-DocumentType-FanOut`). */
  documentTypeFanOut?: number;
  /** `/documents/recent` language post-filter (`X-Language-Filter`, `X-Language-Kept`). */
  languageFilter?: string;
  languageKept?: string;
  /** `/documentContent/batch` source breakdown. */
  batch?: BatchSourceCounts;
  /** Rate-limit headroom for this API key. */
  rateLimit?: RateLimitInfo;
  /** Raw `Retry-After` header (delta-seconds or HTTP-date), sent on per-minute 429s. */
  retryAfter?: string;
  /**
   * API contract version the server implements (`X-LexAPI-Version`, e.g.
   * `2.1.0`). Sent on every response the LexAPI application itself produces
   * (lex-api ≥ API 2.1.0) — its absence on an error means a proxy answered.
   */
  apiVersion?: string;
  /** Deployed build (`X-LexAPI-Release`, e.g. `2.1.0+633eb67`) — quote it in bug reports. */
  release?: string;
  /** Rows kept by the `/documents/recent` lenient language filter (`X-Language-Partial-Kept`). */
  languagePartialKept?: number;
  /** Age in seconds of a cached answer (`X-Cache-Age`). */
  cacheAge?: number;
  /**
   * National-law monthly call allowance for plans below BUSINESS
   * (`X-National-Limit`/`X-National-Remaining`/`X-National-Reset`). Sent on
   * the four national document/semantic endpoints for FREE/STARTER/
   * PROFESSIONAL callers only — absent for BUSINESS/SCALE/ENTERPRISE and
   * `getNationalCoverage`. A used-up allowance is a
   * 402 `NationalAllowanceExhaustedError`, not a header you need to poll.
   */
  nationalAllowance?: {
    limit?: number;
    remaining?: number;
    /** ISO date-time: start of the next UTC month. */
    resetsAt?: string;
  };
}

/** Minimal `Headers` surface (works with polyfilled / injected fetch implementations). */
interface HeaderGetter {
  get(name: string): string | null;
}

function str(headers: HeaderGetter, name: string): string | undefined {
  const value = headers.get(name);
  return value === null ? undefined : value;
}

function int(headers: HeaderGetter, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Drop `undefined` keys so the object only shows headers that were present. */
function compact<T>(obj: Record<string, unknown>): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? (out as T) : undefined;
}

/** Parse the LexAPI headers off a fetch `Response` (or any `Headers`). */
export function parseResponseHeaders(source: { headers: HeaderGetter } | HeaderGetter): ResponseHeaders {
  const h: HeaderGetter = "headers" in source ? source.headers : source;
  const textAvailable = str(h, "x-text-available");
  const ignored = str(h, "x-ignored-documenttypes");
  const parsed = {
    source: str(h, "x-source"),
    searchSource: str(h, "x-search-source"),
    searchCache: str(h, "x-search-cache"),
    language: str(h, "x-language"),
    languageFallback: str(h, "x-language-fallback"),
    textAvailable: textAvailable === undefined ? undefined : textAvailable !== "false",
    corpusVersion: int(h, "x-corpus-version"),
    corpusFetchedAt: str(h, "x-corpus-fetchedat"),
    cache: str(h, "x-cache"),
    warning: str(h, "x-warning"),
    ignoredDocumentTypes: ignored === undefined ? undefined : ignored.split(",").filter(Boolean),
    postFilteredBy: str(h, "x-postfiltered-by"),
    postFilteredKept: str(h, "x-postfiltered-kept"),
    documentTypeFanOut: int(h, "x-documenttype-fanout"),
    languageFilter: str(h, "x-language-filter"),
    languageKept: str(h, "x-language-kept"),
    batch: compact<BatchSourceCounts>({
      corpusHits: int(h, "x-batch-corpus-hits"),
      cellarServed: int(h, "x-batch-cellar-served"),
      ojRecovered: int(h, "x-batch-oj-recovered"),
      liveFetches: int(h, "x-batch-live-fetches"),
      textUnavailable: int(h, "x-batch-text-unavailable"),
    }),
    retryAfter: str(h, "retry-after"),
    apiVersion: str(h, "x-lexapi-version")?.trim() || undefined,
    release: str(h, "x-lexapi-release"),
    languagePartialKept: int(h, "x-language-partial-kept"),
    cacheAge: int(h, "x-cache-age"),
    rateLimit: compact<RateLimitInfo>({
      limit: int(h, "ratelimit-limit"),
      remaining: int(h, "ratelimit-remaining"),
      reset: int(h, "ratelimit-reset"),
      policy: str(h, "ratelimit-policy"),
    }),
    nationalAllowance: compact<NonNullable<ResponseHeaders["nationalAllowance"]>>({
      limit: int(h, "x-national-limit"),
      remaining: int(h, "x-national-remaining"),
      resetsAt: str(h, "x-national-reset"),
    }),
  };
  return compact<ResponseHeaders>(parsed) ?? {};
}
