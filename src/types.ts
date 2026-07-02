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
