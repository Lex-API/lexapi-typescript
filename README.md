# @lexapi/client (TypeScript)

Official TypeScript SDK for [LexAPI](https://lex-api.com) — European legal data, made queryable. EUR-Lex, CJEU case law, and the Official Journal behind one REST API.

> **Status: pre-release scaffold (0.x).** API coverage and installation instructions below are placeholders until the first npm release. See [PLAN.md](PLAN.md).

## Install

```bash
npm install @lexapi/client   # not yet published
```

Requires Node ≥ 18 (native `fetch`). Server-side use only — API keys must never ship in client-side code.

## Quickstart

```ts
import { LexAPI } from "@lexapi/client";

const client = new LexAPI({ apiKey: "lex_..." }); // or set LEXAPI_API_KEY
const info = await client.getInfo();
console.log(info.subscription, info.usage);
```

Keys come from the [LexAPI dashboard](https://lex-api.com) and are prefixed `lex_`.

## Development

```bash
npm install
npm run lint   # tsc --noEmit (strict)
npm test       # vitest
npm run build  # tsup -> dist/ (ESM + CJS + d.ts)
```

Docs: <https://lex-api.com/docs>
