# Changelog

All notable changes to `@lexapi/client`. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: [SemVer](https://semver.org/) — while the package is `0.x`, a **minor** bump may contain
breaking changes (documented below with a migration note); `npm install @lexapi/client@^0.1.0` never
picks up `0.2.0` on its own.

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
- **Webhook receivers**: `verifyWebhookSignature()`, `computeWebhookSignature()` and
  `constructWebhookEvent()` (signature + replay window + typed parse into the `WebhookPayload` union:
  `documents.new` / `watchlist.changes` / `webhook.test`), via Web Crypto — still zero dependencies.
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
- `LICENSE` file, `CHANGELOG.md`, `prepublishOnly` guard, and a framework-free dist smoke test
  (`npm run smoke:dist`) that CI runs on Node 18–24.

### Fixed

- **Export trailer/meta were never readable**: the server nests them (`{"_done": {written, truncated,
  skippedStubs}}`), so `stream.done?.truncated` was always `undefined`. The fields are now lifted to
  the top level (`stream.done.truncated`, `stream.meta.totalMatching`); the raw `_done` / `_meta`
  stay available.
- Breaking out of `for await` over an export now cancels the response body instead of leaving the
  connection streaming.
- `resolvedVia` was typed as `IdentifierType`; the server returns `ecli-corpus` / `eli-corpus`.
- CommonJS consumers got ESM type declarations ("masquerading as ESM", per arethetypeswrong):
  the `exports` map now points `require` at `index.d.cts`.
- Legacy error bodies dropped their `details` (e.g. which `/search` parameter failed validation).
- Docs/README: the export tier gate is a `403` (not `402`) and covers BUSINESS, SCALE and
  ENTERPRISE; tier limits include SCALE; "not yet published" and "requires lex-api PR #72" notes
  removed; webhook ceilings updated.

### Changed

- **Default timeout 60 s → 95 s** (per attempt). The API's upstream hard timeout is 90 s, so 60 s cut slow live
  fetches client-side — the call could still be billed — instead of receiving the server's typed, refunded 504.
  95 s stays under Cloudflare's 100 s proxy timeout. `timeoutMs: 60_000` restores the old value.
- **Retry waits:** `RateLimit-Reset` and the JSON `retryAfter` body field now drive the wait on a **429 only**.
  The API sends `RateLimit-*` on every response, so a retried 502/503/504 GET used to sleep for the rate window
  (up to the 30 s cap) instead of ~0.5–4 s of backoff, and 5xx errors reported that value as `retryAfter`.
- **Legacy quota 429s are not retried** (daily call quota, monthly semantic quota — body `usage.resetsAt`, no
  `Retry-After`): they cannot succeed before the reset. `RateLimitedError.quotaExhausted` / `.resetsAt`.
- **Cloudflare 520–524** are typed (`UpstreamError`; 524 → `TimeoutError`) and retried for GETs (never for POSTs).
- New opt-in `retry.retryReadOnlyPosts` retries read-only POSTs (search, document reads, batch, by-URL, metadata,
  resolve, citation extraction, semantic search) on 502/503/504 — the API refunds every 5xx in full. Default
  off (shared SDK contract §1.2); POST network errors, 520–524 on POST and webhook writes are never retried.
- Dev toolchain: vitest 2 → 4, tsup/TypeScript/@types/node patch updates (clears all `npm audit` advisories,
  which were dev-only — the package has no runtime dependencies). CI uses `npm ci` and runs the unit suite on
  Node 20/22/24 plus the dist smoke test on Node 18.
- PLAN.md §1.2 / §1.6 (shared SDK contract) aligned with `lexapi-python` 0.2.0.

### Breaking changes (type-level) and migration

Runtime behaviour changes are the timeout / retry items under *Changed* (each restorable via options).
TypeScript users may see new compile errors where the old types were wrong:

| Change | Why | Migrate |
| --- | --- | --- |
| `Document.content` is `DocumentContent \| null` | The API returns `content: null` for documents whose text EUR-Lex does not publish (since 2026-08). | Check `document.textAvailability?.available` (or `document.content`) before reading `content.*`. |
| `WebhookCreateRequest.searchCriteria` / `WebhookUpdateRequest.searchCriteria` are `WebhookCriteria` (not `SearchRequest`) | Webhooks accept a narrower vocabulary; `procedure`, `month`, `maxPages`, `textScope: "text"`, `domain: "NATIONAL_LAW"` are refused with 400. | Pass a `WebhookCriteria` object; drop unsupported filters. |
| `webhooks.delete()` resolves `WebhookDeleteResponse \| undefined` (was `void`) | The server answers `200 { success, message }`, not 204. | No change needed unless you typed the result as `void`. |
| `ResolveResponse.resolvedVia` is `ResolvedVia` | Real values include `ecli-corpus` / `eli-corpus`. | Update exhaustive `switch`es. |
| `ExportDone` / `ExportMeta` field types | Matched to the real server shape. | Read `done.truncated` / `done.written` directly. |
| `DocumentMetadata.author` is `string \| null` | Placeholder authors are now `null`. | Handle `null`. |
| `UsageInfo.resetsAt` is `string \| null` | The credit-pool mirror can carry `null` until the first reset is set. | Handle `null`. |
| 503 throws `ServiceUnavailableError` (was `InternalServerError`); 520–523 throw `UpstreamError`, 524 `TimeoutError` (were `InternalServerError`) | Distinct, retryable conditions. | Catch the new classes or the base `LexAPIError`. |
| `DEFAULT_TIMEOUT_MS` is `95_000` | See *Changed*. | Pass `timeoutMs` explicitly to keep 60 s. |

## [0.1.0] — 2026-07-02

Initial release: request core (auth, retries with `Retry-After`, typed errors, credit visibility),
search and document endpoints, citations, semantic search (incl. HyDE), webhooks, NDJSON export,
point-in-time versions.

[0.2.0]: https://github.com/Lex-API/lexapi-typescript/compare/583b501...v0.2.0
[0.1.0]: https://www.npmjs.com/package/@lexapi/client/v/0.1.0
