// Random hostile answers against every public method: the only errors that
// may escape are the SDK's own, every retry wait is a delay a timer honours,
// and every call (and every iterator) ends.
import { afterEach, describe, expect, it, vi } from "vitest";

import { LexAPI, LexAPIError, WebhooksAPI, type RetryOptions } from "../src/index.js";

const BASE = "http://127.0.0.1:9/api/v1";
const ATTEMPT_TIMEOUT_MS = 12_345;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Small seeded PRNG (mulberry32), so a failure can be replayed. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = [
  "success", "error", "code", "message", "details", "retryAfter", "results", "deliveries", "cites", "citedBy",
  "total", "totalEdges", "hasMore", "nextCursor", "limit", "offset", "credits", "usage", "operation_weight",
  "remaining", "resetsAt", "document", "content", "articles", "citationCount", "citations", "celexNumber", "id",
  "partialReason", "score", "network", "path", "related", "jurisdictions", "via", "documents", "errors",
  "versions", "webhooks", "webhook", "stats", "mostCited", "weight", "available", "timeoutMs", "candidates",
  "asOf", "asOfResolved", "_meta", "_done", "_error", "complete", "truncated", "service", "status",
];
const CODES = [
  "RATE_LIMITED", "QUOTA_EXHAUSTED", "CREDITS_EXHAUSTED", "NOT_FOUND", "INVALID_PARAMS", "UPSTREAM_ERROR",
  "NATIONAL_SEMANTIC_UNAVAILABLE", "DOCUMENT_WITHDRAWN", "UNAUTHORIZED", "TIER_FORBIDDEN", "INTERNAL", "",
];
const SCALARS = [
  "1e999", "-1e999", "1" + "0".repeat(400), "-" + "9".repeat(400), "9007199254740993", "-0", "0", "-1", "-5",
  "0.5", "1e300", "1e-300", "2147483648", "true", "false", "null", '""', '"x"', '"5"', '"inf"', '"NaN"',
  '"Fri, 31 Dec 9999 23:59:59 GMT"', '"\\u0000"', "[]", "{}",
];

function jsonText(rand: () => number, depth: number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const r = rand();
  if (depth > 4 || r < 0.35) {
    if (rand() < 0.15) return JSON.stringify(pick(CODES));
    return pick(SCALARS);
  }
  if (r < 0.45) {
    const n = Math.floor(rand() * 4);
    return `[${Array.from({ length: n }, () => jsonText(rand, depth + 1)).join(",")}]`;
  }
  if (r < 0.48) {
    const levels = pick([50, 5_000, 100_000]);
    return "[".repeat(levels) + "]".repeat(levels);
  }
  const n = 1 + Math.floor(rand() * 6);
  const members = Array.from({ length: n }, () => `${JSON.stringify(pick(KEYS))}:${jsonText(rand, depth + 1)}`);
  return `{${members.join(",")}}`;
}

const HEADER_VALUES = [
  "nan", "inf", "-inf", "Infinity", "-3", "-0", "0", "5", "1e999", "9".repeat(400), "junk", "junk 1", "",
  "Fri, 31 Dec 9999 23:59:59 GMT", "Thu, 01 Jan 1970 00:00:00 GMT", "Sun Nov  6 08:49:37 1994", "0x10", "2.5",
  "99999999999",
];
const HEADER_NAMES = [
  "retry-after", "ratelimit-reset", "ratelimit-limit", "ratelimit-remaining", "x-lexapi-version", "x-corpus-version",
  "x-cache-age", "x-export-total", "x-export-streaming", "x-export-truncated", "x-batch-corpus-hits", "x-national-limit",
];
const STATUSES = [200, 200, 200, 201, 204, 400, 401, 402, 403, 404, 409, 410, 429, 429, 500, 502, 503, 503, 504, 520, 521, 524];

function hostileReply(rand: () => number): Response {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const status = pick(STATUSES);
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (let i = Math.floor(rand() * 5); i > 0; i--) headers[pick(HEADER_NAMES)] = pick(HEADER_VALUES);
  let body: string | null;
  const r = rand();
  if (status === 204) body = null;
  else if (r < 0.08) body = "<html>proxy</html>";
  else if (r < 0.12) body = "";
  else if (r < 0.3) {
    // NDJSON-ish, for the export stream.
    const lines = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => jsonText(rand, 1));
    if (rand() < 0.5) lines.unshift('{"_meta":{"total":1}}');
    if (rand() < 0.5) lines.push(pick(['{"_done":{"complete":true}}', '{"_done":{"complete":false}}', '{"_error":{"code":"X"}}']));
    body = lines.join("\n") + (rand() < 0.5 ? "\n" : "");
  } else body = jsonText(rand, 0);
  return new Response(body, { status, headers });
}

/** Every public method, called with plausible arguments; iterators and streams are drained (bounded). */
const CALLS: Record<string, (c: LexAPI) => Promise<unknown>> = {
  getInfo: (c) => c.getInfo(),
  search: (c) => c.search({ query: "data protection" }),
  getDocument: (c) => c.getDocument({ celexNumber: "32016R0679" }),
  getDocumentsBatch: (c) => c.getDocumentsBatch({ celexNumbers: ["32016R0679", "32019R1150"] }),
  getRecentDocuments: (c) => c.getRecentDocuments(),
  getDocumentByUrl: (c) => c.getDocumentByUrl({ url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj" }),
  getDocumentMetadata: (c) => c.getDocumentMetadata({ celexNumber: "32016R0679" }),
  resolve: (c) => c.resolve("32016R0679"),
  listDocumentVersions: (c) => c.listDocumentVersions("32016R0679"),
  getDocumentVersion: (c) => c.getDocumentVersion("32016R0679", 2),
  getDocumentAtDate: (c) => c.getDocumentAtDate("32016R0679", "2020-01-01"),
  extractCitations: (c) => c.extractCitations("32016R0679"),
  getCites: (c) => c.getCites("32016R0679"),
  getCitedBy: (c) => c.getCitedBy("32016R0679"),
  paginateCites: (c) => drain(c.paginateCites("32016R0679", { limit: 2 })),
  paginateCitedBy: (c) => drain(c.paginateCitedBy("32016R0679", { limit: 2 })),
  getCitationNetwork: (c) => c.getCitationNetwork("32016R0679"),
  getCitationPath: (c) => c.getCitationPath("32016R0679", "32019R1150"),
  getRelatedDocuments: (c) => c.getRelatedDocuments("32016R0679"),
  getCitationStats: (c) => c.getCitationStats(),
  getTransposition: (c) => c.getTransposition("32016L0680"),
  getCounterparts: (c) => c.getCounterparts("AT-NOR-1"),
  getNationalCoverage: (c) => c.getNationalCoverage(),
  getNationalDocument: (c) => c.getNationalDocument("AT", "AT-NOR-1"),
  listNationalDocuments: (c) => c.listNationalDocuments("AT"),
  paginateNationalDocuments: (c) => drain(c.paginateNationalDocuments("AT", { limit: 2 })),
  nationalSemanticSearch: (c) => c.nationalSemanticSearch("AT", { query: "Datenschutz" }),
  nationalLegislationSemanticSearch: (c) => c.nationalLegislationSemanticSearch("AT", { query: "Datenschutz" }),
  semanticSearch: (c) => c.semanticSearch({ query: "data transfer" }),
  semanticLegislationSearch: (c) => c.semanticLegislationSearch({ query: "erasure" }),
  legislationAsOf: (c) => c.legislationAsOf({ document: "32016R0679", asOf: "2020-01-01" }),
  export: async (c) => {
    const stream = await c.export({ limit: 5 });
    void stream.meta, stream.truncated, stream.headers.total;
    return drain(stream);
  },
  "webhooks.list": (c) => c.webhooks.list(),
  "webhooks.create": (c) => c.webhooks.create({ name: "n", url: "https://example.invalid/hook", events: ["document.new"] } as never),
  "webhooks.get": (c) => c.webhooks.get("w"),
  "webhooks.update": (c) => c.webhooks.update("w", { name: "m" } as never),
  "webhooks.delete": (c) => c.webhooks.delete("w"),
  "webhooks.test": (c) => c.webhooks.test("w"),
  "webhooks.deliveries": (c) => c.webhooks.deliveries("w"),
  "webhooks.paginateDeliveries": (c) => drain(c.webhooks.paginateDeliveries("w", { limit: 2 })),
};

/** Drain an async iterable, at most 30 items (a hostile server may invent new items for ever). */
async function drain(it: AsyncIterable<unknown>): Promise<number> {
  let n = 0;
  for await (const _ of it) if (++n >= 30) break;
  return n;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hostile answers", () => {
  it("covers every public method", () => {
    const own = (proto: object) =>
      Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor" && n !== "toJSON" && n !== "call" && !n.startsWith("_"));
    const expected = [...own(LexAPI.prototype), ...own(WebhooksAPI.prototype).map((n) => `webhooks.${n}`)].sort();
    expect(Object.keys(CALLS).sort()).toEqual(expected);
  });

  it.each([
    ["default retry policy", {}],
    ["unbounded maxDelayMs", { maxDelayMs: Infinity, baseDelayMs: 1e12 }],
  ] as Array<[string, RetryOptions]>)("only SDK errors escape and every wait is a valid timer delay (%s)", async (_label, retry) => {
    const real = globalThis.setTimeout;
    const waits: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === ATTEMPT_TIMEOUT_MS) return real(fn, ms);
      waits.push(ms as number);
      return real(fn, 0);
    }) as typeof setTimeout);

    const escaped: string[] = [];
    const rounds = Number(process.env["FUZZ_ROUNDS"] ?? 20);
    for (const [name, call] of Object.entries(CALLS)) {
      for (let round = 0; round < rounds; round++) {
        const seed = round * 7919 + name.length * 104729 + name.charCodeAt(0);
        const rand = prng(seed);
        const fetchFn = vi.fn(async (url: string | URL | Request) => {
          if (!String(url).startsWith("http://127.0.0.1:")) throw new Error("refused a request off loopback");
          return hostileReply(rand);
        });
        const client = new LexAPI({ apiKey: "lex_test_key", baseUrl: BASE, fetch: fetchFn, timeoutMs: ATTEMPT_TIMEOUT_MS, retry });
        try {
          await call(client);
        } catch (e) {
          if (!(e instanceof LexAPIError)) escaped.push(`${name} seed ${seed}: ${(e as Error)?.constructor?.name}: ${String((e as Error)?.message).slice(0, 120)}`);
        }
      }
    }
    expect(escaped).toEqual([]);
    const bad = waits.filter((ms) => !(typeof ms === "number" && ms >= 0 && ms <= MAX_TIMER_MS));
    expect(bad).toEqual([]);
    expect(waits.length).toBeGreaterThan(0);
  }, 120_000);
});
