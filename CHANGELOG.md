# Changelog

All notable changes to `@lexapi/client`. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: [SemVer](https://semver.org/) — while the package is `0.x`, a **minor** bump may contain
breaking changes (documented below with a migration note); `npm install @lexapi/client@^0.1.0` never
picks up `0.2.0` on its own.

## [Unreleased]

Type-level changes to check when upgrading:

- `NationalSemanticLegislationResult` fields it shares with the EU hit, previously typed `unknown`,
  now have their types (`score?: number`, `asOfVersion?: NationalAsOfVersion`, …). Code that
  redeclares them in an `interface … extends`, or assigns a fixture of another shape, must follow.
- An `interface … extends` or subclass that redeclares a newly added optional member (for example
  `observedFrom`, `asOf`, `asOfSummary`) with another type must follow.
- `getDocumentAtDate` returns `DocumentAtDateResponse`, which is assignable to the
  `DocumentVersionResponse` it returned before.
- `PaymentPastDueError` is a subclass of `TierForbiddenError`. Where a value's type is a union
  that includes `PaymentPastDueError`, the `false` branch of `instanceof TierForbiddenError` no
  longer includes it. At run time, a `TierForbiddenError` branch placed before a
  `PaymentPastDueError` branch takes failed payments too.
- `NotFoundError` has new read-only accessors (`reason`, `beforeTracking`, `boundaryUnknown`,
  `trackedSince`, `inForceLookup`, `candidates`, `candidatesTruncated`). A subclass that declares a
  property of the same name must rename it.

### Added

- **National `asOf` labels** (API 2.29.0): `nationalLegislationSemanticSearch` takes `asOf`
  (a `YYYY-MM-DD` string) and sends it; before, the option did not exist. Each hit carries `asOf`, `asOfResolved`, `asOfReason` (`NationalAsOfReason`, runtime list
  `NATIONAL_AS_OF_REASONS`) and, when resolved, `asOfVersion: NationalAsOfVersion`
  (`{ kind: "current_unit", validFrom, validTo, sourceId, checkedAt }`); the response adds `asOf`
  and `asOfSummary`. The search runs over today's texts only: a hit is resolved only when the
  publisher's dates, as of LexAPI's last recorded read of the act (`checkedAt`), show today's
  wording already applied on the date; an unresolved hit keeps today's wording, which is not
  established as the text for the date. LexAPI holds such dates for Austria and Spain.
  `isNationalAsOfVersion(v)` tells it from the EU `AsOfVersion` by `kind`.
- **Snapshot timing on the version endpoints** (API 2.28.0): `observedFrom` on every version
  (`listDocumentVersions`, `getDocumentVersion`, `getDocumentAtDate`): when the version began in
  LexAPI's fetch history, `null` when LexAPI has no record of it. `getDocumentAtDate` now returns `DocumentAtDateResponse`
  (a `DocumentVersionResponse` with `kind: "observation_snapshot"`, `document.observedUntil`,
  `inForceLookup`, `dateInFuture` and `xWarning`). These are LexAPI's fetch snapshots, not the law
  in force on a date; for the version of an EU act for a date use `legislationAsOf`.
- **`NotFoundError` details** (API 2.28.0): `reason` (`details.reason`), `beforeTracking` (with
  `trackedSince` and `inForceLookup`) and `boundaryUnknown` (with `candidates` —
  `{ version, fetchedAt, observedFrom }[]`, at most 10, `[]` when none — and
  `candidatesTruncated`) for the 404s of `getDocumentAtDate`. Read from `details` only, when it is
  a plain object. `unknownEndpoint` is unchanged.
- **In-force label** (API 2.19.0): `inForce`, `notInForceReason`, `endOfValidity`,
  `entryIntoForce` (`InForceLabel`, `NotInForceReason`) on documents (`getDocument`,
  `getDocumentsBatch`, `getDocumentByUrl`), on `getDocumentMetadata`'s `metadata` and on
  `semanticLegislationSearch` hits; the `inForce` option of `semanticLegislationSearch` (sent when
  set) and the response's `inForceFilter`.
- **Provenance** (API 2.20.0): `provenance` and `fieldProvenance` (`FieldProvenance`) on documents,
  `getDocumentMetadata`'s `metadata`, single version snapshots and EU semantic hits
  (`EuSemanticCaseLawResult`, `EuSemanticLegislationResult`, now the element types of `results`);
  `fieldProvenance` on `semanticSearch` responses with `hypotheticalDocument`.
- **`/info` semantic result caps** (API 2.24.0): `subscription.maxSemanticResults` and
  `subscription.maxSemanticLegislationResults`.
- **`legislationAsOf({ document, asOf, provision?, language? }, options?)`** (`POST /legislation/as-of`,
  1 credit when no text is fetched; 4, or 5 live from EUR-Lex, when the provision's text is fetched,
  whatever the answer; 1 if the fetch fails). **Requires LexAPI API 2.26.0.** The version of
  an EU regulation, directive or decision listed for a date — the newest consolidated version dated
  on or before it, or the act as published in the Official Journal — and optionally one article,
  annex or recital range of it. An answer that cannot be established is returned, not thrown:
  `asOfResolved: false` with an `asOfReason`; use a text only when `asOfResolved` is `true`.
  Consolidated versions have no legal force (`baseCelex` names the authentic act). Types:
  `LegislationAsOfRequest`, `LegislationAsOfResponse`, `LegislationAsOfVersion`,
  `LegislationAsOfAct`, `LegislationAsOfProvision`, `AsOfLookupReason`, `Provenance`; runtime list
  `AS_OF_LOOKUP_REASONS`.
- **`PaymentPastDueError`** (403, code `PAYMENT_PAST_DUE`, API 2.27.0): a subscription payment failed
  and was not completed in time; API requests are refused until the payment succeeds. Never
  retried. `billingUrl` is where to pay the open invoice; `accessEndedAt` is when access ended, when
  the API says so. It extends `TierForbiddenError`. Before API 2.27.0 a failed
  payment was refused at once with a 403 without a code, raised as `TierForbiddenError`.
  `"PAYMENT_PAST_DUE"` is added to `ErrorCode`. Earlier SDK versions raise the base `LexAPIError`
  for this code.
- **`NotFoundError.unknownEndpoint`**: `true` when the API (2.27.0 or later) has no such endpoint: a
  mistyped path, a method newer than the API, or a national route for a country that is not
  available. Always `false` on APIs before 2.27.0; there the message contains "Unknown API
  endpoint".
- **`LexAPIError.bodyExcerpt`**: the first 200 characters (code points) of a response body that is
  not JSON (`undefined` otherwise), read through a getter; it is not an own property of the error.
  It may contain document text: do not show it to a model or log it by default.
  `LexAPIErrorContext` takes it too, and `LexAPIError.fromResponse` takes it as an optional fifth
  parameter.

### Changed

- A `2xx` answer that is not the documented shape now throws `InvalidResponseError`; before, it
  could be read as an empty result. This covers an empty body (also a `204`, except for
  `webhooks.delete`), JSON that is not an object, `success: false` (when the body carries the API's
  error envelope, that error is thrown instead; `webhooks.test` still resolves with
  `success: false`), and a list field that is not a list or holds items that are not objects.
  `results` is required on `search`, `semanticSearch`, `semanticLegislationSearch` and the national
  semantic searches; `document` must be an object on `getDocument`, `getDocumentByUrl`,
  `getDocumentVersion`, `getDocumentAtDate` and `getNationalDocument` (and `document.content`, when
  present, an object whose `articles` is a list of objects); on `legislationAsOf`, `document` must
  be a non-empty string, `asOfResolved` a boolean, and `act` and `provenance` objects. Unknown extra fields are still accepted. To tell a malformed answer from an
  empty result, catch `InvalidResponseError`; an API error carried by a `2xx` answer keeps that
  status.
- The message for a `2xx` body that is not JSON changed: it was, for example, `Expected a JSON body
  (HTTP 200, content-type text/html; charset=utf-8)` and is now `Expected JSON, got text/html that
  does not parse as JSON (1213 bytes)`. Do not match on error message text; use `code`.
- A `2xx` body of only whitespace now throws `InvalidResponseError`; it returned an empty object.
- A `2xx` JSON body that is not valid UTF-8 now throws `InvalidResponseError`; before, the invalid
  bytes were replaced and the body was parsed.
- An error body that is not valid UTF-8 is treated as not JSON: the error carries the code derived
  from the status and the message `HTTP <status>`.

- Retry hints are read strictly (SDK contract §1.2): `Retry-After` and `RateLimit-Reset` as decimal
  seconds or, for `Retry-After`, an RFC 9110 HTTP-date (IMF-fixdate or RFC 850 ending in `GMT`,
  `UTC` or `+0000`; asctime has no zone and is read as UTC). Dates with other zone names,
  impossible dates and other text are ignored; a body `retryAfter` only as a
  number ≥ 0. An unusable hint counts as none: the retry uses the normal back-off, a legacy 429 with
  `usage.resetsAt` and no usable hint is a quota 429, and a national 503 whose only hint is unusable
  is not retried.
- Figures that are not usable numbers read as absent: integer headers (`result.headers`, export
  counts) accept only digits up to 2^53−1, and `getCreditUsage` ignores a figure that is not a finite
  number or a `resetsAt` that is not a string.
- The iterators throw `InvalidResponseError` when the server stops advancing: a cites/cited-by page
  echoing another `offset`, a national `nextCursor` already sent or not a string, or, without
  `totalEdges`/`offset` (or a deliveries `total`), three pages in a row that repeat the one before.
  The page that shows the stall is not yielded and is on `err.body`. Cites/cited-by walks also end
  once the offset reaches `totalEdges`. A national walk continues only while `hasMore` is `true`.
  A starting `offset`/`limit` that is not a non-negative (positive) integer is a `RangeError`.
- `PaymentPastDueError` extends `TierForbiddenError`: an `instanceof TierForbiddenError` check also
  catches a failed payment, as it did for the 403 without a code that APIs before 2.27.0 send.
  Check `PaymentPastDueError` first to tell the two apart. `TierForbiddenError`'s constructor takes
  an optional sixth parameter, the code (`"TIER_FORBIDDEN"` by default).
- `verifyWebhook` decodes the body as strict UTF-8 before parsing it: a body that is not valid
  UTF-8 (an invalid or truncated sequence, an encoded surrogate, an overlong form, latin-1 text) is
  `WebhookSignatureError("malformed_body")`, like a body that is not JSON. Before, invalid bytes
  were replaced with U+FFFD and the body was parsed. One leading byte order mark is ignored, also
  at the start of a string body, which is read as its UTF-8 encoding (the bytes the signature
  covers). The signature check is unchanged.
- A 429 whose top-level `code` or typed `error.code` is `QUOTA_EXHAUSTED` is a quota 429
  (`RateLimitedError`, `quotaExhausted`, not retried) whatever other code the body carries.

### Fixed

- `NationalSemanticLegislationResult` typed the fields it shares with the EU hit (`id`, `score`,
  `text`, `snippet`, `chapter`, `exact_match_law_id`, `metadata`) as `unknown`; they now have their
  types. Other keys are still readable as `unknown`.
- `InvalidResponseError` no longer carries the response text on `body`, where `console.log(err)`
  and `JSON.stringify(err)` printed it. The excerpt is on `bodyExcerpt`; for JSON of the wrong shape
  the parsed value is on `body`, read through a getter and not an own property of the error. The
  constructor's third argument is that parsed value.
- An error body whose `code`, `message` or `error` is an empty string, or whose `error` is an array,
  is read as if that field were absent. Before, an empty `message` replaced `HTTP <status>`, and an
  array `error` was taken for the typed envelope.
- `AsOfReason` and `AS_OF_REASONS` (`semanticLegislationSearch` with `asOf`) now include
  `amendment_not_consolidated`, which the API returns since 2.25.0.
- `fetch` is now called correctly on runtimes that require it to be invoked on the global object
  (Cloudflare Workers, browsers) — both the default and the runtime's own `fetch` passed as the
  `fetch` option. The default is also looked up on each request, so a `globalThis.fetch` replaced
  after the client is created is the one used.
- A runtime with no global `fetch` and no `fetch` option now fails at construction with a clear
  error. Previously a `globalThis.fetch` set to `undefined` constructed and failed at the first call.
- Waits and timeouts longer than the timer limit (2^31−1 ms) no longer fire at once: a huge server
  wait with `maxDelayMs: Infinity`, or a `timeoutMs` above the limit, is clamped to it.
  `timeoutMs: Infinity` sets no limit.
- An asctime `Retry-After` date (`Sun Nov  6 08:49:37 1994`) is read as UTC, not local time.
- `paginateNationalDocuments` checks `limit` before the first request: a value that is not a
  positive integer is a `RangeError`, as on the other iterators. Before, it was sent.
- Cites/cited-by walks: a page carrying `totalEdges` or an echoed `offset` ends a run of repeated
  pages but is still the page the next one is compared with. Before, the comparison restarted
  after it, so a server repeating the same page threw one request later.
- Cites/cited-by walks: a group with a `citationCount` of 0 and a non-empty edge list counts its
  list. Before, it counted 0 and the walk ended after that page.
- A page without its list ended the walk with a `TypeError`; a `citationCount` that is not a count
  mis-stepped the offset (a walk could end early or re-request rows). Both are handled now.
- An export `_error` line whose value or `code` is an array nested too deep to turn into text ends
  the stream with `IncompleteExportError`. Before, iteration threw a `RangeError`.
- `verifyWebhook` on a correctly signed body that is JSON `null` throws
  `WebhookSignatureError("stale_timestamp")`. Before, it threw a `TypeError`.

### Security

- Redirects are followed only within the origin of `baseUrl` (or to the same host over HTTPS on the
  default ports), at most five per attempt. Any other redirect is refused with a `NetworkError`
  instead of being followed with the `x-api-key` header. The LexAPI API does not redirect to other
  hosts; this matters with a custom `baseUrl` or a proxy in front of the API. A custom `fetch` must
  honour `redirect: "manual"`; a response it has already redirected is refused.

## [0.4.0] — 2026-11-11

Cross-border citation graph. **Requires LexAPI API 2.13.0.** Additive at runtime: no existing
signature or field changes meaning. Type-level changes to check when upgrading:

- `CitationType` gains `"transposition"` — an exhaustive `switch` over it needs a new case.
- `citationType` params are now `OneOrMany<CitationType>`: code that reads the param back as a
  single value must handle a list.
- `NationalDocumentContent` gains the required `textSource` and `ocr` fields — objects you build
  yourself (test fixtures, mocks) need them (`null` is valid for both).

### Added

- **`getTransposition(celexNumber, params?, options?)`** (`GET /citations/transposition/{celexNumber}`,
  5 credits, every plan): the measures the member states notified to the Commission for an EU act
  (CELEX sector 3), grouped by country, from the Publications Office's Cellar records. Every answer
  carries `note` — a notification is not a finding that the measure transposes the act, or
  transposes it completely. On BUSINESS, SCALE and ENTERPRISE, for live jurisdictions, the measures
  LexAPI holds are filled in (`id`, `resolved`, `resolution`, `resolutionBasis`, `counts.resolved`,
  `source.lanes`) and documents whose national source records the relation are added
  (`provenance: "source"`); otherwise those fields are `null` (`termsRequired: true` while the
  national-source terms are not accepted). Params: `jurisdictions`, `resolvedOnly`, `language`.
  Types: `TranspositionParams`, `TranspositionResponse`, `TranspositionCountry`,
  `TranspositionMeasure`.
- **`getCounterparts(id, params?, options?)`** (`GET /citations/counterparts/{id}`, 20 credits,
  BUSINESS and above): a national document's counterparts in the other live jurisdictions, through
  the EU acts it transposes or implements, ranked 1–3. A lookup past the server's budget throws
  `TimeoutError` (503, `partial`), refunded; the SDK does not retry it — retry yourself, or narrow
  with `jurisdictions`. Other 503s keep the existing retry policy. Types: `CounterpartsParams`, `CounterpartsResponse`,
  `CounterpartVia`, `Counterpart`.
- **Edge filters** on `getCites`, `getCitedBy`, `getCitationNetwork`, `getCitationPath` and
  `getRelatedDocuments` (and the `paginate*` helpers): `citationType` now takes one value or a
  list, plus `provenance`, `jurisdictions` and `resolution` (each one value or a list, sent
  comma-separated). `CitationFilterParams`; `CitationPathParams` and `RelatedDocumentsParams` gain
  `citationType` too.
- **`unresolved: true`** on `getCites` (new `CitesParams`) and `getCitationNetwork` for a national
  document id: `unresolved` (`UnresolvedReference[]`) and `unresolvedTruncated` on the response.
- **Provenance and resolution on every edge**: `CitationEdgeDetail.provenance` /
  `.resolution`, and `CitationNeighbour.edgeDetails` (`CitationEdgeKind[]`). Types
  `CitationProvenance`, `CitationResolution`; runtime lists `CITATION_TYPES`,
  `CITATION_PROVENANCES`, `CITATION_RESOLUTIONS`.
- **Node identity** (`CitationNode`: `id`, `jurisdiction`, `documentKind`) on cites / cited-by
  groups, network neighbours, path nodes and related documents. `celexNumber` is unchanged.
- **`CitationType`** gains `"transposition"`.
- **Totals**: `totalEdges` and `countsSource` (`"stats"` | `"counted"`, API 2.10.0) on
  `getCites` / `getCitedBy`; `paging.citesEdgeTotal`, `paging.citedByEdgeTotal` and
  `paging.countsSource` (`null` when partial) on `getCitationNetwork`.
- **`getCitationStats({ includeNational: true })`**: `stats.byJurisdiction`, `stats.byProvenance`,
  `stats.transposition`.
- **Coverage**: `NationalJurisdictionCoverage.citationGraph` (`NationalCitationGraph`) — extraction
  `methods` (incl. `unmeasured` rate → `not-collected` | `source-empty`), `edges`,
  `decisionResolutionRate`, `actEuRate`, `textPatternRate`, `transposition`, `precision`,
  `measuredAt`, `nimResolvedRate`, `nimMeasuredAt`, `floors`.
- **National content**: `content.textSource` (`html` | `pdf-text` | `ocr` | `null`) and
  `content.ocr` (`NationalOcrInfo` | `null`) — API 2.9.0.
- **`InvalidParamsError.param` / `.value` / `.allowed`**: the refused parameter, the value sent
  (when the server echoes it) and its allowed values, read
  from either error shape. **`TimeoutError.partial` / `.serverTimeoutMs`** for a budget timeout.
- **Incomplete national semantic searches**: `partial` (`true`) and `partialReason`
  (`NationalSearchPartialReason`, `"SEARCH_INCOMPLETE"`) on `NationalSemanticCaseLawResponse` and
  `NationalSemanticLegislationResponse` — the national index could not complete the search and the
  results may be missing better matches; `hint` says whether a retry or a rephrased query / changed
  filters may complete it. With nothing left to return the call fails instead:
  `NationalSemanticUnavailableError` (503) now exposes `.partialReason` (`"SEARCH_INCOMPLETE"`), and
  its `retryAfter` falls back to the body's `retryAfter` when the header is missing.
- **`NationalSemanticFilterUnreachableError`** (extends `InvalidParamsError`, code
  `NATIONAL_SEMANTIC_FILTER_UNREACHABLE`, 422, `.jurisdiction`, `.partialReason`): the national index
  cannot search this slice (jurisdiction, document kind, filters) completely and there is nothing
  left to return. Not retryable as is — rephrase the query or change the filters. Refunded.
- **`/resolve`**: optional `ResolveResponse.verified` and the `ResolvedVia` value `"eli-cellar"`
  (servers that send them; `verified: false` means the CELEX was not confirmed by a lookup).

### Changed

- A `422 NATIONAL_SEMANTIC_FILTER_UNREACHABLE` is now a `NationalSemanticFilterUnreachableError`,
  a subclass of `InvalidParamsError` (previously the base `LexAPIError`): `catch` blocks for
  `InvalidParamsError` now also see it. The request may be valid — it is a coverage limit of the
  national index, not a malformed request, and `.param` is absent.
- An incomplete national semantic search `503` without a retry wait (the same search has
  repeatedly come back incomplete) is not retried automatically, even with `retryReadOnlyPosts`.
  With a wait it keeps the existing 503 policy, but is retried at most once per call. A
  `retry.maxDelayMs` below the server's wait shortens that wait. A `503` is never a `RateLimitedError`, whatever
  `Retry-After` / `retryAfter` it carries — only a `429` is.

## [0.3.0] — 2026-10-28

Adds national (member-state, and non-EU) law support. **Requires LexAPI API 2.8.0.**

### National document shape (API 2.8.0)

The national types follow the normalized cross-jurisdiction contract — a client written for one
country now works for every other:

- `NationalDocumentSummary` (listing rows, documents, and every semantic hit's `document`): every
  field is required and `null` when the source has nothing — `title`, `documentType`, `ecli`,
  `eli`, `dateOfDocument` (`YYYY-MM-DD`), `validTo`, `inForce` — plus the new **`documentKind`**
  (`"act"` | `"decision"`, type `NationalDocumentKind`).
- `NationalDocument` gains **`decision: NationalDecision | null`** (`court`, `chamber`,
  `caseNumbers[]`, `citedNorms[]` of `NationalCitedNorm { text, documentId }`) and `content` is the
  closed `NationalDocumentContent` (`fullText`, `articles: NationalArticle[]`, `textLanguages`,
  `textLanguage`, `embeddedForeignText`, `repeal: NationalRepeal | null`, `source`, `details`) instead
  of the EU `DocumentContent`. Articles are `{ number, title, section, text, inForceFrom, inForceTo,
  details }`. `textAvailability` is required; `textBasis` is `NationalTextBasis | null`. Source-
  specific keys (Austria's `gericht`, Germany's `aktenzeichen`, unit ids, …) live only under
  `content.details` / `articles[].details` — read `decision` instead.
- New helper **`isNationalDecision(document)`** — a type guard narrowing to
  `NationalDecisionDocument` (non-null `decision`).
- `NationalSemanticCaseLawResult` / `NationalSemanticLegislationResult`: required `document`
  (`NationalDocumentSummary`), `documentId`, `jurisdiction`, `attribution`; legislation hits always
  carry `law_title`, `article_ref`, `section`, `language`, `in_force`, `valid_from`, `valid_to`,
  `law_type` (each nullable).

### Added

- **National law**: `getNationalCoverage()` (`GET /national/coverage`, public, free — which
  jurisdictions are live, what each covers, sources and their attribution), `getNationalDocument()`
  (`GET /{jurisdiction}/documents/{id}`, 1 credit), `listNationalDocuments()` /
  `paginateNationalDocuments()` (`GET /{jurisdiction}/documents`, 3 credits flat per call — pagination
  does not multiply the price; cursor paging past the first 1,000 rows, newest-first
  by document date), `nationalSemanticSearch()`
  (`POST /{jurisdiction}/search/semantic`, 5 credits — `hyde` accepted but never rewrites or
  changes price here) and `nationalLegislationSemanticSearch()`
  (`POST /{jurisdiction}/legislation/semantic`, 5 credits; no `hyde`/`asOf` — and never forwards a
  bypassed `hyde` either, now that the server validates it strictly as a boolean on this route
  too). New types:
  `NationalCoverageResponse`, `NationalDocument`, `NationalDocumentSummary`,
  `NationalDocumentResponse`, `NationalDocumentListParams`, `NationalDocumentListResponse`,
  `NationalSemanticCaseLawOptions`/`Result`/`Response`, `NationalSemanticLegislationOptions`/
  `Result`/`Response`, `NationalSource`, `NationalJurisdictionCoverage` and friends. Every
  document/result carries `attribution` — always show it alongside the text.
- **`NationalAllowanceExhaustedError`** (`NATIONAL_ALLOWANCE_EXHAUSTED`, 402): FREE/STARTER/
  PROFESSIONAL get national law within a monthly allowance of calls; BUSINESS and above have no
  separate limit. Typed `jurisdiction`/`limit`/`remaining`/`resetsAt`/`upgradeUrl` getters.
- **`NationalSemanticNotEnabledError`** (409 `NATIONAL_SEMANTIC_NOT_ENABLED` — a jurisdiction has
  no semantic index at all) and **`NationalSemanticUnavailableError`** (503
  `NATIONAL_SEMANTIC_UNAVAILABLE` — temporarily unreachable; extends `ServiceUnavailableError`, so
  `instanceof ServiceUnavailableError` still holds). Both legacy-shape bodies; `.jurisdiction` is
  read off the raw `body`, not `details`.
- **`DocumentWithdrawnError`** (`DOCUMENT_WITHDRAWN`, 410): a national document
  its source withdrew (a takedown, a pseudonymisation fix) is served nowhere — no title, no
  metadata, no text. Thrown by `getNationalDocument` (typed envelope, `details: {id, jurisdiction,
  withdrawnAt}`) and by the citation methods for a withdrawn national id (legacy shape, the same
  three fields as top-level siblings instead). `.id`/`.jurisdiction`/`.withdrawnAt` read whichever
  shape answered. Not retryable; nothing is ever charged for it.
- **`result.headers.nationalAllowance`** (`{ limit, remaining, resetsAt }`), parsed from
  `X-National-Limit`/`X-National-Remaining`/`X-National-Reset` — present only for
  FREE/STARTER/PROFESSIONAL callers on the four national document/semantic endpoints (also on the
  402 error itself, via `err.headers`).
- **`includeNational`** on all six citation-graph methods (`getCites`, `getCitedBy`,
  `getCitationNetwork`, `getCitationPath`, `getRelatedDocuments`, `getCitationStats`): also
  returns/follows national documents of live jurisdictions as neighbours — BUSINESS, SCALE and
  ENTERPRISE only (`403 TierForbiddenError` below that). `celexNumber` and `getCitationPath`'s
  `from`/`to` accept a national document id directly (e.g. `"AT-NOR-10001597"`); an id whose
  jurisdiction is not live is a plain `404 NotFoundError`. `getCitationStats` gained an optional
  `params` argument before `options`.
  Back-compatible with 0.2.0's `getCitationStats(options?)`: a first argument shaped like
  `CallOptions` (`timeoutMs`/`signal`, not `includeNational`) is still honoured as the per-call
  options rather than silently read as `params` — this can't be caught at the type level for a
  non-literal variable or a JS caller, so it's detected at runtime too. Every response type
  carries an optional `includeNational` boolean, present once the flag was honoured.
- The national methods URL-encode the `jurisdiction` path segment (lower-cased, as before), like every other caller-supplied segment — a stray `/` or `?` in that argument can no longer reach a different route.
- `paginateNationalDocuments` strips `page` from its params at runtime (not just via the
  `Omit<…, "page">` type, which only guards TypeScript callers) — passing both `page` and
  `cursor` to the underlying `GET` is a 400 ("Use either cursor or page, not both").

National semantic responses (`nationalSemanticSearch`/`nationalLegislationSemanticSearch`) carry
the `credits` block, like every other credit-metered route.

## [0.2.0] — 2026-10-26

Full re-sync with the LexAPI API (validated against API 2.0.0; later items name their API version).
Every endpoint, parameter, response field and error shape was checked against the API reference.

### Added

- **Point-in-time legislation search** — `semanticLegislationSearch({ query, asOf: "2019-06-01" })`
  returns, per hit, the text in force on that date. New result fields: `asOf`, `asOfResolved`,
  `asOfReason` (typed `AsOfReason`, runtime list `AS_OF_REASONS`), `asOfVersion`
  (`{ celex, date, kind }`), `matchedVersion`; new response fields `asOf` and `asOfSummary`
  (`liveFetches`, `unresolved`). New options type `SemanticLegislationSearchOptions`.
- **Consolidated-text labels** on legislation hits: `consolidated`, `consolidatedAsOf`, `baseCelex`,
  `consolidatedNote`, `baseAct`; plus `id`, `snippet`, `language`, `section`, `chapter`,
  `exact_match_law_id`.
- **Case-law hit fields**: `snippet` (the default payload), `parties`, `summary`, `decision_date`,
  `jurisdiction`, `language`, the structured analytics block (`outcome`, `claimed_amount`, …) and
  `metadata.paragraph_number`; `semanticUsage.unitsCharged`.
- **Text availability**: `document.textAvailability` (`available`, `reason`, `retryable`,
  `availableLanguages`, `externalSource`, `source`, `checkedAt`, `latestConsolidated`,
  `upcomingConsolidated`, `newestConsolidated`); `textUnavailable` on batch responses;
  consolidated-version hints on `/documents/metadata`.
- **Language**: `acceptLanguages` (`["fr", "de"]` or `"any"`) on `getDocument` /
  `getDocumentsBatch`; `titleLanguage` on documents, batch items and metadata.
- **Search**: `fresh` (bypass the 60-minute result cache), response `hint` and `source: "corpus"`.
- **Response headers on every result** — `result.headers` (`ResponseHeaders`): `source`
  (`corpus`/`cellar`/`cellar-oj`/`live` — what a document read settled at), `searchSource`,
  `searchCache`, `language`, `languageFallback`, `textAvailable`, `corpusVersion`, `corpusFetchedAt`,
  `warning`, `ignoredDocumentTypes`, `postFilteredBy`, `documentTypeFanOut`, the batch source split
  (`batch.corpusHits/cellarServed/ojRecovered/liveFetches/textUnavailable`) and `rateLimit`
  (`RateLimit-Limit/Remaining/Reset/Policy`). `parseResponseHeaders()` is exported.
- **Webhooks**: `watchCelex` watch lists (create/update/read), `searchCriteria` now optional and
  nullable on update (`null` removes it), `WebhookCriteria` (the webhook filter vocabulary),
  `criteriaErrors`, `retryPolicy`, `requeuedDeliveries`; `webhooks.paginateDeliveries()`.
- **Webhook receivers** (§1.9): `verifyWebhook()` (signature + 300 s replay window + typed parse into the
  `WebhookPayload` union: `documents.new` / `watchlist.changes` / `webhook.test`), `verifySignature()` (a
  missing, empty, non-ASCII or non-hex header is a plain `false`), `computeSignature()`,
  `WebhookSignatureError`; Web Crypto — still zero dependencies.
- **Citations**: `citationType: "corrigendum"`, `relationSync` on cited-by and network,
  `titleSource` on every neighbour/path node, `language` (title language) on cites / cited-by /
  network / path / related; `paginateCites()` / `paginateCitedBy()` page iterators.
- **Export**: `includeStubs`; array values for `documentType` / `author` / `subdomain`;
  `stream.cancel()`; typed `_meta` / `_done` contents (`totalMatching`, `written`, `skippedStubs`, …).
- **Errors**: `ServiceUnavailableError` (503); every `LexAPIError` now carries `body` (the raw JSON
  error body — e.g. `upgradeUrl`, `current`/`limit`) and `headers`; legacy-shape `details` lists
  (search / webhook validation) are kept; `CreditsExhaustedError` exposes `operation`, `weight`,
  `available` and typed `details`; `RateLimitedError.rateLimit`.
- `SubscriptionTier` includes `SCALE`; `SubscriptionInfo.maxResults`; `ResolvedVia` includes
  `ecli-corpus` / `eli-corpus`; `DocumentUrls.pdf/xml`; `Document.fetchedAt`.
- `ResponseHeaders.retryAfter`; `RateLimitedError.quotaExhausted` / `resetsAt`.
- **Cancellation:** `{ signal }` on every method (`CallOptions.signal`) — aborts the request, any retry
  wait and an export stream; rejects with `RequestAbortedError` (`ABORTED`), never retried.
- **Cross-build `instanceof`:** error classes carry a shared `Symbol.for` brand, so errors from the CommonJS
  build (or a second installed copy) satisfy the ESM build's `instanceof`; `isLexAPIError(err, Class?)`.
- New errors: `RequestAbortedError`, `InvalidResponseError` (a 2xx with a non-JSON body),
  `IncompleteExportError` (export ended without `_done`, `rowsRead`).
- `ResponseHeaders.apiVersion` / `release` (`X-LexAPI-Version` / `X-LexAPI-Release`), `languagePartialKept`,
  `cacheAge`. Types: `Document.version`, `SearchResult.dateType/ecli/internalNumber`,
  `CitationEdgeSummary.sourceCelex/direction`, `CitingDocumentGroup.hasResume/hasSummary`,
  `CitationStatsResponse.cachedAt/cacheTtlSeconds`, `UsageInfo.unitsCharged`.
- `LICENSE` file, `CHANGELOG.md`, `prepublishOnly` guard, and a framework-free dist smoke test
  (`npm run smoke:dist`, incl. a CJS↔ESM `instanceof` check) that CI runs on Node 18–24, Bun and Deno.

### Fixed

- **Export trailer/meta were never readable**: the server nests them (`{"_done": {written, truncated,
  skippedStubs}}`), so `stream.done?.truncated` was always `undefined`. The fields are now lifted to
  the top level (`stream.done.truncated`, `stream.meta.totalMatching`); the raw `_done` / `_meta`
  stay available.
- Breaking out of `for await` over an export now cancels the response body instead of leaving the
  connection streaming; `stream.cancel()` takes effect immediately, even during a pending read.
- **An export that ended without its `_done` trailer looked complete** (iteration finished, `done` was
  `undefined`, so `done?.truncated` was falsy). It now throws `IncompleteExportError` after yielding the rows
  that arrived; `stream.complete`, `stream.rowsRead`, `stream.invalidLines` (lines that are not JSON objects
  are counted, not yielded) and `stream.truncated` (header → `_meta` → `_done` discounted by `skippedStubs`)
  follow §1.8. A stream is read once: re-iterating one read to its `_done` yields nothing; iterating one that
  was ended early (`cancel()`, `break`, an error) raises `IncompleteExportError`.
- **A dropped export connection threw a raw `TypeError: terminated`**; it is now a `NetworkError`
  ("Export stream interrupted after N rows").
- **`timeoutMs` stopped at the response headers** — a server that sent headers then stalled hung the call
  (and an export) forever. It is now an inactivity limit that restarts on every body chunk (§1.6).
- **The API key was visible** in `console.log(client)`, `util.inspect` and `JSON.stringify(client)`. It now
  lives in a private field; the client redacts itself in all three.
- `paginateCites` / `paginateCitedBy` could stop early: they compared the edge offset with
  `totalCitations`, which counts distinct pairs (raw rows can outnumber it). They now stop on a short page.
- `BatchDocumentError` used field names the server never sends: it is `{ celex, error }` (the README example
  printed `undefined`).
- `getRecentDocuments({ documentType: [...] })` / `({ subdomain: [...] })` silently used only the first value
  (the endpoint has no fan-out and EUR-Lex reads the first `DTS_SUBDOM` only); both now take one value.
  `search()` keeps multi-value `subdomain` (the web service ORs them) with a documented caveat for the
  result-page fallback. `author` arrays work on both (every `AU_CODED` is sent and ORed).
- Aborting an export now releases the connection immediately, even while nobody is iterating.
- A 200 with a non-JSON body threw a raw `SyntaxError` (now `InvalidResponseError`); an empty `Retry-After`
  meant a 0 ms retry (now ignored); unmapped 4xx were `InternalServerError` (now a base `LexAPIError`, code
  `INTERNAL` per §1.3); an empty webhook secret threw a raw Web Crypto `DataError` (now
  `WebhookSignatureError("missing_secret")`); NDJSON lines were rescanned per chunk (quadratic on
  multi-MB `includeHtml` rows; now linear).
- Copy: export pricing is no longer stated as "1 credit per row" (see the pricing page); `extractCitations`
  never settles at 4; batch source headers overlap rather than partition; the 95 s timeout covers a single
  live fetch, not every request; the "edge runtimes" claim was removed (Bun and Deno are now tested).
- `resolvedVia` was typed as `IdentifierType`; the server returns `ecli-corpus` / `eli-corpus`.
- CommonJS consumers got ESM type declarations ("masquerading as ESM", per arethetypeswrong):
  the `exports` map now points `require` at `index.d.cts`.
- Legacy error bodies dropped their `details` (e.g. which `/search` parameter failed validation).
- Docs/README: the export tier gate is a `403` (not `402`) and covers BUSINESS, SCALE and
  ENTERPRISE; tier limits include SCALE; outdated notes removed; webhook ceilings updated.
- Export streams never report a failed export as complete. A `_done` trailer with
  `complete: false`, or any line whose only key is `_error`, now throws `IncompleteExportError`
  (after the rows that did arrive) and leaves `stream.complete` false; before, any `_done` line
  counted as complete and an `_error` line was yielded as an `ExportRow`. The error line's body is
  on the exception's `details` and on the new `stream.error`. Unknown `_done` fields
  (`truncatedBy`, `credits`) are kept on `stream.done`. (SDK contract §1.8.)
- A top-level string `code` on a legacy-shape error body (API 2.4.0 adds it next to the text
  `error`) is now the error's `code`, ahead of the status-derived one. A 429 with
  `code: "QUOTA_EXHAUSTED"` (a legacy plan's used-up daily or monthly-semantic quota) is a
  `RateLimitedError` with `code === "QUOTA_EXHAUSTED"`, `quotaExhausted` true, `retryAfter`
  `undefined` and `resetsAt` from the body's `resetsAt`; it is never retried. `QUOTA_EXHAUSTED`
  joins `ErrorCode`. Servers without the `code` are still recognised by the old shape check.
  (SDK contract §1.2/§1.3.)
- Export parameters for API 2.3.0: `documentTypeCode` (a type family) and
  `changedSince` (rows whose text changed); `fetchedSince` / `changedSince` also take a `Date`
  (sent as UTC). A `limit` that is not a positive integer throws `RangeError` before the request
  (the API answers 400). `ExportDoneInfo` types `truncatedBy` and `credits`. Docs describe the
  per-row billing and the filter semantics of API 2.3.0.
- `stream.truncated` reads `_done.truncated` first once the trailer has been read. From API
  2.3.0 that flag is authoritative: set when matching rows remain unreached (`truncatedBy`:
  `limit`, `max_rows`, `credits` or `recovered` — both join the type) and never derived from the row
  count. The `X-Export-Truncated` header and `_meta.truncated` come from an up-front count that
  may be a minute old and never caps the stream, so they are now only the fallback before the
  trailer arrives. (SDK contract §1.8.)

### Changed

Retries, timeouts and error codes now follow the shared SDK contract (docs/sdk-contract.md §1, identical in
`lexapi-python`) — **an SDK retries only when the retry cannot charge the caller twice**:

- **Retry decision table (§1.2).** 429 that is not a quota: every call. Never reached the server (DNS failure,
  connection refused/unreachable, connect timeout incl. `ETIMEDOUT` with `syscall: "connect"`, TLS
  certificate-verification and handshake-alert failures; Cloudflare 521/522/523): every call. App-origin
  502/503/504: GETs, and read-only POSTs only with the opt-in. Proxy-origin 502/503/504, 520, 524 and any other
  transport error (reset, closed connection — `fetch` cannot tell before-response from mid-response — read
  timeout): **free calls only** (`getInfo`, webhook reads). Never: quota 429, 4xx, 500.
  0.1 retried every 502/503/504 and every network error on a GET, including when a proxy answered after the API
  had charged the call (no refund), and never retried a POST that provably never left the machine.
- **App-origin** = a non-empty `X-LexAPI-Version` header (API 2.1.0 on) or a `RateLimit-Limit` header (the
  app's rate limiter sets `RateLimit-*` on every billable app response; proxies never do). A JSON error body alone
  is not enough.
- **New opt-in `retry.retryReadOnlyPosts`** (default off): the eight read-only POSTs (`search`, `getDocument`,
  `getDocumentsBatch`, `getDocumentByUrl`, `getDocumentMetadata`, `resolve`, `semanticSearch`,
  `semanticLegislationSearch`) also retry an app-origin 502/503/504 — refunded in full, so billing-safe.
  `extractCitations` is a mutating call (it persists edges) and is never retried on 5xx.
- **Timeout model (§1.6): `timeoutMs` is a per-attempt inactivity limit**, default **95 s** (was 60 s): it runs
  until the response head and then restarts on every body chunk, for JSON bodies and export streams alike. 0.1's
  timer stopped at the headers, so a stalled body hung forever. 95 s lets the API's 90 s limit on one live
  EUR-Lex fetch reach the caller as a typed, refunded 504; `timeoutMs: 60_000` restores the old value.
- **Retry waits (§1.2):** `Retry-After` on any status (empty or unparseable = absent); on a 429 only, then
  `RateLimit-Reset` and the JSON `retryAfter` field. `X-RateLimit-*` is not read. Hints are clamped to the 30 s
  cap; numbers above 1e12 / 1e9 are epoch ms / s. 0.1 used `RateLimit-Reset` on every retryable status — the API
  sends it on every response, so a retried 5xx slept for the rate window.
- **Quota 429s are not retried** (legacy daily quota, monthly semantic quota: `usage.resetsAt`, no `Retry-After`,
  no `retryAfter`) and expose `retryAfter: undefined`; `RateLimitedError.quotaExhausted` / `.resetsAt`.
- **Error codes (§1.3):** `NetworkError.code` is `CONNECTION_ERROR` (was `NETWORK_ERROR`); the SDK's own timeout
  is `TimeoutError` with `code: "REQUEST_TIMEOUT"`, status 0 (was `TIMEOUT`); 503 → `SERVICE_UNAVAILABLE`
  (`ServiceUnavailableError`); 520–523 → `UPSTREAM_ERROR`, 524 → `TIMEOUT`; any other status → `INTERNAL`
  (unmapped 4xx such as 409/413 are a base `LexAPIError`, not an `InternalServerError`); a legacy string `error`
  is human text, never a code; top-level `details` is kept even on bodies without an `error` member; a 204 or
  empty 2xx body is `{}` (was `undefined`); a non-empty non-JSON 2xx is `InvalidResponseError`.
- **Pagination (§1.4):** cites / cited-by advance by the sum of the page's `citationCount`s and stop on a short
  page; deliveries are deduplicated on `id`.
- **Credit helper (§1.5):** `getCreditUsage().unitsCharged` is `0` (was `undefined`) on legacy accounts.
- Dev toolchain: vitest 2 → 4, tsup/TypeScript/@types/node patch updates (clears all `npm audit` advisories,
  which were dev-only — the package has no runtime dependencies). CI uses `npm ci` and runs the unit suite on
  Node 20/22/24 plus the dist smoke test on Node 18, Bun and Deno.

### Breaking changes (type-level) and migration

Runtime behaviour changes are listed under *Changed* and *Fixed*; the ones that can change what your code
sees are also in this table. TypeScript users may see new compile errors where the old types were wrong:

| Change | Why | Migrate |
| --- | --- | --- |
| `Document.content` is `DocumentContent \| null` | The API returns `content: null` for documents whose text EUR-Lex does not publish (since 2026-08). | Check `document.textAvailability?.available` (or `document.content`) before reading `content.*`. |
| `WebhookCreateRequest.searchCriteria` / `WebhookUpdateRequest.searchCriteria` are `WebhookCriteria` (not `SearchRequest`) | Webhooks accept a narrower vocabulary; `procedure`, `month`, `maxPages`, `textScope: "text"`, `domain: "NATIONAL_LAW"` are refused with 400. | Pass a `WebhookCriteria` object; drop unsupported filters. |
| `webhooks.delete()` resolves `WebhookDeleteResponse` (was `void`); any 204/empty 2xx body resolves `{}` (was `undefined`) | The server answers `200 { success, message }`; §1.3 empty-body rule. | No change needed unless you checked for `undefined`. |
| `ResolveResponse.resolvedVia` is `ResolvedVia` | Real values include `ecli-corpus` / `eli-corpus`. | Update exhaustive `switch`es. |
| `ExportDone` / `ExportMeta` field types | Matched to the real server shape. | Read `done.truncated` / `done.written` directly. |
| `DocumentMetadata.author` and `Document.author` are `string \| null` | Placeholder authors are now `null`. | Handle `null`. |
| `SearchResponse.searchParameters` is `Omit<SearchRequest, "fresh" \| "maxPages">` | The server's echo never contains them. | Read `maxPages` from your own request. |
| `SubscriptionTier` gains `SCALE` and an open `(string & {})`; `CitationType` gains `corrigendum`; `DocumentTypeCode` gains `consolidated_text` | New API values. | Add the cases; a `Record<SubscriptionTier, …>` needs a fallback. |
| `RecentDocumentsResponse.parameters.documentType/author/subdomain` are `string \| string[] \| null` | Echo of repeated query params. | Handle arrays. |
| `RecentDocumentsParams.documentType` is a single `DocumentType` | The endpoint uses only the first type. | Pass one type, or use `search()` for several. |
| `RecentDocumentsParams.subdomain` is a single `Subdomain` | A subdomain filter sends the request to EUR-Lex result pages, where EUR-Lex reads only the first `DTS_SUBDOM`. | Pass one subdomain, or use `search()` (the web service ORs several). |
| `BatchDocumentError` is `{ celex, error }` (`celexNumber` / `message` deprecated, never sent) | Matches the server. | Read `e.celex` and `e.error`. |
| `Section.number` / `Section.title` and `Recital.number` may be `null`; `SearchResult.celex` may be `null` | The parser emits `null` when the markup has no value. | Handle `null`. |
| `stream.done` is the lifted trailer (`done.truncated`, `done.written`) — 0.1 exposed the raw `{_done: {…}}` | Raw key kept as `done._done`. | Read the top-level fields. |
| An export without its `_done` trailer throws `IncompleteExportError`; a dropped connection throws `NetworkError` | It used to finish quietly / throw a raw `TypeError`. | Catch them; treat as an incomplete export. |
| Unmapped 4xx (409, 413, …) are a base `LexAPIError` (code `INTERNAL`, `status` kept) instead of an `InternalServerError` | They are client errors; §1.3 keeps the code. | Branch on `status`. |
| A 2xx with a non-JSON body throws `InvalidResponseError` (was a `SyntaxError`) | Typed. | Catch `LexAPIError`. |
| `timeoutMs` covers the response body (and is an idle timeout for exports) | A stalled body used to hang. | Raise `timeoutMs` if you read very large bodies on slow links. |
| Retry decisions follow §1.2 (see *Changed*): billed GETs no longer retry proxy 5xx/520/524 or post-send network errors; never-reached failures retry for every method | Billing safety. | `retry: { maxRetries: 0 }` disables retries. |
| `timeoutMs` default 95 s and now an inactivity limit (restarts per body chunk) | §1.6. | Pass `timeoutMs` to change it. |
| `IncompleteExportError` / `InvalidResponseError` / `RequestAbortedError` are new error types | §1.3 / §1.8. | Catch them or the base `LexAPIError`. |
| `UsageInfo.resetsAt` is `string \| null` | The credit-pool mirror can carry `null` until the first reset is set. | Handle `null`. |
| 503 throws `ServiceUnavailableError` (was `InternalServerError`); 520–523 throw `UpstreamError`, 524 `TimeoutError` (were `InternalServerError`) | §1.3 status table. | Catch the new classes or the base `LexAPIError`. |
| `NetworkError.code` is `CONNECTION_ERROR` (was `NETWORK_ERROR`); a client-side timeout is `TimeoutError` with `code: "REQUEST_TIMEOUT"` (was `TIMEOUT`) | §1.3 SDK-side codes; tells the SDK's timeout apart from the server's 504. | Branch on the new codes, or on `status === 0`. |
| `getCreditUsage().unitsCharged` is `number` (`0` on legacy accounts, was `undefined`) | §1.5. | Drop `undefined` checks. |
| `DEFAULT_TIMEOUT_MS` is `95_000` | See *Changed*. | Pass `timeoutMs` explicitly to keep 60 s. |

## [0.1.0] — 2026-07-02

Initial release: request core (auth, retries with `Retry-After`, typed errors, credit visibility),
search and document endpoints, citations, semantic search (incl. HyDE), webhooks, NDJSON export,
point-in-time versions.

[0.2.0]: https://github.com/Lex-API/lexapi-typescript/compare/583b501...v0.2.0
[0.1.0]: https://www.npmjs.com/package/@lexapi/client/v/0.1.0
