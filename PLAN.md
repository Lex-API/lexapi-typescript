# lexapi-typescript — Implementation Plan

Official TypeScript/JavaScript SDK for [LexAPI](https://lex-api.com) (`https://lex-api.com/api/v1`, docs at <https://lex-api.com/docs>). Package name: **`@lexapi/client`** (npm). Source of truth: `openapi.yaml` in the LexAPI server repo.

## 1. SDK Contract (shared across all LexAPI SDKs)

This section is identical in `lexapi-python`, `lexapi-typescript`, `lexapi-kotlin`, and `lexapi-swift`. Any change here must be propagated to all four repos in the same release cycle.

Source of truth: `openapi.yaml` (LexAPI 2.0.0, OpenAPI 3.1.0). Production base URL: `https://lex-api.com/api/v1`. Docs: <https://lex-api.com/docs>.

### 1.1 Authentication

- Per the OpenAPI `securitySchemes.ApiKeyAuth`: `type: apiKey`, `in: header`, `name: x-api-key`.
- The SDK sends the key on **every** request as the `x-api-key` header. Keys are prefixed `lex_`.
- Keys are server-side secrets: SDKs must never log the key, never embed it in URLs, and README/quickstart must warn against shipping keys in client-side code (the API explicitly does not support public keys).
- Key is provided at client construction time (constructor arg) with an environment-variable fallback (`LEXAPI_API_KEY`).

### 1.2 Retries and rate limiting

- Default retry policy: up to 3 retries with exponential backoff + full jitter (base 500 ms, cap 30 s).
- Retryable: HTTP 429 (`RATE_LIMITED`), 502 (`UPSTREAM_ERROR`), 504 (`TIMEOUT` — spec marks this retry-safe), and transport-level network errors. Non-retryable: all other 4xx (including 402 `CREDITS_EXHAUSTED` — retrying cannot help until top-up/reset) and 500 `INTERNAL` by default.
- Server-directed wait wins over computed backoff. Resolution order for the wait duration on 429:
  1. `Retry-After` response header (seconds; documented in the spec's `RateLimited` response),
  2. `RateLimit-*` headers (`RateLimit-Remaining`, `RateLimit-Reset` / draft IETF forms) when present,
  3. the JSON `retryAfter` field on the 429 error body, when present,
  4. computed exponential backoff as fallback.
- Retry behaviour is configurable (max attempts, disable entirely). Idempotent GETs retry by default; non-GET calls retry only on 429/network-error-before-send unless the caller opts in.

### 1.3 Typed errors

- All non-2xx responses map to a typed exception/error hierarchy mirroring the API error envelope:

  ```json
  { "success": false, "error": { "code": "NOT_FOUND", "message": "...", "details": { } } }
  ```

- `error.code` is a stable slug enum (from the spec): `NOT_FOUND`, `INVALID_CELEX`, `INVALID_URL`, `INVALID_PARAMS`, `RATE_LIMITED`, `TIER_FORBIDDEN`, `CREDITS_EXHAUSTED`, `UPSTREAM_ERROR`, `TIMEOUT`, `INTERNAL`. SDK error types carry `code`, `message`, optional `details`, and the HTTP status. Unknown codes must not crash the parser (forward compatibility: keep raw code string).
- **Legacy tolerance:** some legacy endpoints return a bare `{ "error": "..." }` body without the `success`/typed envelope. The error parser must accept both shapes: if `error` is an object, read `code`/`message`/`details`; if `error` is a string, use it as `message` and derive `code` from the HTTP status (404→`NOT_FOUND`, 429→`RATE_LIMITED`, 401→unauthorized, etc.).
- 401 (missing/invalid/revoked key) surfaces as a distinct authentication error type.

### 1.4 Pagination helpers

- Search endpoints are page-based (`page`/`maxPages`, tier-bounded per the `subscription` block). SDKs provide an iterator/stream helper that walks pages transparently and stops at the tier cap, surfacing `truncated`/`truncatedAt`/`truncatedReason` and `partial`/`partialReason` flags rather than hiding them.
- `/webhooks/{id}/deliveries` and other list endpoints get the same helper where applicable.

### 1.5 Credit visibility

- Every successful response can include a `usage` block (`current`/`limit`/`remaining`/`unit`/`resetsAt`; dual-mode credits-vs-daily-calls) and, on credit-pool (v2) accounts, a `credits` block (`operation_weight`, `current`, `limit`, `remaining`, `included`, `topup`, `resetsAt`).
- SDKs expose a credit-visibility helper on every response wrapper: `unitsCharged` (mapped from `credits.operation_weight`; 0 for free ops like `/info`), `creditsRemaining` (from `credits.remaining`, falling back to `usage.remaining`), and `resetsAt`. The raw `usage`/`credits` blocks stay accessible untyped-loss-free.
- Helpers must tolerate the blocks being absent (legacy daily-call accounts omit `credits`).

### 1.6 Timeouts

- Defaults: 10 s connect, 60 s read/overall (the API's upstream hard timeout is 90 s; staying under it means the SDK sees the typed 504 rather than cutting the connection). Both configurable per-client and per-call.

### 1.7 User agent

- Every request sends `User-Agent: lexapi-<lang>/<version>` (e.g. `lexapi-python/0.1.0`, `lexapi-typescript/0.1.0`, `lexapi-kotlin/0.1.0`, `lexapi-swift/0.1.0`), with an optional caller-supplied suffix.

## 2. Endpoint coverage matrix

Priority order: **P0** first (`info` + `search` + `documentContent`), then P1 → P3. One group per release increment where practical.

| Group | Operation | Method + Path | Priority | SDK status |
| --- | --- | --- | --- | --- |
| user/info | `getInfo` | `GET /info` | **P0** (scaffolded) | ✅ shipped |
| search | `search` | `POST /search` | **P0** | ✅ shipped (`search`) |
| documents/content | `getDocumentContent` | `POST /documentContent` | **P0** | ✅ shipped (`getDocument`) |
| documents/content | `getDocumentContentBatch` | `POST /documentContent/batch` | P1 | ✅ shipped (`getDocumentsBatch`) |
| documents/content | `getRecentDocuments` | `GET /documents/recent` | P1 | ✅ shipped (`getRecentDocuments`) |
| documents/content | `getDocumentByUrl` | `POST /documents/url` | P1 | ✅ shipped (`getDocumentByUrl`) |
| documents/content | `getDocumentMetadata` | `POST /documents/metadata` | P1 | ✅ shipped (`getDocumentMetadata`) |
| resolve | `resolveIdentifier` | `POST /resolve` | P1 | ✅ shipped (`resolve`) |
| citations | `extractCitations` | `POST /citations/extract` | P2 | ✅ shipped (`extractCitations`) |
| citations | `getCitedBy` | `GET /citations/cited-by/{celexNumber}` | P2 | ✅ shipped (`getCitedBy`) |
| citations | `getCites` | `GET /citations/cites/{celexNumber}` | P2 | ✅ shipped (`getCites`) |
| citations | `getCitationNetwork` | `GET /citations/network/{celexNumber}` | P2 | ✅ shipped (`getCitationNetwork`) |
| citations | `getCitationStats` | `GET /citations/stats` | P2 | ✅ shipped (`getCitationStats`) |
| citations | `getCitationPath` | `GET /citations/path/{from}/{to}` | P2 | ✅ shipped (`getCitationPath`) |
| citations | `getRelatedDocuments` | `GET /citations/related/{celexNumber}` | P2 | ✅ shipped (`getRelatedDocuments`) |
| semantic | `semanticCaseLawSearch` | `POST /search/semantic` | P2 | ✅ shipped (`semanticSearch`, incl. `hyde`) |
| semantic | `semanticLegislationSearch` | `POST /legislation/semantic` | P2 | ✅ shipped (`semanticLegislationSearch`) |
| export | `exportCorpus` | `GET /export` | P3 | ✅ shipped (`export`, async NDJSON iterator) |
| webhooks | `listWebhooks` / `createWebhook` | `GET/POST /webhooks` | P3 | ✅ shipped (`webhooks.list`/`webhooks.create`) |
| webhooks | `getWebhook` / `updateWebhook` / `deleteWebhook` | `GET/PUT/DELETE /webhooks/{id}` | P3 | ✅ shipped (`webhooks.get`/`update`/`delete`) |
| webhooks | `testWebhook` | `POST /webhooks/{id}/test` | P3 | ✅ shipped (`webhooks.test`) |
| webhooks | `getWebhookDeliveries` | `GET /webhooks/{id}/deliveries` | P3 | ✅ shipped (`webhooks.deliveries`) |

Cross-cutting model work per group: `ErrorResponse`, `SubscriptionInfo`, `UsageInfo`, `CreditsInfo` (P0); search filter enums driven from `/info` capability map where possible instead of hardcoding.
## 3. Language-specific architecture

- **Runtime targets:** Node ≥ 18 (native `fetch`), Deno, Bun, and modern edge runtimes — no HTTP dependency, `fetch` is injectable for testing/polyfills. Server-side only by policy (API keys must not ship to browsers); no browser bundle is advertised.
- **Build:** **tsup** → dual ESM + CJS output with `.d.ts`, `exports` map in `package.json`, `sideEffects: false`.
- **Modules:**
  - `src/client.ts` — `LexAPI` class; single `request()` core (auth header, UA, timeout via `AbortSignal.timeout`, retries); resource namespaces (`client.search(...)`, `client.documents.*`, `client.citations.*`, `client.webhooks.*`).
  - `src/errors.ts` — `LexAPIError` carrying `code/message/details/status/retryAfter`; parses typed envelope and legacy bare `{error}` strings; per-code subclasses where ergonomics warrant (`RateLimitedError`).
  - `src/types.ts` — interfaces for `InfoResponse`, `SubscriptionInfo`, `UsageInfo`, `CreditsInfo`, search/document models. Generated-then-curated from `openapi.yaml` (e.g. `openapi-typescript`) — generation is a dev step, never a runtime dependency.
  - `src/pagination.ts` — `AsyncIterator` page walker (`for await (const hit of client.searchAll(...))`) surfacing `truncated`/`partial` flags.
  - `src/version.ts` — injected at build time; UA `lexapi-typescript/<version>`.
- **Strict TypeScript:** `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **Zero runtime deps** — keeps install light and audit surface minimal.

## 4. Testing strategy

- **Unit tests (vitest):** request construction (x-api-key, UA, JSON headers), error parsing (typed envelope, legacy bare `{error}`, unknown codes, non-JSON bodies), retry/backoff precedence (`Retry-After` header > `RateLimit-*` > JSON `retryAfter` > computed backoff), pagination iterator, credit helpers with/without `credits` block.
- **Mocked HTTP:** injected `fetch` stub (`vi.fn()`) for unit tests; **msw** for recorded/replayed fixture tests — real sanitized response bodies in `test/fixtures/*.json`.
- **Type tests:** `expect-type`/`tsd`-style assertions for the public surface; `tsc --noEmit` in CI on the strict config.
- **Contract tests:** fixtures validated against `openapi.yaml` in CI.
- **Smoke (manual/nightly):** `GET /info` against production with a CI-secret key; not PR-blocking.

## 5. Publishing pipeline (npm) — plan only, nothing published yet

1. Create the `@lexapi` npm org and reserve `@lexapi/client` (**not now**).
2. GitHub Actions release workflow on tag `v*`: `npm ci && npm run build && npm test`, then `npm publish --access public --provenance` (npm provenance/OIDC — no long-lived automation tokens).
3. `prepublishOnly` guard runs build + test; `files` whitelist ships only `dist/`, `README.md`, `LICENSE`.
4. CHANGELOG.md (keep-a-changelog); consider changesets once release cadence picks up.
5. Post-publish verification: install into a clean tmp project (ESM + CJS import smoke test).

## 6. Versioning policy

- **Semver.** `0.x` until the LexAPI v1 surface freeze; during 0.x, minor bumps may break (documented in CHANGELOG), patch bumps never break.
- `1.0.0` is tagged only when: P0+P1 endpoint groups are covered, the shared SDK contract (section 1) is fully implemented, and the API team declares the v1 freeze.
- API additions (new fields/endpoints) → minor. Error-envelope or auth changes → coordinated minor across all four SDKs in the same week.
- Each release records the `openapi.yaml` revision it was generated/validated against.
