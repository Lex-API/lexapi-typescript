# @lexapi/client (TypeScript)

Official TypeScript SDK for [LexAPI](https://lex-api.com) — European legal data, made queryable. EUR-Lex, CJEU case law, and the Official Journal behind one REST API.

> **Status: pre-release (0.x).** Not yet published to npm. See [PLAN.md](PLAN.md) for the endpoint coverage matrix.

## Install

```bash
npm install @lexapi/client   # not yet published
```

Requires Node ≥ 18 (native `fetch`); also works on Deno, Bun, and edge runtimes. **Server-side use only** — API keys are secrets and must never ship in client-side code (the SDK also skips the `User-Agent` header on browser runtimes, where setting it is forbidden).

## Quickstart

```ts
import { LexAPI } from "@lexapi/client";

const client = new LexAPI({ apiKey: "lex_..." }); // or set LEXAPI_API_KEY
const info = await client.getInfo();
console.log(info.subscription, info.usage);
```

Keys come from the [LexAPI dashboard](https://lex-api.com) and are prefixed `lex_`.

## Search & documents

```ts
// Structured search (POST /search)
const hits = await client.search({
  query: "artificial intelligence",
  documentType: ["communication", "guideline"],
  dateFrom: "2025-01-01",
  maxPages: 2,
});
if (hits.truncated) console.warn(hits.truncatedReason); // tier-capped pagination
if (hits.partial) console.warn(hits.partialReason);     // an upstream page timed out
if (hits.xWarning) console.warn(hits.xWarning);         // X-Warning header (e.g. maxPages clamped)

// Single document (POST /documentContent) with payload control
const { document } = await client.getDocument({
  celexNumber: "32016R0679",
  include: ["metadata", "articles"],
  articleId: "17",
});

// Batch (POST /documentContent/batch) — per-CELEX errors don't abort the batch
const batch = await client.getDocumentsBatch({ celexNumbers: ["32016R0679", "62018CJ0311"] });
if (batch.trimmed) console.warn(`clamped to ${batch.trimmedTo}: ${batch.trimmedReason}`);
batch.errors.forEach((e) => console.warn(`${e.celexNumber}: ${e.error}`));

// Recent documents, metadata-only reads, URL + identifier resolution
const recent = await client.getRecentDocuments({ days: 7, documentType: "judgment" });
const meta = await client.getDocumentMetadata({ celexNumber: "32016R0679" });
const byUrl = await client.getDocumentByUrl({ url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679" });
const resolved = await client.resolve("ECLI:EU:C:2020:559"); // → { celex: "62018CJ0311", ... }
```

Truncation/partial signals are always surfaced on the result (`truncated`, `partial`, `postFilteredBy`, `trimmed`/`trimmedTo`, and `xWarning` from the `X-Warning` header) — never swallowed.

## Configuration

```ts
const client = new LexAPI({
  apiKey: "lex_...",              // or LEXAPI_API_KEY env var
  baseUrl: "https://lex-api.com/api/v1", // default
  timeoutMs: 60_000,              // per attempt; per-call override: client.getInfo({ timeoutMs: 5_000 })
  retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30_000 },
  fetch: myFetch,                 // injectable transport (testing / polyfills)
  userAgentSuffix: "my-app/1.0",  // appended to `lexapi-typescript/<version>`
});
```

## Retries

Failed requests are retried up to 3 times (configurable via `retry`) with exponential backoff + full jitter:

- **Retried:** HTTP 429, 502, 503, 504 and transport-level network errors.
- **Server-directed waits win:** the `Retry-After` response **header** is honored first (then `RateLimit-Reset`, then the JSON `retryAfter` body field — epoch-guarded, since that field historically carried buggy absolute timestamps).
- **Non-idempotent safety:** non-GET requests are retried **only on 429** — never on 5xx or network errors, where the request may already have been applied.
- Client-side timeouts throw `TimeoutError` and are not retried.

## Typed errors

Every non-2xx response maps to a typed error carrying `code`, `status`, `details`, and `retryAfter`:

```ts
import { CreditsExhaustedError, NotFoundError, RateLimitedError } from "@lexapi/client";

try {
  await client.getInfo();
} catch (err) {
  if (err instanceof RateLimitedError) console.log(`retry in ${err.retryAfter}s`);
  else if (err instanceof CreditsExhaustedError) console.log(`credits reset at ${err.resetsAt}`);
  else if (err instanceof NotFoundError) console.log("no such document");
  else throw err;
}
```

Subclasses: `NotFoundError`, `InvalidCelexError`, `InvalidUrlError`, `InvalidParamsError`, `AuthenticationError` (401), `RateLimitedError`, `TierForbiddenError`, `CreditsExhaustedError`, `UpstreamError`, `TimeoutError`, `InternalServerError`, `NetworkError`. Both the typed envelope (`{success: false, error: {code, message, details}}`) and the legacy bare `{error, message}` shape are parsed; unknown codes stay on the base `LexAPIError` with the raw code string.

## Credit visibility

Every response keeps its raw `usage` / `credits` blocks; `getCreditUsage` normalizes them:

```ts
import { getCreditUsage } from "@lexapi/client";

const info = await client.getInfo();
const { unitsCharged, creditsRemaining, resetsAt } = getCreditUsage(info);
```

`unitsCharged` maps `credits.operation_weight` (0 for free ops like `/info`); `creditsRemaining` falls back to `usage.remaining` on legacy daily-call accounts.

## Development

```bash
npm install
npm run lint   # tsc --noEmit (strict)
npm test       # vitest
npm run build  # tsup -> dist/ (ESM + CJS + d.ts)
```

Zero runtime dependencies. Docs: <https://lex-api.com/docs>
