/**
 * SDK contract (PLAN.md §1, shared verbatim with lexapi-python) — one test
 * per rule, so a drift between the two SDKs shows up as a named failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InternalServerError,
  LexAPI,
  LexAPIError,
  NetworkError,
  RateLimitedError,
  ServiceUnavailableError,
  TimeoutError,
  UpstreamError,
  computeSignature,
  getCreditUsage,
  normalizeRetryAfterSeconds,
  verifySignature,
} from "../src/index.js";
import { HttpClient, type RequestOptions } from "../src/http.js";
import { fetchSequence, jsonResponse } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const OK = () => jsonResponse(200, { success: true });
const app = (status: number) =>
  jsonResponse(status, { success: false, error: { code: "UPSTREAM_ERROR", message: "app" } }, { "x-lexapi-version": "2.1.0" });
/** App-origin via the rate limiter's RateLimit-Limit header (servers predating X-LexAPI-Version). */
const appRateLimit = (status: number) =>
  jsonResponse(status, { error: "Upstream service error", message: "x" }, { "ratelimit-limit": "60", "ratelimit-remaining": "59" });
/** A JSON error body without either header — NOT enough to count as app-origin. */
const envelopeOnly = (status: number) => jsonResponse(status, { success: false, error: { code: "UPSTREAM_ERROR", message: "x" } });
const proxy = (status: number) => new Response("<html>Bad Gateway</html>", { status, headers: { "content-type": "text/html" } });

function http(fetchFn: typeof fetch, retryReadOnlyPosts = false) {
  return new HttpClient({
    apiKey: "lex_k",
    baseUrl: "https://lex-api.com/api/v1",
    timeoutMs: 60_000,
    fetchFn,
    retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5, retryReadOnlyPosts },
  });
}

type Kind = "billedGet" | "freeGet" | "readOnlyPost" | "mutating";
const CALL: Record<Kind, RequestOptions> = {
  billedGet: { method: "GET", path: "/citations/stats" },
  freeGet: { method: "GET", path: "/info", free: true },
  readOnlyPost: { method: "POST", path: "/search", body: {}, idempotent: true },
  mutating: { method: "POST", path: "/webhooks", body: {} },
};

async function attempts(first: () => Response | Error, kind: Kind, optIn = false): Promise<number> {
  const fetchMock = fetchSequence(first() as Response, OK());
  await http(fetchMock, optIn).requestJson(CALL[kind]).catch(() => undefined);
  return fetchMock.mock.calls.length;
}

describe("§1.2 decision table", () => {
  const row = async (make: () => Response | Error, expected: Record<Kind, number>, optIn = false) => {
    for (const kind of Object.keys(expected) as Kind[]) {
      expect({ kind, n: await attempts(make, kind, optIn) }).toEqual({ kind, n: expected[kind] });
    }
  };

  it("429, not a quota → retry for every call", async () => {
    await row(() => jsonResponse(429, { error: "Rate limit exceeded", retryAfter: 0 }, { "retry-after": "0" }), {
      billedGet: 2, freeGet: 2, readOnlyPost: 2, mutating: 2,
    });
  });

  it("429 reporting an exhausted quota → never", async () => {
    await row(
      () => jsonResponse(429, { error: "Daily quota exceeded", usage: { resetsAt: "2026-10-27T00:00:00Z" } }, { "ratelimit-reset": "1" }),
      { billedGet: 1, freeGet: 1, readOnlyPost: 1, mutating: 1 },
    );
  });

  it("never reached the app (transport, 521/522/523) → retry for every call", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"]) {
      const err = () => Object.assign(new TypeError("fetch failed"), { cause: { code } });
      await row(err, { billedGet: 2, freeGet: 2, readOnlyPost: 2, mutating: 2 });
    }
    for (const status of [521, 522, 523]) {
      await row(() => new Response("cf", { status }), { billedGet: 2, freeGet: 2, readOnlyPost: 2, mutating: 2 });
    }
  });

  it("app-origin 502/503/504 → GETs retry, read-only POST only with the opt-in, mutating never", async () => {
    for (const status of [502, 503, 504]) {
      for (const make of [() => app(status), () => appRateLimit(status)]) {
        await row(make, { billedGet: 2, freeGet: 2, readOnlyPost: 1, mutating: 1 });
        await row(make, { readOnlyPost: 2, mutating: 1 } as Record<Kind, number>, true);
      }
    }
  });

  it("proxy-origin 502/503/504, 520, 524 → only free GETs", async () => {
    for (const status of [502, 503, 504, 520, 524]) {
      await row(() => proxy(status), { billedGet: 1, freeGet: 2, readOnlyPost: 1, mutating: 1 });
      await row(() => proxy(status), { readOnlyPost: 1 } as Record<Kind, number>, true);
    }
  });

  it("a JSON error body without X-LexAPI-Version / RateLimit-Limit is NOT app-origin (treated as proxy)", async () => {
    for (const status of [502, 503, 504]) {
      await row(() => envelopeOnly(status), { billedGet: 1, freeGet: 2, readOnlyPost: 1, mutating: 1 });
      await row(() => envelopeOnly(status), { readOnlyPost: 1 } as Record<Kind, number>, true);
    }
  });

  it("transport errors other than never-reached (reset, closed) → only free GETs", async () => {
    for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"]) {
      const err = () => Object.assign(new TypeError("fetch failed"), { cause: { code } });
      await row(err, { billedGet: 1, freeGet: 2, readOnlyPost: 1, mutating: 1 });
    }
  });

  it("an empty X-LexAPI-Version with a non-JSON body is unknown origin (treated as proxy)", async () => {
    await row(() => new Response("oops", { status: 502, headers: { "x-lexapi-version": " " } }), {
      billedGet: 1, freeGet: 2, readOnlyPost: 1, mutating: 1,
    });
  });

  it("400/401/402/403/404/500 → never", async () => {
    for (const status of [400, 401, 402, 403, 404, 500]) {
      await row(() => jsonResponse(status, { success: false, error: { code: "X", message: "x" } }), {
        billedGet: 1, freeGet: 1, readOnlyPost: 1, mutating: 1,
      });
    }
  });

  it("transport error after the request was sent (read timeout) → only free GETs", async () => {
    const stalled = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
        ),
    );
    const client = (fetchFn: typeof fetch) =>
      new HttpClient({
        apiKey: "k", baseUrl: "https://x", timeoutMs: 10, fetchFn,
        retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, retryReadOnlyPosts: true },
      });
    for (const [kind, n] of [["billedGet", 1], ["freeGet", 2], ["readOnlyPost", 1], ["mutating", 1]] as const) {
      stalled.mockClear();
      const error = await client(stalled as unknown as typeof fetch).requestJson(CALL[kind]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TimeoutError);
      expect((error as TimeoutError).code).toBe("REQUEST_TIMEOUT");
      expect({ kind, n: stalled.mock.calls.length }).toEqual({ kind, n });
    }
  });
});

describe("§1.2 retry waits and retry-after values", () => {
  it("Retry-After applies on any status; RateLimit-Reset and JSON retryAfter only on 429", async () => {
    const parse = async (res: Response) =>
      (await http(fetchSequence(res), false).requestJson({ method: "POST", path: "/x", body: {} }).catch((e: LexAPIError) => e)) as LexAPIError;
    expect((await parse(new Response("", { status: 503, headers: { "retry-after": "7" } }))).retryAfter).toBe(7);
    expect((await parse(new Response("", { status: 503, headers: { "ratelimit-reset": "40" } }))).retryAfter).toBeUndefined();
    expect((await parse(jsonResponse(502, { error: "x", retryAfter: 9 }))).retryAfter).toBeUndefined();
    expect((await parse(jsonResponse(429, { error: "Rate limit exceeded" }, { "ratelimit-reset": "40" }))).retryAfter).toBe(40);
    expect((await parse(jsonResponse(429, { error: "Rate limit exceeded", retryAfter: 12 }))).retryAfter).toBe(12);
  });

  it("X-RateLimit-* is never read", async () => {
    const error = (await http(fetchSequence(jsonResponse(429, { error: "x" }, { "x-ratelimit-reset": "55" })))
      .requestJson({ method: "POST", path: "/x", body: {} })
      .catch((e: LexAPIError) => e)) as LexAPIError;
    // Retried once (maxRetries 1) with backoff, then thrown; no hint taken from X-RateLimit-Reset.
    expect(error.retryAfter).toBeUndefined();
  });

  it("an empty or unparseable Retry-After counts as absent", async () => {
    for (const value of ["", "  ", "soon", "-5"]) {
      const error = (await http(fetchSequence(new Response("", { status: 503, headers: { "retry-after": value } })))
        .requestJson({ method: "POST", path: "/x", body: {} })
        .catch((e: LexAPIError) => e)) as LexAPIError;
      expect({ value, retryAfter: error.retryAfter }).toEqual({ value, retryAfter: undefined });
    }
  });

  it("a quota 429 has a null retry-after even when RateLimit-Reset is present", async () => {
    const error = (await http(
      fetchSequence(jsonResponse(429, { error: "Daily quota exceeded", usage: { resetsAt: "2026-10-27T00:00:00Z" } }, { "ratelimit-reset": "30" })),
    )
      .requestJson({ method: "GET", path: "/info" })
      .catch((e: LexAPIError) => e)) as RateLimitedError;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.quotaExhausted).toBe(true);
    expect(error.retryAfter).toBeUndefined();
    expect(error.resetsAt).toBe("2026-10-27T00:00:00Z");
  });

  it("a 429 with usage.resetsAt AND a Retry-After is not a quota 429", async () => {
    const error = (await http(fetchSequence(jsonResponse(429, { error: "x", usage: { resetsAt: "2026-10-27T00:00:00Z" } }, { "retry-after": "3" })), false)
      .requestJson({ method: "POST", path: "/x", body: {} })
      .catch((e: LexAPIError) => e)) as RateLimitedError;
    expect(error.quotaExhausted).toBe(false);
  });

  it("epoch thresholds: > 1e12 is epoch ms, > 1e9 epoch s, else delta-seconds", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    expect(normalizeRetryAfterSeconds(2_000_000_030_000)).toBe(30);
    expect(normalizeRetryAfterSeconds(2_000_000_040)).toBe(40);
    expect(normalizeRetryAfterSeconds(999_999_999)).toBe(999_999_999);
    expect(normalizeRetryAfterSeconds(1_999_000_000)).toBe(0); // past epoch → floored at 0
  });

  it("every hint is clamped to the 30 s cap", async () => {
    vi.useFakeTimers();
    const fetchMock = fetchSequence(new Response("", { status: 503, headers: { "retry-after": "3600" } }), OK());
    const client = new HttpClient({
      apiKey: "k", baseUrl: "https://x", timeoutMs: 60_000, fetchFn: fetchMock,
      retry: { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 30_000, retryReadOnlyPosts: false },
    });
    const pending = client.requestJson({ method: "GET", path: "/info", free: true });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("§1.3 typed errors", () => {
  const errorFor = async (res: Response) =>
    (await new LexAPI({ apiKey: "k", fetch: fetchSequence(res), retry: { maxRetries: 0 } })
      .getCitationStats()
      .catch((e: unknown) => e)) as LexAPIError;

  it("a legacy string `error` is human text, never a code — the code comes from the status", async () => {
    const error = await errorFor(jsonResponse(400, { error: "NOT_FOUND" }));
    expect(error.code).toBe("INVALID_PARAMS");
    expect(error.message).toContain("NOT_FOUND");
  });

  it("legacy message = error text + ': ' + message when different", async () => {
    const error = await errorFor(jsonResponse(403, { error: "Subscription inactive", message: "Please activate" }));
    expect(error.message).toContain("Subscription inactive: Please activate");
  });

  it("details: error.details on the envelope; top-level details otherwise, even without an error member", async () => {
    expect((await errorFor(jsonResponse(400, { success: false, error: { code: "INVALID_PARAMS", message: "x", details: { a: 1 } } }))).details).toEqual({ a: 1 });
    expect((await errorFor(jsonResponse(400, { error: "Invalid", details: ["q"] }))).details).toEqual(["q"]);
    expect((await errorFor(jsonResponse(400, { message: "bad", details: ["z"] }))).details).toEqual(["z"]);
  });

  it("no usable body → 'HTTP <status>'", async () => {
    expect((await errorFor(new Response("<html/>", { status: 500 }))).message).toContain("HTTP 500");
  });

  it("status → code table", async () => {
    const table: Array<[number, string]> = [
      [400, "INVALID_PARAMS"], [401, "UNAUTHORIZED"], [402, "CREDITS_EXHAUSTED"], [403, "TIER_FORBIDDEN"],
      [404, "NOT_FOUND"], [429, "RATE_LIMITED"], [500, "INTERNAL"], [502, "UPSTREAM_ERROR"], [520, "UPSTREAM_ERROR"],
      [521, "UPSTREAM_ERROR"], [522, "UPSTREAM_ERROR"], [523, "UPSTREAM_ERROR"], [503, "SERVICE_UNAVAILABLE"],
      [504, "TIMEOUT"], [524, "TIMEOUT"], [418, "INTERNAL"], [507, "INTERNAL"],
    ];
    for (const [status, code] of table) {
      expect({ status, code: (await errorFor(new Response("", { status }))).code }).toEqual({ status, code });
    }
    expect(await errorFor(new Response("", { status: 503 }))).toBeInstanceOf(ServiceUnavailableError);
    expect(await errorFor(new Response("", { status: 520 }))).toBeInstanceOf(UpstreamError);
    expect(await errorFor(new Response("", { status: 500 }))).toBeInstanceOf(InternalServerError);
  });

  it("SDK-side transport codes are CONNECTION_ERROR and REQUEST_TIMEOUT", async () => {
    const net = (await new LexAPI({ apiKey: "k", fetch: fetchSequence(new TypeError("boom")), retry: { maxRetries: 0 } })
      .getCitationStats()
      .catch((e: unknown) => e)) as NetworkError;
    expect(net.code).toBe("CONNECTION_ERROR");
    expect(net.status).toBe(0);
  });

  it("a 204 or an empty 2xx body is a successful empty object", async () => {
    for (const res of [new Response(null, { status: 204 }), new Response("", { status: 200 })]) {
      const result = await new LexAPI({ apiKey: "k", fetch: fetchSequence(res) }).getCitationStats();
      expect(typeof result).toBe("object");
    }
  });
});

describe("§1.5 credit visibility", () => {
  it("unitsCharged is 0 for free ops and legacy accounts", () => {
    expect(getCreditUsage({ usage: { remaining: 3 } }).unitsCharged).toBe(0);
    expect(getCreditUsage({ credits: { operation_weight: 4 } }).unitsCharged).toBe(4);
  });
});

describe("§1.9 webhook signatures", () => {
  it("a missing, empty, non-ASCII or non-hex header is a plain failure", async () => {
    const good = await computeSignature("{}", "s");
    expect(await verifySignature("{}", good, "s")).toBe(true);
    for (const bad of [undefined, null, "", "zz", "é".repeat(64), `${good}00`, good.replace(/./, "g")]) {
      expect(await verifySignature("{}", bad, "s")).toBe(false);
    }
  });
});

describe("§1.4 pagination helpers", () => {
  it("cites/cited-by advance by the sum of citationCounts and stop on a short page", async () => {
    const page = (offset: number, counts: number[]) =>
      jsonResponse(200, {
        success: true, targetDocument: "X", totalCitations: 1, limit: 4, offset,
        citedBy: counts.map((c, i) => ({ celexNumber: `D${offset}-${i}`, citationCount: c })),
      });
    const fetchMock = fetchSequence(page(0, [3, 1]), page(4, [2, 2]), page(8, [1]));
    const client = new LexAPI({ apiKey: "k", fetch: fetchMock });
    let pages = 0;
    for await (const _p of client.paginateCitedBy("X", { limit: 4 })) pages++;
    expect(pages).toBe(3);
    const offsets = fetchMock.mock.calls.map((c) => new URL((c as unknown as [string])[0]).searchParams.get("offset"));
    expect(offsets).toEqual(["0", "4", "8"]);
  });

  it("deliveries are yielded at most once (dedupe on id) and the walk stops at total", async () => {
    const page = (offset: number, ids: string[]) =>
      jsonResponse(200, { success: true, total: 4, limit: 2, offset, deliveries: ids.map((id) => ({ id })) });
    // A new delivery arrived between pages: "b" shifts into page 2.
    const fetchMock = fetchSequence(page(0, ["a", "b"]), page(2, ["b", "c"]), page(4, []));
    const client = new LexAPI({ apiKey: "k", fetch: fetchMock });
    const seen: string[] = [];
    for await (const p of client.webhooks.paginateDeliveries("w", { limit: 2 })) seen.push(...p.deliveries.map((d) => d.id!));
    expect(seen).toEqual(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // offset 4 ≥ total 4
  });
});

describe("§1.8 export stream", () => {
  const ndjson = (lines: string[], headers: Record<string, string> = {}) =>
    new Response(lines.join("\n") + "\n", { status: 200, headers: { "content-type": "application/x-ndjson", ...headers } });
  const run = async (res: Response) => {
    const stream = await new LexAPI({ apiKey: "k", fetch: fetchSequence(res) }).export();
    for await (const _r of stream) void _r;
    return stream;
  };
  const META = (extra: Record<string, unknown> = {}) => JSON.stringify({ _meta: { totalMatching: 10, ...extra } });

  it("tolerates the flat {_meta: true} form", async () => {
    const s = await run(ndjson([JSON.stringify({ _meta: true, total: 1 }), JSON.stringify({ celex: "A" }), JSON.stringify({ _done: true })]));
    expect(s.rowsRead).toBe(1);
    expect(s.complete).toBe(true);
  });

  it("truncated: X-Export-Truncated header first", async () => {
    const s = await run(ndjson([META({ truncated: false }), JSON.stringify({ _done: { written: 0, truncated: false } })], { "x-export-truncated": "1" }));
    expect(s.truncated).toBe(true);
  });

  it("truncated: then _meta.truncated", async () => {
    const s = await run(ndjson([META({ truncated: true }), JSON.stringify({ _done: { written: 0, truncated: false } })]));
    expect(s.truncated).toBe(true);
  });

  it("truncated: _done.truncated last, discounted by skippedStubs", async () => {
    const onlyStubs = await run(ndjson([META(), JSON.stringify({ _done: { written: 7, truncated: true, skippedStubs: 3 } })]));
    expect(onlyStubs.truncated).toBe(false); // 7 + 3 = totalMatching 10 → no cap, just skipped stubs
    const realCap = await run(ndjson([META(), JSON.stringify({ _done: { written: 5, truncated: true, skippedStubs: 1 } })]));
    expect(realCap.truncated).toBe(true);
    const plain = await run(ndjson([META(), JSON.stringify({ _done: { written: 5, truncated: true, skippedStubs: 0 } })]));
    expect(plain.truncated).toBe(true);
  });
});

describe("§1.2 never-reached transport codes (round 2 — R5)", () => {
  const billed = async (cause: unknown) => {
    const fetchMock = fetchSequence(Object.assign(new TypeError("fetch failed"), { cause }) as unknown as Response, OK());
    await http(fetchMock).requestJson({ method: "POST", path: "/webhooks", body: {} }).catch(() => undefined);
    return fetchMock.mock.calls.length;
  };

  it("pre-handshake TLS failures are never-reached (retried even on a mutating call)", async () => {
    for (const code of [
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_NOT_YET_VALID", "HOSTNAME_MISMATCH",
      "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
    ]) {
      expect({ code, n: await billed({ code }) }).toEqual({ code, n: 2 });
    }
  });

  it("ETIMEDOUT counts only with syscall 'connect' (incl. an AggregateError of connect attempts)", async () => {
    expect(await billed({ code: "ETIMEDOUT", syscall: "connect" })).toBe(2);
    expect(await billed({ code: "ETIMEDOUT" })).toBe(1); // e.g. a TCP retransmission timeout after send
    expect(await billed({ code: "ETIMEDOUT", syscall: "read" })).toBe(1);
    const happyEyeballs = new AggregateError(
      [Object.assign(new Error("a"), { code: "ETIMEDOUT", syscall: "connect" }), Object.assign(new Error("b"), { code: "ECONNREFUSED" })],
      "connect failed",
    );
    expect(await billed(happyEyeballs)).toBe(2);
    const mixed = new AggregateError([Object.assign(new Error("a"), { code: "ETIMEDOUT", syscall: "connect" }), new Error("other")]);
    expect(await billed(mixed)).toBe(1);
  });

  it("post-handshake TLS errors are not never-reached", async () => {
    expect(await billed({ code: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC" })).toBe(1);
  });
});
