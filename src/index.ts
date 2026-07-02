export {
  LexAPI,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  type LexAPIOptions,
  type CallOptions,
} from "./client.js";
export type { RetryOptions } from "./http.js";
export {
  LexAPIError,
  NotFoundError,
  InvalidCelexError,
  InvalidUrlError,
  InvalidParamsError,
  AuthenticationError,
  RateLimitedError,
  TierForbiddenError,
  CreditsExhaustedError,
  UpstreamError,
  TimeoutError,
  InternalServerError,
  NetworkError,
  type ErrorCode,
} from "./errors.js";
export { getCreditUsage, type CreditUsage } from "./credits.js";
export type {
  SubscriptionTier,
  Language,
  Domain,
  Subdomain,
  DocumentType,
  Author,
  Procedure,
  TextScope,
  SubscriptionInfo,
  UsageInfo,
  CreditsInfo,
  CreditedResponse,
  InfoSearchFilters,
  InfoResponse,
} from "./types.js";
export { VERSION } from "./version.js";
