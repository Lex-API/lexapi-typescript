# Changelog

All notable changes to `@lexapi/client`. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: [SemVer](https://semver.org/) — while the package is `0.x`, a **minor** bump may contain
breaking changes (documented below with a migration note); `npm install @lexapi/client@^0.1.0` never
picks up `0.2.0` on its own.

## [0.3.0] — 2026-10-28

Adds national (member-state, and non-EU) law support ahead of the LexAPI national-law launch
(2026-11-03). **Requires LexAPI API 2.8.0** (lex-api PRs #306, #314, #320 — the allowance, the
documented contract and the pre-launch hardening pass — plus #335, the one national document shape
for every jurisdiction). Re-verify once all of them are deployed.

### National document shape (lex-api PR #335, API 2.8.0)

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
- **`DocumentWithdrawnError`** (`DOCUMENT_WITHDRAWN`, 410 — lex-api PR #320): a national document
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
  ENTERPRISE only (`403 TierForbiddenError` below that; no account/code change needed, it already
  throws the existing error). `celexNumber` and `getCitationPath`'s `from`/`to` accept a national
  document id directly (e.g. `"AT-NOR-10001597"`); an id whose jurisdiction is not live is a plain
  `404 NotFoundError`. `getCitationStats` gained an optional `params` argument before `options`.
  Back-compatible with 0.2.0's `getCitationStats(options?)`: a first argument shaped like
  `CallOptions` (`timeoutMs`/`signal`, not `includeNational`) is still honoured as the per-call
  options rather than silently read as `params` — this can't be caught at the type level for a
  non-literal variable or a JS caller, so it's detected at runtime too. Every response type
  carries an optional `includeNational` boolean, present once the flag was honoured.
- The national methods URL-encode the `jurisdiction` path segment (lower-cased, as before), like every other caller-supplied segment — a stray `/` or `?` in that argument can no longer reach a different route.
- `paginateNationalDocuments` strips `page` from its params at runtime (not just via the
  `Omit<…, "page">` type, which only guards TypeScript callers) — passing both `page` and
  `cursor` to the underlying `GET` is a 400 ("Use either cursor or page, not both").

Validated against lex-api **PR #320** (`fix/national-api-hardening` @ `e49881b`: `openapi.yaml`
2.5.0, `docs.md`, the national controllers, `nationalWithdrawn.js`, `jurisdiction.js`,
`utils/errors.js`, `operationWeights.js`), stacked on PR #314 (the documented contract) and PR
#306 (the allowance), plus the real `nationalCoverageController.js` on `feat/national-launch-switch`.
National semantic responses (`nationalSemanticSearch`/`nationalLegislationSemanticSearch`) DO
carry the `credits` block — PR #314 round 2 restored the envelope on the semantic routes
generally; an earlier note here said otherwise and was wrong.

## [0.2.0] — 2026-10-26

Full re-sync with the LexAPI API (validated against lex-api `main` @ `633eb67`, PR #298, and
`openapi.yaml` / `docs.md` at that commit). Every endpoint, parameter, response field and error shape
was audited against the spec **and** the server controllers.

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
  ENTERPRISE; tier limits include SCALE; "not yet published" and "requires lex-api PR #72" notes
  removed; webhook ceilings updated.
- Export streams never report a failed export as complete. A `_done` trailer with
  `complete: false`, or any line whose only key is `_error`, now throws `IncompleteExportError`
  (after the rows that did arrive) and leaves `stream.complete` false; before, any `_done` line
  counted as complete and an `_error` line was yielded as an `ExportRow`. The error line's body is
  on the exception's `details` and on the new `stream.error`. Unknown `_done` fields
  (`truncatedBy`, `credits`) are kept on `stream.done`. (PLAN.md §1.8; lex-api #303.)
- A top-level string `code` on a legacy-shape error body (lex-api #304 adds it next to the text
  `error`) is now the error's `code`, ahead of the status-derived one. A 429 with
  `code: "QUOTA_EXHAUSTED"` (a legacy plan's used-up daily or monthly-semantic quota) is a
  `RateLimitedError` with `code === "QUOTA_EXHAUSTED"`, `quotaExhausted` true, `retryAfter`
  `undefined` and `resetsAt` from the body's `resetsAt`; it is never retried. `QUOTA_EXHAUSTED`
  joins `ErrorCode`. Servers without the `code` are still recognised by the old shape check.
  (PLAN.md §1.2/§1.3.)
- Export parameters for API 2.3.0 (lex-api #303): `documentTypeCode` (a type family) and
  `changedSince` (rows whose text changed); `fetchedSince` / `changedSince` also take a `Date`
  (sent as UTC). A `limit` that is not a positive integer throws `RangeError` before the request
  (the API answers 400). `ExportDoneInfo` types `truncatedBy` and `credits`. Docs describe the
  per-row billing and the filter semantics of API 2.3.0. **Publish only after lex-api #303 is
  deployed.**
- `stream.truncated` reads `_done.truncated` first once the trailer has been read. From API
  2.3.0 that flag is authoritative: set when matching rows remain unreached (`truncatedBy`:
  `limit`, `max_rows`, `credits` or `recovered` — both join the type) and never derived from the row
  count. The `X-Export-Truncated` header and `_meta.truncated` come from an up-front count that
  may be a minute old and never caps the stream, so they are now only the fallback before the
  trailer arrives. (PLAN.md §1.8; lex-api #303.)

### Changed

Retries, timeouts and error codes now follow the shared SDK contract (PLAN.md §1, identical in
`lexapi-python`) — **an SDK retries only when the retry cannot charge the caller twice**:

- **Retry decision table (§1.2).** 429 that is not a quota: every call. Never reached the server (DNS failure,
  connection refused/unreachable, connect timeout incl. `ETIMEDOUT` with `syscall: "connect"`, TLS
  certificate-verification and handshake-alert failures; Cloudflare 521/522/523): every call. App-origin
  502/503/504: GETs, and read-only POSTs only with the opt-in. Proxy-origin 502/503/504, 520, 524 and any other
  transport error (reset, closed connection — `fetch` cannot tell before-response from mid-response — read
  timeout): **free calls only** (`getInfo`, webhook reads). Never: quota 429, 4xx, 500.
  0.1 retried every 502/503/504 and every network error on a GET, including when a proxy answered after the API
  had charged the call (no refund), and never retried a POST that provably never left the machine.
- **App-origin** = a non-empty `X-LexAPI-Version` header (lex-api #299 on) or a `RateLimit-Limit` header (the
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
