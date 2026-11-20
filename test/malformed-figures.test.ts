// A malformed or absurd server answer never makes the SDK throw a raw error,
// retry in a tight loop, hang or loop for ever: it throws one of the SDK's
// error classes, or the value reads as absent. Well-formed values read as before.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IncompleteExportError,
  LexAPI,
  LexAPIError,
  RateLimitedError,
  getCreditUsage,
  type RetryOptions,
} from "../src/index.js";

const BASE = "http://127.0.0.1:9/api/v1";
/** Valid JSON text for a number beyond double range: `JSON.parse` reads it as `Infinity`. */
const HUGE = "1" + "0".repeat(400);
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The per-attempt timeout used here, so retry waits can be told apart from it. */
const ATTEMPT_TIMEOUT_MS = 12_345;

type Reply = { status: number; body: string; headers?: Record<string, string> };

function stub(replies: Reply[]) {
  let call = 0;
  return vi.fn(async (url: string | URL | Request): Promise<Response> => {
    expect(String(url).startsWith("http://127.0.0.1:")).toBe(true);
    const r = replies[Math.min(call++, replies.length - 1)]!;
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  });
}

/** Every `setTimeout` delay other than the attempt timeout (the retry waits); run at once. */
function recordWaits(): number[] {
  const waits: number[] = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === ATTEMPT_TIMEOUT_MS) return real(fn, ms);
    waits.push(ms as number);
    return real(fn, 0);
  }) as typeof setTimeout);
  return waits;
}

function client(fetchFn: typeof fetch, retry: RetryOptions = {}) {
  return new LexAPI({ apiKey: "lex_test_key", baseUrl: BASE, fetch: fetchFn, timeoutMs: ATTEMPT_TIMEOUT_MS, retry });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const OK: Reply = { status: 200, body: JSON.stringify({ success: true, service: "LexAPI" }) };
const APP = { "x-lexapi-version": "2.29.0", "ratelimit-limit": "60" };
const limited = (body: string, headers: Record<string, string> = {}): Reply => ({
  status: 429,
  body,
  headers: { ...APP, ...headers },
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. numbers beyond double range ──────────────────────────────────────

describe("numbers beyond double range", () => {
  it("a 2xx body with 1e999 or a 400-digit number is still read (the runtime reads it as Infinity)", async () => {
    const body = `{"success":true,"results":[{"law_id":"32016R0679","score":1e999},{"law_id":"x","score":${HUGE}}]}`;
    const res = await client(stub([{ status: 200, body }])).semanticLegislationSearch({ query: "erasure" });
    expect(res.results[0]!.score).toBe(Infinity);
    expect(res.results[1]!.score).toBe(Infinity);
  });

  it("getCreditUsage reads non-finite or non-number figures as absent", () => {
    const usage = getCreditUsage({
      credits: { operation_weight: Infinity, remaining: -Infinity },
      usage: { remaining: Infinity },
    } as never);
    expect(usage.unitsCharged).toBe(0);
    expect(usage.creditsRemaining).toBeUndefined();
    const typed = getCreditUsage({ credits: { operation_weight: "5", remaining: "7" }, usage: { remaining: 3 } } as never);
    expect(typed.unitsCharged).toBe(0);
    expect(typed.creditsRemaining).toBe(3);
  });

  it("getCreditUsage reads well-formed figures as before", () => {
    const usage = getCreditUsage({ credits: { operation_weight: 4, remaining: 120 }, usage: { remaining: 9 } } as never);
    expect(usage).toEqual({ unitsCharged: 4, creditsRemaining: 120, resetsAt: undefined });
    expect(getCreditUsage({ usage: { remaining: 0 } } as never).creditsRemaining).toBe(0);
  });

  it("an integer header beyond double range reads as absent", async () => {
    const res = await client(
      stub([{ ...OK, headers: { "ratelimit-remaining": HUGE, "ratelimit-limit": "60", "x-cache-age": "9".repeat(400) } }]),
    ).getInfo();
    expect(res.headers?.rateLimit).toEqual({ limit: 60 });
    expect(res.headers?.cacheAge).toBeUndefined();
  });

  it("error figures beyond double range read as absent", async () => {
    const body = `{"success":false,"error":{"code":"CREDITS_EXHAUSTED","message":"x","details":{"weight":1e999,"available":5}}}`;
    const e = (await caught(client(stub([{ status: 402, body }])).getInfo())) as { weight: unknown; available: unknown };
    expect(e.weight).toBeUndefined();
    expect(e.available).toBe(5);
  });

  it.each(["1e999", HUGE, "abc", "", "-3", "1.5"])("X-Export-Total %j reads as absent", async (value) => {
    const ndjson = '{"_meta":{"total":1}}\n{"_done":{"complete":true}}\n';
    const fetchFn = vi.fn(async () =>
      new Response(ndjson, { status: 200, headers: { "x-export-total": value, "x-export-streaming": value } }),
    );
    const stream = await client(fetchFn).export();
    expect(stream.headers.total).toBeUndefined();
    expect(stream.headers.streaming).toBeUndefined();
    await stream.cancel();
  });

  it("X-Export-Total with a count reads as before", async () => {
    const ndjson = '{"_meta":{"total":1}}\n{"_done":{"complete":true}}\n';
    const fetchFn = vi.fn(async () =>
      new Response(ndjson, { status: 200, headers: { "x-export-total": "12", "x-export-streaming": "0" } }),
    );
    const stream = await client(fetchFn).export();
    expect(stream.headers.total).toBe(12);
    expect(stream.headers.streaming).toBe(0);
    await stream.cancel();
  });
});

// ── 2. retryAfter in the body ───────────────────────────────────────────

const top = (v: string) => `{"error":"Too many requests","code":"RATE_LIMITED","retryAfter":${v}}`;
const nested = (v: string) =>
  `{"success":false,"error":{"code":"RATE_LIMITED","message":"Too many requests","details":{"retryAfter":${v}}}}`;
const NATIONAL_503 = (v: string) =>
  `{"error":"Index unavailable","code":"NATIONAL_SEMANTIC_UNAVAILABLE","jurisdiction":"AT","partialReason":"SEARCH_INCOMPLETE","retryAfter":${v}}`;

describe("retryAfter in the body", () => {
  it.each([
    ["top-level", top],
    ["error.details", nested],
  ])("%s: negative, non-numeric or non-finite reads as absent", async (_where, shape) => {
    for (const v of ["-5", "-0.5", "1e999", `-${HUGE}`, '"5"', '"inf"', "null", "true", "[3]", '{"s":3}']) {
      const e = (await caught(client(stub([limited(shape(v))]), { maxRetries: 0 }).getInfo())) as RateLimitedError;
      expect(e).toBeInstanceOf(RateLimitedError);
      expect(e.retryAfter, v).toBeUndefined();
    }
  });

  it("an absent hint retries with the normal back-off", async () => {
    const waits = recordWaits();
    const fetchFn = stub([limited(top("-5")), OK]);
    const res = await client(fetchFn, { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 1_000 }).getInfo();
    expect(res.service).toBe("LexAPI");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(0);
    expect(waits[0]).toBeLessThan(100);
  });

  it("on a national 503 a negative retryAfter reads as absent, so the incomplete search is not retried", async () => {
    const fetchFn = stub([{ status: 503, body: NATIONAL_503("-5"), headers: APP }]);
    const e = (await caught(client(fetchFn).nationalSemanticSearch("AT", { query: "Datenschutz" }))) as LexAPIError;
    expect(e.code).toBe("NATIONAL_SEMANTIC_UNAVAILABLE");
    expect(e.retryAfter).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a finite but huge retryAfter waits the maximum, never longer", async () => {
    const waits = recordWaits();
    const fetchFn = stub([limited(top("1e300")), OK]);
    await client(fetchFn, { maxRetries: 1 }).getInfo();
    expect(waits).toEqual([30_000]);
  });

  it("a huge wait never reaches a timer above 2^31-1 ms, even with an unbounded maxDelayMs", async () => {
    const waits = recordWaits();
    const fetchFn = stub([limited(top("1e300")), limited(top("999999999")), OK]);
    await client(fetchFn, { maxRetries: 2, maxDelayMs: Infinity }).getInfo();
    expect(waits).toEqual([MAX_TIMER_MS, MAX_TIMER_MS]);
  });

  it("well-formed retryAfter values read as before", async () => {
    for (const [v, want] of [["7", 7], ["2.5", 2.5], ["0", 0]] as const) {
      const e = (await caught(client(stub([limited(nested(v))]), { maxRetries: 0 }).getInfo())) as RateLimitedError;
      expect(e.retryAfter).toBe(want);
    }
  });
});

// ── 3. Retry-After / RateLimit-Reset headers ────────────────────────────

const BAD_HEADER_VALUES = [
  "nan", "NaN", "inf", "-inf", "Infinity", "-3", "-0", "1e999", "1e3", "0x10", "junk", "junk 1", "x 5",
  "hello world 99", "", "   ", "9".repeat(400), "Mon, 99 Foo 2020 00:00:00 GMT",
];

describe("Retry-After and RateLimit-Reset headers", () => {
  it.each(["retry-after", "ratelimit-reset"])("%s: unusable values read as absent (maxRetries: 0)", async (name) => {
    for (const v of BAD_HEADER_VALUES) {
      const e = (await caught(
        client(stub([limited('{"error":"Too many requests"}', { [name]: v })]), { maxRetries: 0 }).getInfo(),
      )) as RateLimitedError;
      expect(e).toBeInstanceOf(RateLimitedError);
      expect(e.retryAfter, JSON.stringify(v)).toBeUndefined();
    }
  });

  it.each(["retry-after", "ratelimit-reset"])("%s: an unusable value retries with the normal back-off", async (name) => {
    for (const v of ["nan", "inf", "-3", "1e999", "junk 1", "9".repeat(400)]) {
      const waits = recordWaits();
      const fetchFn = stub([limited('{"error":"Too many requests"}', { [name]: v }), OK]);
      await client(fetchFn, { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 1_000 }).getInfo();
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThanOrEqual(0);
      expect(waits[0], v).toBeLessThan(100);
      vi.restoreAllMocks();
    }
  });

  it("an HTTP-date far in the future waits the maximum; err.retryAfter keeps the delta", async () => {
    const waits = recordWaits();
    const far = "Fri, 31 Dec 9999 23:59:59 GMT";
    const fetchFn = stub([limited('{"error":"x"}', { "retry-after": far }), OK]);
    await client(fetchFn, { maxRetries: 1 }).getInfo();
    expect(waits).toEqual([30_000]);
    const e = (await caught(
      client(stub([limited('{"error":"x"}', { "retry-after": far })]), { maxRetries: 0 }).getInfo(),
    )) as RateLimitedError;
    expect(e.retryAfter).toBeGreaterThan(2 ** 31);
    expect(Number.isFinite(e.retryAfter)).toBe(true);
  });

  it("an HTTP-date in the past is a wait of 0", async () => {
    const e = (await caught(
      client(stub([limited('{"error":"x"}', { "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" })]), { maxRetries: 0 }).getInfo(),
    )) as RateLimitedError;
    expect(e.retryAfter).toBe(0);
  });

  it("the three HTTP-date forms read as the same UTC instant", async () => {
    const at = Math.floor(Date.now() / 1000) * 1000 + 20_000;
    const d = new Date(at);
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const p = (n: number) => String(n).padStart(2, "0");
    const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    const day = days[d.getUTCDay()]!;
    const mon = months[d.getUTCMonth()]!;
    const forms = [
      d.toUTCString(),
      `${day}, ${p(d.getUTCDate())}-${mon}-${p(d.getUTCFullYear() % 100)} ${time} GMT`,
      `${day.slice(0, 3)} ${mon} ${String(d.getUTCDate()).padStart(2, " ")} ${time} ${d.getUTCFullYear()}`,
    ];
    for (const form of forms) {
      const e = (await caught(
        client(stub([limited('{"error":"x"}', { "retry-after": form })]), { maxRetries: 0 }).getInfo(),
      )) as RateLimitedError;
      expect(e.retryAfter, form).toBeGreaterThanOrEqual(18);
      expect(e.retryAfter, form).toBeLessThanOrEqual(21);
    }
  });

  it("well-formed header values read as before", async () => {
    for (const [name, v, want] of [
      ["retry-after", "12", 12],
      ["retry-after", "0", 0],
      ["retry-after", " 4 ", 4],
      ["ratelimit-reset", "4", 4],
      ["ratelimit-reset", "2.5", 2.5],
    ] as const) {
      const e = (await caught(
        client(stub([limited('{"error":"x"}', { [name]: v })]), { maxRetries: 0 }).getInfo(),
      )) as RateLimitedError;
      expect(e.retryAfter, `${name}: ${v}`).toBe(want);
    }
  });

  it("a header that reads as absent falls back to the body retryAfter", async () => {
    const e = (await caught(
      client(stub([limited(top("6"), { "retry-after": "junk 1" })]), { maxRetries: 0 }).getInfo(),
    )) as RateLimitedError;
    expect(e.retryAfter).toBe(6);
  });
});

// ── 4. export lines ─────────────────────────────────────────────────────

describe("export lines", () => {
  it("a line nested 100,000 levels deep is counted as an invalid line", async () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    const ndjson = ['{"_meta":{"total":1}}', deep, '{"celex":"32016R0679"}', '{"_done":{"complete":true}}'].join("\n");
    const fetchFn = vi.fn(async () => new Response(ndjson + "\n", { status: 200 }));
    const stream = await client(fetchFn).export();
    const rows = [];
    for await (const row of stream) rows.push(row);
    expect(rows).toEqual([{ celex: "32016R0679" }]);
    expect(stream.invalidLines).toBe(1);
  });
});

// ── 5. iterators: see pagination-stops.test.ts ─────────────────────────

/** Collect at most `max` pages, so a looping iterator fails instead of hanging. */
async function collect<T>(it: AsyncIterable<T>, max = 20): Promise<T[]> {
  const out: T[] = [];
  for await (const page of it) {
    out.push(page);
    if (out.length >= max) break;
  }
  return out;
}

describe("deeply nested values the SDK turns into text", () => {
  const deep = "[".repeat(100_000) + "1" + "]".repeat(100_000);

  it.each([
    ["an _error line whose value is a deep array", `{"_error":${deep}}`],
    ["an _error line whose code is a deep array", `{"_error":{"code":${deep},"message":"x"}}`],
  ])("export: %s ends the stream with IncompleteExportError", async (_label, line) => {
    const ndjson = ['{"_meta":{"total":1}}', line, '{"_done":{"complete":true}}'].join("\n") + "\n";
    const fetchFn = vi.fn(async () => new Response(ndjson, { status: 200 }));
    const stream = await client(fetchFn).export();
    const e = await caught((async () => {
      for await (const _ of stream) void _;
    })());
    expect(e).toBeInstanceOf(IncompleteExportError);
  });

  it("paginateCitedBy: an edge nested 100,000 levels deep is read without a RangeError", async () => {
    const body = `{"success":true,"targetDocument":"X","limit":2,"offset":0,"citedBy":[{"celexNumber":"A","citations":[${deep}]}]}`;
    const fetchFn = stub([{ status: 200, body }]);
    expect(await collect(client(fetchFn).paginateCitedBy("X", { limit: 2 }))).toHaveLength(1);
  });
});

// ── the hint grammar, piece by piece ────────────────────────────────────

describe("the retry-hint grammar", () => {
  const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
  const at = (y: number, mo: number, d: number, h = 8, mi = 49, s = 37) => Date.UTC(y, mo, d, h, mi, s);

  it.each([
    ["Sun, 06 Nov 1994 08:49:37 GMT", at(1994, 10, 6)],
    ["sun, 06 nov 1994 08:49:37 gmt", at(1994, 10, 6)],
    ["Sun, 06 Nov 1994 08:49:37 UTC", at(1994, 10, 6)],
    ["Sun, 06 Nov 1994 08:49:37 +0000", at(1994, 10, 6)],
    ["Sun Nov  6 08:49:37 1994", at(1994, 10, 6)],
    ["Sun Nov 06 08:49:37 1994", at(1994, 10, 6)],
    ["Wed Feb  1 00:00:00 2028", at(2028, 1, 1, 0, 0, 0)],
    ["Tue, 29 Feb 2028 23:59:59 GMT", at(2028, 1, 29, 23, 59, 59)],
    ...["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(
      (day) => [`${day}, 06-Nov-94 08:49:37 GMT`, at(1994, 10, 6)] as [string, number],
    ),
    // RFC 9110 §5.6.7: a two-digit year more than 50 years ahead is in the past century.
    ["Sunday, 06-Nov-76 08:49:37 GMT", at(2076, 10, 6)],
    ["Sunday, 06-Nov-77 08:49:37 GMT", at(1977, 10, 6)],
    ["Sunday, 06-Nov-26 08:49:37 GMT", at(2026, 10, 6)],
  ])("%j is an HTTP-date", async (text, ms) => {
    const { httpDateMs } = await import("../src/retryHints.js");
    expect(httpDateMs(text, NOW)).toBe(ms);
  });

  it.each([
    "Sun, 06 Nov 1994 08:49:37 GMT x",
    "x Sun, 06 Nov 1994 08:49:37 GMT",
    "Sun, 06 Nov 1994 08:49:37",
    "Sun, 06 Nov 1994 08:49:37 EST",
    "Sun, 06 Nov 1994 08:49:37 CET",
    "Sun, 06 Nov 1994 08:49:37 +0100",
    "Sun, 6 Nov 1994 08:49:37 GMT",
    "Sun, 30 Feb 1994 08:49:37 GMT",
    "Sun, 29 Feb 2027 08:49:37 GMT",
    "Sun, 06 Nov 1994 24:00:00 GMT",
    "Sun, 06 Nov 1994 08:60:00 GMT",
    "Sun, 06 Nov 1994 08:49:60 GMT",
    "Sun, 00 Nov 1994 08:49:37 GMT",
    "Sun, 06-Nov-94 08:49:37 GMT",
    "Sunday, 06 Nov 1994 08:49:37 GMT",
    "Sun Nov 6 08:49:37 1994",
    "Sun Nov  6 08:49:37 1994 GMT",
    "Sun Nov  6 08:49:37 94",
    "Funday, 06-Nov-94 08:49:37 GMT",
  ])("%j is not", async (text) => {
    const { httpDateMs } = await import("../src/retryHints.js");
    expect(httpDateMs(text, NOW)).toBeUndefined();
  });

  it.each(["+5", "-5", ".5", "5.", "1_000", "1e3", "0x10", "5 5", "５"])("RateLimit-Reset %j is absent", async (v) => {
    const e = (await caught(
      client(stub([limited('{"error":"x"}', { "ratelimit-reset": v })]), { maxRetries: 0 }).getInfo(),
    )) as RateLimitedError;
    expect(e.retryAfter).toBeUndefined();
  });

  it("numeric hints are trimmed of spaces and tabs", async () => {
    for (const [name, v] of [["retry-after", "\t7 "], ["ratelimit-reset", " \t7\t"]] as const) {
      const e = (await caught(client(stub([limited('{"error":"x"}', { [name]: v })]), { maxRetries: 0 }).getInfo())) as RateLimitedError;
      expect(e.retryAfter, name).toBe(7);
    }
  });

  it("-0 in the body is a wait of 0; an unusable top-level value falls back to error.details", async () => {
    const zero = (await caught(client(stub([limited(top("-0"))]), { maxRetries: 0 }).getInfo())) as RateLimitedError;
    expect(Object.is(zero.retryAfter, 0)).toBe(true);
    const body = '{"success":false,"retryAfter":-5,"error":{"code":"RATE_LIMITED","message":"x","details":{"retryAfter":4}}}';
    const e = (await caught(client(stub([limited(body)]), { maxRetries: 0 }).getInfo())) as RateLimitedError;
    expect(e.retryAfter).toBe(4);
  });

  it("a legacy 429 with usage.resetsAt and only unusable hints is a quota 429 and is not retried", async () => {
    const body = '{"error":"Daily quota exceeded","retryAfter":"soon","usage":{"resetsAt":"2026-12-01T00:00:00Z"}}';
    const fetchFn = stub([limited(body, { "retry-after": "junk 1" })]);
    const e = (await caught(client(fetchFn, { maxRetries: 2 }).getInfo())) as RateLimitedError;
    expect(e.quotaExhausted).toBe(true);
    expect(e.retryAfter).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a usable hint keeps a legacy 429 a rate limit", async () => {
    const body = '{"error":"Too many requests","usage":{"resetsAt":"2026-12-01T00:00:00Z"}}';
    const e = (await caught(client(stub([limited(body, { "retry-after": "3" })]), { maxRetries: 0 }).getInfo())) as RateLimitedError;
    expect(e.quotaExhausted).toBe(false);
    expect(e.retryAfter).toBe(3);
  });

  it("a national 503 whose only hint is unusable is not retried", async () => {
    const fetchFn = stub([{ status: 503, body: NATIONAL_503('"later"'), headers: { ...APP, "retry-after": "junk 1" } }]);
    const e = (await caught(client(fetchFn, { maxRetries: 2 }).nationalSemanticSearch("AT", { query: "x" }))) as LexAPIError;
    expect(e.retryAfter).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("integer headers", () => {
  it.each(["1e3", "12.5", "0x10", "1_000", "+5", "-5", "", " ", "9007199254740992", "12abc"])("%j reads as absent", async (v) => {
    const res = await client(stub([{ ...OK, headers: { "ratelimit-remaining": v, "x-corpus-version": v } }])).getInfo();
    expect(res.headers?.rateLimit?.remaining).toBeUndefined();
    expect(res.headers?.corpusVersion).toBeUndefined();
  });

  it("digits, trimmed of spaces and tabs, up to 2^53 - 1 read as before", async () => {
    const res = await client(stub([{ ...OK, headers: { "ratelimit-remaining": " 59\t", "x-cache-age": "9007199254740991" } }])).getInfo();
    expect(res.headers?.rateLimit?.remaining).toBe(59);
    expect(res.headers?.cacheAge).toBe(9007199254740991);
  });

  it("an export count header is trimmed", async () => {
    const ndjson = '{"_meta":{"total":1}}\n{"_done":{"complete":true}}\n';
    const fetchFn = vi.fn(async () => new Response(ndjson, { status: 200, headers: { "x-export-total": " 12\t", "x-export-streaming": "\t3" } }));
    const stream = await client(fetchFn).export();
    expect(stream.headers.total).toBe(12);
    expect(stream.headers.streaming).toBe(3);
    await stream.cancel();
  });

  it("getCreditUsage reads a resetsAt that is not a string as absent", () => {
    expect(getCreditUsage({ credits: { resetsAt: 5 }, usage: { resetsAt: "2026-12-01" } } as never).resetsAt).toBe("2026-12-01");
    expect(getCreditUsage({ credits: { resetsAt: {} } } as never).resetsAt).toBeUndefined();
    expect(getCreditUsage({ usage: { resetsAt: null } } as never).resetsAt).toBeNull();
  });
});

describe("timers", () => {
  it("timeoutMs: Infinity sets no attempt timer; a finite value above the timer limit is clamped, not shortened", async () => {
    const real = globalThis.setTimeout;
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms as number);
      return real(fn, 50);
    }) as typeof setTimeout);
    const fetchFn = stub([OK]);
    await new LexAPI({ apiKey: "k", baseUrl: BASE, fetch: fetchFn, timeoutMs: Infinity }).getInfo();
    expect(delays).toEqual([]);
    await new LexAPI({ apiKey: "k", baseUrl: BASE, fetch: stub([OK]), timeoutMs: 3e9 }).getInfo();
    expect(delays.every((d) => d === MAX_TIMER_MS)).toBe(true);
    expect(delays.length).toBeGreaterThan(0);
  });

  it("timeoutMs: 0 times out at once", async () => {
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const e = await caught(new LexAPI({ apiKey: "k", baseUrl: BASE, fetch: fetchFn, timeoutMs: 0, retry: { maxRetries: 0 } }).getInfo());
    expect((e as LexAPIError).code).toBe("REQUEST_TIMEOUT");
  });
});

describe("export _error text", () => {
  it("keeps the value as text, or its kind when it cannot be turned into text", async () => {
    const deep = "[".repeat(100_000) + "1" + "]".repeat(100_000);
    for (const [value, message] of [['"boom"', "boom"], ["[1,2]", "1,2"], [deep, "array"]] as const) {
      const ndjson = ['{"_meta":{"total":1}}', `{"_error":${value}}`, '{"_done":{"complete":true}}'].join("\n") + "\n";
      const stream = await client(vi.fn(async () => new Response(ndjson, { status: 200 }))).export();
      const e = (await caught((async () => {
        for await (const _ of stream) void _;
      })())) as IncompleteExportError;
      expect(e).toBeInstanceOf(IncompleteExportError);
      expect(stream.error).toEqual({ message });
    }
  });
});

describe("verifyWebhook", () => {
  it("a signed body that is JSON null is a malformed_body WebhookSignatureError, not a TypeError", async () => {
    const { computeSignature, verifyWebhook, WebhookSignatureError } = await import("../src/index.js");
    const sig = await computeSignature("null", "whsec");
    const e = await caught(verifyWebhook("null", sig, "whsec"));
    expect(e).toBeInstanceOf(WebhookSignatureError);
    expect((e as { reason: string }).reason).toBe("malformed_body");
  });
});

describe("trimming (a fetch Headers object trims on its own; a custom one may not)", () => {
  it("numeric hints and integer headers drop leading and trailing spaces and tabs only", async () => {
    const { decimalSeconds, retryAfterHeaderSeconds } = await import("../src/retryHints.js");
    const { parseResponseHeaders } = await import("../src/index.js");
    expect(decimalSeconds(" \t7\t ")).toBe(7);
    expect(retryAfterHeaderSeconds("\t7 ")).toBe(7);
    expect(decimalSeconds("\n7")).toBeUndefined();
    const raw: Record<string, string> = { "ratelimit-remaining": " 59\t", "x-cache-age": "\n5" };
    const headers = parseResponseHeaders({ get: (name: string) => raw[name] ?? null });
    expect(headers.rateLimit?.remaining).toBe(59);
    expect(headers.cacheAge).toBeUndefined();
  });
});

describe("the retry-hint grammar, boundaries", () => {
  const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

  it("RFC 850 years follow RFC 9110 per timestamp: up to 50 years ahead stays, a second more is the past century", async () => {
    const { httpDateMs } = await import("../src/retryHints.js");
    expect(httpDateMs("Thursday, 19-Nov-76 12:00:00 GMT", NOW)).toBe(Date.UTC(2076, 10, 19, 12, 0, 0));
    expect(httpDateMs("Thursday, 19-Nov-76 12:00:01 GMT", NOW)).toBe(Date.UTC(1976, 10, 19, 12, 0, 1));
    expect(httpDateMs("Tuesday, 29-Feb-00 00:00:00 GMT", NOW)).toBe(Date.UTC(2000, 1, 29));
    const late = Date.UTC(2099, 0, 1);
    expect(httpDateMs("Sunday, 01-Jan-01 00:00:00 GMT", late)).toBe(Date.UTC(2101, 0, 1));
  });

  it("the Gregorian century rule: 29 Feb 2100 is not a date, 29 Feb 2000 is", async () => {
    const { httpDateMs } = await import("../src/retryHints.js");
    expect(httpDateMs("Mon, 29 Feb 2100 00:00:00 GMT", NOW)).toBeUndefined();
    expect(httpDateMs("Tue, 29 Feb 2000 00:00:00 GMT", NOW)).toBe(Date.UTC(2000, 1, 29));
  });

  it.each(["Z", "z", "GMT+0", "UT", "-0000", "+00:00"])("zone %j is not accepted", async (zone) => {
    const { httpDateMs } = await import("../src/retryHints.js");
    expect(httpDateMs(`Sun, 06 Nov 1994 08:49:37 ${zone}`, NOW)).toBeUndefined();
  });

  it("the epoch thresholds: up to 1e9 is seconds, above is epoch seconds, above 1e12 epoch milliseconds", async () => {
    const { normalizeRetryAfterSeconds } = await import("../src/retryHints.js");
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(normalizeRetryAfterSeconds(1e9)).toBe(1e9);
    expect(normalizeRetryAfterSeconds(1e9 + 1)).toBe(0); // 2001, in the past
    expect(normalizeRetryAfterSeconds(NOW / 1000 + 30)).toBe(30);
    expect(normalizeRetryAfterSeconds(1e12)).toBe(1e12 - NOW / 1000);
    expect(normalizeRetryAfterSeconds(1e12 + 1)).toBe(0); // 2001 in milliseconds
    expect(normalizeRetryAfterSeconds(NOW + 30_000)).toBe(30);
  });

  it("a wait from a date is rounded to the nearest second, halves up", async () => {
    const { retryAfterHeaderSeconds } = await import("../src/retryHints.js");
    vi.spyOn(Date, "now").mockReturnValue(NOW + 500);
    expect(retryAfterHeaderSeconds("Thu, 19 Nov 2026 12:00:10 GMT")).toBe(10); // 9.5 s → 10
    vi.spyOn(Date, "now").mockReturnValue(NOW + 501);
    expect(retryAfterHeaderSeconds("Thu, 19 Nov 2026 12:00:10 GMT")).toBe(9);
  });

  it("the weekday name is not checked against the date", async () => {
    const { httpDateMs } = await import("../src/retryHints.js");
    expect(httpDateMs("Mon, 06 Nov 1994 08:49:37 GMT", NOW)).toBe(Date.UTC(1994, 10, 6, 8, 49, 37));
  });
});
