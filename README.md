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

## Citations

```ts
await client.extractCitations("32016R0679");          // crawl + persist (idempotent)
const outbound = await client.getCites("32016R0679", { citationType: "repeal" });
const inbound = await client.getCitedBy("32016R0679", { limit: 50 });

const network = await client.getCitationNetwork("62018CJ0311", { limit: 100 });
if (network.partial) console.warn(network.message);   // server budget expired — network is EMPTY, not zero

const path = await client.getCitationPath("32016R0679", "31995L0046", { maxDepth: 5 });
if (!path.found) console.log(path.message);           // graceful 200, not an error

const related = await client.getRelatedDocuments("32016R0679"); // bibliographic coupling
const stats = await client.getCitationStats();
```

## Semantic search

```ts
// Case law (POST /search/semantic) — 5 credits
const hits = await client.semanticSearch({
  query: "transfer of personal data to third countries",
  limit: 10,
  minScore: 0.5,      // unset applies the upstream's ~0.7 relevance floor
  includeText: true,  // full document text per hit instead of ~600-char snippets
});
if (hits.hint) console.warn(hits.hint); // present only on low-confidence result sets

// HyDE query rewriting — 15 credits instead of 5, ~1-3s extra latency.
// Best-effort: on LLM failure it falls back to plain retrieval, the response
// reports hyde: false, and the 10-credit premium is refunded automatically.
const hyde = await client.semanticSearch({ query: "credit scoring article 22", hyde: true });
console.log(hyde.hyde, hyde.hypotheticalDocument, hyde.credits?.operation_weight);

// Legislation (POST /legislation/semantic) — article-level matches; no hyde option
const articles = await client.semanticLegislationSearch({ query: "right to be forgotten" });
console.log(articles.results[0]?.article_ref, articles.results[0]?.law_id);
```

Persistent identity for case-law hits is `(metadata.celex_id, metadata.document_type)` — `case_id` is snapshot-scoped and does not survive index rebuilds.

## Webhooks

```ts
const created = await client.webhooks.create({
  name: "New CJEU judgments",
  url: "https://example.com/webhooks/lexapi",
  searchCriteria: { documentType: "judgment", author: ["court-of-justice"] },
});
console.log(created.webhook.secret); // returned ONLY here — store it (HMAC-SHA256 signing key)

const { webhooks } = await client.webhooks.list();
const detail = await client.webhooks.get(created.webhook.id); // includes recentDeliveries
await client.webhooks.update(created.webhook.id, { status: "ACTIVE" }); // resets consecutiveFailures
await client.webhooks.test(created.webhook.id);               // synchronous signed test delivery
const history = await client.webhooks.deliveries(created.webhook.id, { limit: 50 });
await client.webhooks.delete(created.webhook.id);             // 204 → resolves void
```

## Corpus export (BUSINESS tier)

`export()` streams NDJSON rows via the fetch body stream — constant memory regardless of result size:

```ts
const stream = await client.export({ documentType: "regulation", dateFrom: "2024-01-01", limit: 10_000 });

console.log(stream.meta);           // leading _meta envelope (parsed before iteration)
console.log(stream.headers.total);  // X-Export-Total header

for await (const row of stream) {
  process(row.celex, row.documentTypeCode, row.parsedContent);
}

console.log(stream.done);           // trailing _done line (available after iteration)
if (stream.done?.truncated) console.warn("row cap hit — narrow filters or resume via fetchedSince");
```

The `_meta`/`_done` envelope lines are never yielded as rows; the stream is single-pass.

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

## Point-in-time versions

> Requires a LexAPI deployment with the point-in-time endpoints (lex-api PR #72).
> Versions are LexAPI *observation snapshots* — the document as fetched — not
> legal in-force reconstructions; history begins at first ingestion.

```ts
const history = await client.listDocumentVersions("32016R0679");
console.log(history.currentVersion, history.trackedSince);

const snapshot = await client.getDocumentVersion("32016R0679", 2);
console.log(snapshot.document.parsedContent);

const asOf = await client.getDocumentAtDate("32016R0679", "2026-03-20");
console.log(asOf.asOf, asOf.document.version);
```

Each call costs 1 credit. Dates before the document entered the corpus reject
with `NotFoundError` carrying the tracking start date.

## Development

```bash
npm install
npm run lint   # tsc --noEmit (strict)
npm test       # vitest
npm run build  # tsup -> dist/ (ESM + CJS + d.ts)
```

Zero runtime dependencies. Docs: <https://lex-api.com/docs>
