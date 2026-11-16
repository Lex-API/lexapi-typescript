# @lexapi/client (TypeScript)

Official TypeScript SDK for [LexAPI](https://lex-api.com/?ref=npm-sdk) — European legal data, made queryable. EUR-Lex legislation, CJEU case law, national law and the Official Journal behind one REST API, parsed to article level.

[![npm](https://img.shields.io/npm/v/@lexapi/client)](https://www.npmjs.com/package/@lexapi/client) · [API docs](https://lex-api.com/docs?ref=npm-sdk) · [Changelog](https://github.com/Lex-API/lexapi-typescript/blob/main/CHANGELOG.md)

## Install

```bash
npm install @lexapi/client
```

Node ≥ 18 (native `fetch`). Zero runtime dependencies, ESM + CommonJS, typed. **Server-side only**: API keys are secrets and must not ship in client-side code.

## Quickstart

```ts
import { LexAPI } from "@lexapi/client";

const client = new LexAPI({ apiKey: "lex_..." }); // or set LEXAPI_API_KEY
const info = await client.getInfo();               // free (0 credits)
console.log(info.subscription?.tier, info.credits?.remaining);
```

Keys come from the [LexAPI dashboard](https://lex-api.com/dashboard?ref=npm-sdk) and are prefixed `lex_`. Calls are billed from a monthly credit pool ([plans](https://lex-api.com/pricing?ref=npm-sdk)); each method's doc comment states its cost.

## Search & documents

```ts
const hits = await client.search({
  query: "artificial intelligence",
  documentType: ["communication", "guideline"],
  dateFrom: "2025-01-01",
});

const { document } = await client.getDocument({
  celexNumber: "32016R0679",
  include: ["metadata", "articles"],
  articleId: "17",
});

const batch = await client.getDocumentsBatch({ celexNumbers: ["32016R0679", "62018CJ0311"] });
const meta = await client.getDocumentMetadata({ celexNumber: "32016R0679" });
const resolved = await client.resolve("ECLI:EU:C:2020:559"); // CELEX/URL/ELI/ECLI → CELEX
```

A document without published text is a `200` with `content: null` and a `textAvailability` verdict.

## Semantic search

```ts
const cases = await client.semanticSearch({ query: "transfer of personal data to third countries", limit: 10 });

const articles = await client.semanticLegislationSearch({ query: "right to be forgotten" });
for (const hit of articles.results) {
  console.log(hit.law_id, hit.article_ref, hit.score, hit.snippet);
  if (hit.consolidated) console.log("cite", hit.baseCelex); // consolidated texts are not authentic
}

// The law as in force on a past date
const asOf = await client.semanticLegislationSearch({ query: "own funds requirements", asOf: "2019-06-01" });
```

## Citations

```ts
await client.extractCitations("32016R0679");
const outbound = await client.getCites("32016R0679", { citationType: "repeal" });
const inbound = await client.getCitedBy("32008R1272", { citationType: "corrigendum" });
const network = await client.getCitationNetwork("62018CJ0311", { limit: 100 });
const path = await client.getCitationPath("32016R0679", "31995L0046", { maxDepth: 5 });
const related = await client.getRelatedDocuments("32016R0679", { limit: 10 });

const t = await client.getTransposition("32016L0680", { jurisdictions: ["es", "cz"] });
console.log(t.note); // a notification is not a finding that the measure transposes the act
console.log(t.source.cellar?.attribution); // keep with anything you republish
```

## National law

```ts
const coverage = await client.getNationalCoverage(); // free
const { document } = await client.getNationalDocument("AT", "AT-NOR-10001597");
console.log(document.attribution);
const hits = await client.nationalSemanticSearch("AT", { query: "Datenschutz bei Bankgeschäften" });
```

Every national result carries `attribution` (the official source and its licence); LexAPI's Terms require it to be kept with republished content.

## Webhooks

```ts
const created = await client.webhooks.create({
  name: "Chemicals compliance watch",
  url: "https://example.com/webhooks/lexapi",
  searchCriteria: { documentType: "regulation", query: "chemical*" },
  watchCelex: ["32006R1907", "32008R1272"],
});
console.log(created.webhook.secret); // returned only here: store it
```

Verifying a delivery (keep the **raw** body):

```ts
import { verifyWebhook } from "@lexapi/client";

const event = await verifyWebhook(rawBody, signatureHeader, process.env.LEXAPI_WEBHOOK_SECRET!);
```

## Corpus export (BUSINESS, SCALE, ENTERPRISE)

```ts
const stream = await client.export({ documentTypeCode: "regulation", dateFrom: "2024-01-01", limit: 10_000 });
for await (const row of stream) {
  ingest(row.celex, row.documentTypeCode, row.parsedContent);
}
```

Using LexAPI content to train, fine-tune or evaluate ML models needs a separate licence ([Terms §6](https://lex-api.com/terms?ref=npm-sdk#acceptable-use)). [Arieta Data](https://data.arietalabs.com/?ref=npm-sdk), a sister product from Arieta Labs, licenses datasets drawn from the same corpus.

## Errors and configuration

```ts
import { CreditsExhaustedError, NotFoundError, RateLimitedError } from "@lexapi/client";

try {
  await client.semanticSearch({ query: "gdpr" });
} catch (err) {
  if (err instanceof RateLimitedError) console.log(`retry in ${err.retryAfter}s`);
  else if (err instanceof CreditsExhaustedError) console.log(`need ${err.weight}, have ${err.available}; resets ${err.resetsAt}`);
  else if (err instanceof NotFoundError) console.log("no such document");
  else throw err;
}

const configured = new LexAPI({
  apiKey: "lex_...",
  timeoutMs: 95_000,
  retry: { maxRetries: 3 },
});
```

Retries are automatic only where a retry cannot charge you twice. Every method takes `{ signal }` for cancellation.

## Development

```bash
npm ci
npm run lint
npm test
npm run build
```

## License

MIT
