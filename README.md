# @lexapi/client (TypeScript)

Official TypeScript SDK for [LexAPI](https://lex-api.com/?ref=npm-sdk) — European legal data, made queryable. EUR-Lex legislation, CJEU case law and the Official Journal behind one REST API, parsed to article level.

[![npm](https://img.shields.io/npm/v/@lexapi/client)](https://www.npmjs.com/package/@lexapi/client) · [API docs](https://lex-api.com/docs?ref=npm-sdk) · [Changelog](CHANGELOG.md)

## Install

```bash
npm install @lexapi/client
```

Node ≥ 18 (native `fetch`); also works on Deno, Bun and edge runtimes. Zero runtime dependencies, ESM + CommonJS, strict hand-curated types. **Server-side only** — API keys are secrets and must never ship in client-side code (the SDK also skips the `User-Agent` header on browser runtimes, where setting it is forbidden).

## Quickstart

```ts
import { LexAPI } from "@lexapi/client";

const client = new LexAPI({ apiKey: "lex_..." }); // or set LEXAPI_API_KEY
const info = await client.getInfo();               // free (0 credits)
console.log(info.subscription?.tier, info.credits?.remaining);
```

Keys come from the [LexAPI dashboard](https://lex-api.com/dashboard?ref=npm-sdk) and are prefixed `lex_`.

## What each call costs

LexAPI bills a monthly credit pool ([plans](https://lex-api.com/pricing?ref=npm-sdk)). The SDK method docs repeat these:

| Credits | Calls |
| --- | --- |
| 0 | `getInfo`; webhook management and deliveries |
| 1 | `resolve`, `getCites`, `getCitedBy`, the version endpoints; per exported row |
| 3 per page | `search` (`maxPages`), `getRecentDocuments` (~10 results per page) — unfetched pages refunded |
| 5 → 4 → 1 | `getDocument`, `getDocumentsBatch` (per item), `getDocumentByUrl`, `getDocumentMetadata`, `extractCitations` — 5 for a live browser fetch, settled to **4** when the Publications Office Cellar API answered, to **1** from the LexAPI corpus (`result.headers.source`) |
| 5 | `semanticSearch`, `semanticLegislationSearch` (+ per live `asOf` fetch, see below) |
| 15 | `semanticSearch({ hyde: true })` — refunded to 5 if HyDE falls back |
| 20 | `getCitationNetwork`, `getCitationPath`, `getRelatedDocuments`, `getCitationStats` |

Failed requests refund automatically (400/403 and 5xx in full; a 404 settles at 1). Refunds land just after the response, so a response's `credits` block can still show the upfront charge.

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
if (hits.partial) console.warn(hits.partialReason);     // a page timed out — or source: "corpus"
if (hits.hint) console.log(hits.hint);                  // zero results → try semantic search
console.log(hits.headers?.searchSource, hits.headers?.searchCache); // "soap" | "cellar" | "corpus", "hit" | "miss" | "bypass"
await client.search({ query: "*", year: 2024, subdomain: "EU_CASE_LAW", fresh: true }); // filter-only, skip the 1 h cache

// Single document (POST /documentContent)
const { document, headers } = await client.getDocument({
  celexNumber: "32016R0679",
  include: ["metadata", "articles"],
  articleId: "17",
});
console.log(headers?.source); // "corpus" (1 credit) | "cellar" | "cellar-oj" (4) | "live" (5)

// Batch (POST /documentContent/batch) — per-CELEX errors don't abort the batch
const batch = await client.getDocumentsBatch({ celexNumbers: ["32016R0679", "62018CJ0311"] });
if (batch.trimmed) console.warn(`clamped to ${batch.trimmedTo}: ${batch.trimmedReason}`);
batch.errors.forEach((e) => console.warn(`${e.celexNumber}: ${e.error}`));
console.log(batch.textUnavailable, batch.headers?.batch); // { corpusHits, cellarServed, ojRecovered, liveFetches }

// Recent documents, metadata-only reads, URL + identifier resolution
const recent = await client.getRecentDocuments({ days: 7, documentType: ["regulation", "directive"] });
const meta = await client.getDocumentMetadata({ celexNumber: "32016R0679" });
const byUrl = await client.getDocumentByUrl({ url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679" });
const resolved = await client.resolve("ECLI:EU:C:2020:559"); // → { celex: "62018CJ0311", resolvedVia: "ecli-corpus" }
```

### Text availability and languages

A document can exist while EUR-Lex publishes no text for it. That is a `200` with metadata, `content: null` and a `textAvailability` verdict — billed 1 credit, not 5. **Check it before reading `content`:**

```ts
const { document } = await client.getDocument({ celexNumber: "32008R1272", language: "de" });
const ta = document.textAvailability;
if (ta && !ta.available) {
  console.log(ta.reason);              // not_in_language | not_published_yet | no_machine_readable_rendition | too_large | unknown
  console.log(ta.availableLanguages);  // null = unknown, [] = known to be none
  console.log(ta.latestConsolidated?.celex); // base acts: the consolidated version to fetch instead
}
```

`language` localizes the whole document and falls back to English (`languageRequested` / `languageFallback`). Pass `acceptLanguages: ["fr", "de"]` (or `"any"`) to get the authentic text in one call when the requested language has none. `titleLanguage` is present only when the title is not in the language you asked for.

Truncation/partial signals are always surfaced on the result (`truncated`, `partial`, `postFilteredBy`, `trimmed`/`trimmedTo`, `xWarning`) — never swallowed.

## Semantic search

```ts
// Case law (POST /search/semantic) — 5 credits
const cases = await client.semanticSearch({
  query: "transfer of personal data to third countries",
  limit: 10,
  minScore: 0.5,      // unset applies the upstream's ~0.7 relevance floor
  includeText: true,  // full text per hit instead of the default ~600-char `snippet`
});
if (cases.hint) console.warn(cases.hint); // present only on low-confidence result sets

// HyDE query rewriting — 15 credits instead of 5, ~1-3 s extra latency.
// Best-effort: on LLM failure the response reports hyde: false and the premium is refunded.
const hyde = await client.semanticSearch({ query: "credit scoring article 22", hyde: true });
console.log(hyde.hyde, hyde.hypotheticalDocument);

// Legislation (POST /legislation/semantic) — article-level matches, limit ≤ 50
const articles = await client.semanticLegislationSearch({ query: "right to be forgotten" });
for (const hit of articles.results) {
  console.log(hit.law_id, hit.article_ref, hit.score, hit.snippet);
  if (hit.consolidated) {
    // One hit per article: the consolidated text, labelled. Consolidated texts are not
    // authentic — cite hit.baseCelex (the Official Journal act); hit.baseAct is its own match.
    console.log(hit.consolidatedAsOf, hit.baseCelex, hit.consolidatedNote, hit.baseAct?.score);
  }
}
```

Persistent identity for case-law hits is `(metadata.celex_id, metadata.document_type)` — `case_id` is snapshot-scoped and does not survive index rebuilds.

### The text in force on a date (`asOf`)

```ts
const asOf = await client.semanticLegislationSearch({ query: "own funds requirements", asOf: "2019-06-01" });

console.log(asOf.asOfSummary); // { liveFetches, unresolved }
for (const hit of asOf.results) {
  if (hit.asOfResolved) {
    console.log(hit.asOfVersion);    // { celex, date, kind: "consolidated" | "as_published" }
    console.log(hit.matchedVersion); // when the text was swapped: what the index actually matched
  } else {
    console.log(hit.asOfReason);     // e.g. "not_yet_in_force", "fetch_timeout" — the hit keeps its latest text
  }
}
```

The act must be in force on that date; the version is the act as published before its first consolidation, otherwise the consolidated version in force (later versions never count). `asOf` accepts `1952-01-01` … today (UTC); an invalid date is a 400 `InvalidParamsError`, refunded in full. **Cost:** 5 for the search; each live fetch of a version the corpus doesn't hold reserves 5 and settles by outcome (Cellar 4, browser 5, no text 1, failed 0), at most 3 per request by default. A fetch your pool can't cover is skipped (`asOfReason: "insufficient_credits"`) — never a 402. `AS_OF_REASONS` lists every documented reason.

## Citations

```ts
await client.extractCitations("32016R0679");                 // crawl + persist (idempotent)
const outbound = await client.getCites("32016R0679", { citationType: "repeal" });
const inbound = await client.getCitedBy("32008R1272", { citationType: "corrigendum" });
console.log(inbound.relationSync?.status);                     // fresh | refreshed | pending | …

for await (const page of client.paginateCitedBy("32016R0679", { limit: 200 })) {
  page.citedBy.forEach((g) => console.log(g.celexNumber, g.titleSource)); // 1 credit per page
}

const network = await client.getCitationNetwork("62018CJ0311", { limit: 100 });
if (network.partial) console.warn(network.message);   // server budget expired — network is EMPTY, not zero

const path = await client.getCitationPath("32016R0679", "31995L0046", { maxDepth: 5 });
if (!path.found) console.log(path.message);           // graceful 200, not an error

const related = await client.getRelatedDocuments("32016R0679", { limit: 10 }); // bibliographic coupling
const stats = await client.getCitationStats();
```

`citationType` is one of `reference`, `amendment`, `repeal`, `corrigendum`, `implementation`, `legal-basis`, `proposal`. All graph reads accept `language` for neighbour titles.

## Webhooks

```ts
const created = await client.webhooks.create({
  name: "Chemicals compliance watch",
  url: "https://example.com/webhooks/lexapi",
  searchCriteria: { documentType: "regulation", query: "chemical*" }, // documents.new (titles)
  watchCelex: ["32006R1907", "32008R1272"],                          // watchlist.changes
});
console.log(created.webhook.secret); // returned ONLY here — store it (HMAC-SHA256 signing key)

const { webhooks } = await client.webhooks.list();             // criteriaErrors, watchCelex, deliveryCount
const detail = await client.webhooks.get(created.webhook.id);  // retryPolicy, recentDeliveries
const resumed = await client.webhooks.update(created.webhook.id, { status: "ACTIVE" });
console.log(resumed.requeuedDeliveries);
await client.webhooks.update(created.webhook.id, { searchCriteria: null }); // keep only the watch list
await client.webhooks.test(created.webhook.id);                // synchronous signed test delivery
for await (const page of client.webhooks.paginateDeliveries(created.webhook.id)) console.log(page.deliveries.length);
await client.webhooks.delete(created.webhook.id);
```

Webhooks per account: FREE 0 · STARTER 2 · PROFESSIONAL 10 · BUSINESS 50 · SCALE 100 · ENTERPRISE 100. Unsupported criteria are refused with a 400 `InvalidParamsError` whose `details` names each problem. Write calls are never retried on 5xx.

### Receiving deliveries

```ts
import { constructWebhookEvent } from "@lexapi/client";

// Express: keep the RAW body — the signature is over the exact bytes sent.
app.post("/webhooks/lexapi", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = await constructWebhookEvent(req.body, req.get("x-webhook-signature"), process.env.LEXAPI_WEBHOOK_SECRET!);
    // Verified signature + 5-minute replay window. Dedupe on event.delivery?.id (stable across retries).
    if (event.event === "watchlist.changes") {
      for (const c of event.data.changes) console.log(c.watchedCelex, c.relation, c.document.celex);
    } else if (event.event === "documents.new") {
      console.log(event.data.count, event.data.totalAvailable);
    }
    res.sendStatus(200); // respond within 10 s
  } catch {
    res.sendStatus(401);
  }
});
```

`verifyWebhookSignature(rawBody, signature, secret)` is the signature-only check. Both use Web Crypto (constant-time comparison).

## Corpus export (BUSINESS, SCALE, ENTERPRISE)

`export()` streams NDJSON rows via the fetch body stream — constant memory regardless of result size. 1 credit per row; lower tiers get a 403 `TierForbiddenError`. Licensing: exported content may not be used to train or evaluate ML models without a separate licence ([Terms §6](https://lex-api.com/terms?ref=npm-sdk#acceptable-use)).

```ts
const stream = await client.export({ documentType: ["Regulation"], dateFrom: "2024-01-01", limit: 10_000 });

console.log(stream.meta?.totalMatching, stream.headers.total); // leading _meta envelope / X-Export-Total

for await (const row of stream) {
  process(row.celex, row.documentTypeCode, row.parsedContent);
}

console.log(stream.done?.written, stream.done?.skippedStubs);
if (stream.done?.truncated) console.warn("row cap hit — narrow filters or resume via fetchedSince");
```

The `_meta`/`_done` envelope lines are never yielded as rows; the stream is single-pass. Breaking out of the loop (or `stream.cancel()`) releases the connection. Metadata-only rows are skipped unless `includeStubs: true`.

## Point-in-time versions

Versions are LexAPI *observation snapshots* — the document as fetched — not legal in-force reconstructions; history begins at first ingestion. (For the text in force on a date, use a consolidated CELEX or `semanticLegislationSearch({ asOf })`.)

```ts
const history = await client.listDocumentVersions("32016R0679");
console.log(history.currentVersion, history.trackedSince);

const snapshot = await client.getDocumentVersion("32016R0679", 2);
console.log(snapshot.document.parsedContent, snapshot.corpusVersion);

const atDate = await client.getDocumentAtDate("32016R0679", "2026-03-20");
console.log(atDate.asOf, atDate.document.version);
```

Each call costs 1 credit. Dates before the document entered the corpus reject with `NotFoundError` carrying the tracking start date.

## Response headers

Every JSON result carries `headers` — the LexAPI response headers, parsed:

```ts
const r = await client.getDocument({ celexNumber: "32016R0679" });
r.headers?.source;            // X-Source: corpus | cellar | cellar-oj | live
r.headers?.rateLimit;         // { limit, remaining, reset (seconds), policy }
r.headers?.languageFallback;  // X-Language-Fallback
r.headers?.textAvailable;     // X-Text-Available
r.headers?.corpusVersion;     // X-Corpus-Version
```

Also: `searchSource`, `searchCache`, `warning`, `ignoredDocumentTypes`, `postFilteredBy`, `documentTypeFanOut`, `batch`. The older `xWarning` (and `corpusVersion` on version responses) are still set.

## Configuration

```ts
const client = new LexAPI({
  apiKey: "lex_...",                     // or LEXAPI_API_KEY env var
  baseUrl: "https://lex-api.com/api/v1", // default
  timeoutMs: 95_000,                     // per attempt (> the API's 90 s upstream budget); per-call: client.getInfo({ timeoutMs: 5_000 })
  retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30_000, retryReadOnlyPosts: false },
  fetch: myFetch,                        // injectable transport (testing / polyfills)
  userAgentSuffix: "my-app/1.0",         // appended to `lexapi-typescript/<version>`
});
```

## Retries

Failed requests are retried up to 3 times (configurable via `retry`) with exponential backoff + full jitter:

- **GET:** retried on 429, 502, 503, 504, Cloudflare 520–524 and transport-level network errors.
- **POST / PUT / DELETE:** retried on 429 only. Opt in with `retry: { retryReadOnlyPosts: true }` to also retry the read-only POSTs (search, document reads, batch, by-URL, metadata, resolve, citation extraction, semantic search) on 502/503/504 — the API refunds 5xx in full, so such a retry is not double-billed. Network errors and 520–524 on POST are never retried (the request may already have reached the API and been charged); webhook writes never retry on 5xx.
- **Never retried:** 500 `INTERNAL`, every other 4xx (402 cannot succeed until the pool resets), and legacy-plan quota 429s (`RateLimitedError.quotaExhausted` — daily / monthly-semantic quota, see `resetsAt`).
- **Server-directed waits win:** the `Retry-After` header (any status); on a 429 only, then `RateLimit-Reset` and the JSON `retryAfter` body field (epoch-guarded). `RateLimit-*` is sent on every response, so it never drives the wait for a 5xx.
- The default per-attempt timeout is 95 s — above the API's 90 s upstream budget, so a slow live fetch ends in the server's typed, refunded 504. Client-side timeouts throw `TimeoutError` (status 0) and are not retried.

## Typed errors

Every non-2xx response maps to a typed error carrying `code`, `status`, `message`, `details`, `retryAfter`, the raw `body` and parsed `headers`:

```ts
import { CreditsExhaustedError, NotFoundError, RateLimitedError, TierForbiddenError } from "@lexapi/client";

try {
  await client.semanticSearch({ query: "gdpr" });
} catch (err) {
  if (err instanceof RateLimitedError && err.quotaExhausted) console.log(`legacy quota resets ${err.resetsAt}`);
  else if (err instanceof RateLimitedError) console.log(`retry in ${err.retryAfter}s`, err.rateLimit);
  else if (err instanceof CreditsExhaustedError) console.log(`need ${err.weight}, have ${err.available}; resets ${err.resetsAt}`);
  else if (err instanceof TierForbiddenError) console.log((err.body as { upgradeUrl?: string })?.upgradeUrl);
  else if (err instanceof NotFoundError) console.log("no such document");
  else throw err;
}
```

| Class | `code` | HTTP |
| --- | --- | --- |
| `NotFoundError` | `NOT_FOUND` | 404 |
| `InvalidCelexError` / `InvalidUrlError` / `InvalidParamsError` | `INVALID_CELEX` / `INVALID_URL` / `INVALID_PARAMS` | 400 |
| `AuthenticationError` | `UNAUTHORIZED` (derived) | 401 |
| `CreditsExhaustedError` | `CREDITS_EXHAUSTED` | 402 |
| `TierForbiddenError` | `TIER_FORBIDDEN` | 403 |
| `RateLimitedError` | `RATE_LIMITED` | 429 |
| `InternalServerError` | `INTERNAL` | 500 |
| `UpstreamError` | `UPSTREAM_ERROR` | 502; Cloudflare 520–523 |
| `ServiceUnavailableError` | `SERVICE_UNAVAILABLE` (derived) | 503 |
| `TimeoutError` | `TIMEOUT` | 504; Cloudflare 524; 0 for a client-side timeout |
| `NetworkError` | `NETWORK_ERROR` | 0 (no response) |

Both the typed envelope (`{success: false, error: {code, message, details}}`) and the legacy bare `{error, message, details?}` shape (still used by 429s, API-key 401s, `/search` and webhook validation, the export tier gate and semantic upstream errors) are parsed; unknown codes stay on the base `LexAPIError` with the raw code string.

## Credit visibility

Every response keeps its raw `usage` / `credits` blocks; `getCreditUsage` normalizes them:

```ts
import { getCreditUsage } from "@lexapi/client";

const { unitsCharged, creditsRemaining, resetsAt } = getCreditUsage(await client.getInfo());
```

`unitsCharged` maps `credits.operation_weight` (0 for free ops like `/info`); `creditsRemaining` falls back to `usage.remaining` on legacy daily-call accounts.

## Development

```bash
npm ci
npm run lint        # tsc --noEmit (strict)
npm test            # vitest (Node ≥ 20)
npm run build       # tsup -> dist/ (ESM + CJS + d.ts / d.cts)
npm run smoke:dist  # framework-free check of the built bundles (runs on Node 18+)
```

See [PLAN.md](PLAN.md) for the endpoint coverage matrix and SDK contract. Docs: <https://lex-api.com/docs?ref=npm-sdk>
