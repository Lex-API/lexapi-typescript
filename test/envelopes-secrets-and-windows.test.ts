// SDK contract §1.2, §1.8 and §1.9: later `_meta` lines, the nested envelope,
// the truncated header, the wait on errors off a 429, secrets that cannot be
// encoded, the timestamp years and the window edge, and the window setting.
// Loopback stubs only.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LexAPI,
  LexAPIError,
  RateLimitedError,
  WebhookSignatureError,
  computeSignature,
  verifySignature,
  verifyWebhook,
} from "../src/index.js";

const BASE = "http://127.0.0.1:9/api/v1";
const enc = new TextEncoder();

afterEach(() => {
  vi.restoreAllMocks();
});

// ── export ──────────────────────────────────────────────────────────────

function exportOf(text: string, headers: Record<string, string> = {}) {
  const fetchFn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    expect(String(input).startsWith("http://127.0.0.1:9/")).toBe(true);
    return new Response(enc.encode(text), { status: 200, headers: { "content-type": "application/x-ndjson", ...headers } });
  });
  return new LexAPI({ apiKey: "lex_test_key", baseUrl: BASE, fetch: fetchFn, retry: { maxRetries: 0 } }).export();
}

async function readAll(text: string, headers?: Record<string, string>) {
  const stream = await exportOf(text, headers);
  const before = stream.truncated;
  const rows: unknown[] = [];
  let error: unknown;
  try {
    for await (const row of stream) rows.push(row);
  } catch (e) {
    error = e;
  }
  return { stream, rows, error, before };
}

describe("export: a later line with _meta is skipped, whatever else it carries", () => {
  it.each([
    ["a _done key", '{"_meta":{"total":9},"_done":{"written":0}}'],
    ["a flat _done key", '{"_meta":true,"_done":true}'],
    ["an _error key", '{"_meta":{},"_error":{"code":"X"}}'],
  ])("with %s, after the first line", async (_label, line) => {
    const { stream, rows, error } = await readAll(`{"_meta":{"total":1}}\n{"a":1}\n${line}\n{"b":2}\n{"_done":{"written":2}}\n`);
    expect(error).toBeUndefined();
    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
    expect(stream.done?.written).toBe(2);
    expect(stream.meta).toMatchObject({ total: 1 });
    expect(stream.invalidLines).toBe(0);
    expect(stream.complete).toBe(true);
  });

  it("with a _done key and no other trailer: the stream has no trailer", async () => {
    const { stream, rows, error } = await readAll('{"_meta":{}}\n{"a":1}\n{"_meta":{},"_done":{"written":1}}\n');
    expect(rows).toEqual([{ a: 1 }]);
    expect(error).toBeInstanceOf(LexAPIError);
    expect(stream.done).toBeUndefined();
    expect(stream.complete).toBe(false);
  });

  it("with a _done key after a blank first line: skipped, not a trailer", async () => {
    const { stream, rows, error } = await readAll('\n{"_meta":{"total":1},"_done":{"written":0}}\n{"a":1}\n{"_done":{"written":1}}\n');
    expect(error).toBeUndefined();
    expect(stream.meta).toBeUndefined();
    expect(rows).toEqual([{ a: 1 }]);
    expect(stream.done?.written).toBe(1);
  });

  it("as the very first line with a _done key: it is the _meta line", async () => {
    const { stream, rows } = await readAll('{"_meta":{"total":1},"_done":{"written":0}}\n{"a":1}\n{"_done":{"written":1}}\n');
    expect(stream.meta).toMatchObject({ total: 1 });
    expect(rows).toEqual([{ a: 1 }]);
    expect(stream.done?.written).toBe(1);
  });
});

describe("export: the nested object is the envelope", () => {
  it("keys beside _done are not read", async () => {
    const { stream, error } = await readAll('{"_meta":{}}\n{"_done":{"written":0},"complete":false,"truncated":true}\n');
    expect(error).toBeUndefined();
    expect(stream.complete).toBe(true);
    expect(stream.truncated).toBe(false);
    expect(stream.done?.written).toBe(0);
    expect((stream.done as Record<string, unknown>)["complete"]).toBeUndefined();
  });

  it("keys beside _done do not replace the nested ones", async () => {
    const { stream, error } = await readAll('{"_meta":{}}\n{"_done":{"complete":false,"truncated":true},"complete":true,"truncated":false}\n');
    expect(error).toBeInstanceOf(LexAPIError);
    expect(stream.complete).toBe(false);
    expect(stream.truncated).toBe(true);
  });

  it("keys beside _meta are not read", async () => {
    const { stream, before } = await readAll('{"_meta":{"total":1},"truncated":true,"total":9}\n{"_done":{}}\n');
    expect(before).toBe(false);
    expect(stream.meta).toMatchObject({ total: 1 });
    expect((stream.meta as Record<string, unknown>)["truncated"]).toBeUndefined();
  });

  it("the nested object stays available under its key", async () => {
    const { stream } = await readAll('{"_meta":{"total":1}}\n{"_done":{"written":0}}\n');
    expect(stream.meta?.["_meta"]).toEqual({ total: 1 });
    expect((stream.done as Record<string, unknown>)["_done"]).toEqual({ written: 0 });
  });

  it("the flat _meta form is still read from the line", async () => {
    const { stream, before } = await readAll('{"_meta":true,"total":3,"truncated":true}\n{"_done":{}}\n');
    expect(stream.meta).toMatchObject({ total: 3 });
    expect(before).toBe(true);
  });
});

describe("export: X-Export-Truncated is 1 or 0, anything else is absent", () => {
  it.each(["true", "false", "", "01", "2", "yes", "1.0", "-0", " 1x"])("%j leaves the decision to _meta.truncated", async (value) => {
    const yes = await exportOf('{"_meta":{"truncated":true}}\n', { "x-export-truncated": value });
    expect(yes.truncated).toBe(true);
    expect(yes.headers.truncated).toBeUndefined();
    const no = await exportOf('{"_meta":{"truncated":false}}\n', { "x-export-truncated": value });
    expect(no.truncated).toBe(false);
  });

  it("1 and 0 decide before _meta", async () => {
    expect((await exportOf('{"_meta":{"truncated":false}}\n', { "x-export-truncated": "1" })).truncated).toBe(true);
    expect((await exportOf('{"_meta":{"truncated":true}}\n', { "x-export-truncated": "0" })).truncated).toBe(false);
    expect((await exportOf('{"_meta":{}}\n', { "x-export-truncated": " 1 " })).headers.truncated).toBe(true);
  });
});

// ── QUOTA_EXHAUSTED off a 429 ───────────────────────────────────────────

describe("QUOTA_EXHAUSTED off a 429 keeps its wait", () => {
  function api(status: number, body: unknown, headers: Record<string, string>) {
    const waits: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms !== 12_345) waits.push(ms as number);
      return real(fn, 0);
    }) as typeof setTimeout);
    let call = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      expect(String(input).startsWith("http://127.0.0.1:9/")).toBe(true);
      return call++ === 0
        ? new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-lexapi-version": "2.29.0", ...headers } })
        : new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new LexAPI({ apiKey: "k", baseUrl: BASE, fetch: fetchFn, timeoutMs: 12_345, retry: { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 60_000 } });
    return { client, fetchFn, waits };
  }

  it.each([
    ["top-level", { code: "QUOTA_EXHAUSTED", error: "q", resetsAt: "2026-12-01T00:00:00Z" }],
    ["typed", { success: false, error: { code: "QUOTA_EXHAUSTED", message: "q" } }],
  ])("a 503 with the %s code and Retry-After 7 waits 7 s and exposes it", async (_label, body) => {
    const { client, fetchFn, waits } = api(503, body, { "retry-after": "7" });
    await client.getInfo();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([7_000]);
    const error = LexAPIError.fromResponse(503, body, 7) as RateLimitedError;
    expect(error.retryAfter).toBe(7);
    expect(error.code).toBe("QUOTA_EXHAUSTED");
  });

  it("a 402 with the code keeps its Retry-After value", () => {
    const error = LexAPIError.fromResponse(402, { code: "QUOTA_EXHAUSTED", error: "q" }, 7);
    expect(error.retryAfter).toBe(7);
  });

  it("a quota 429 still has no retry-after value", () => {
    const error = LexAPIError.fromResponse(429, { code: "QUOTA_EXHAUSTED", error: "q" }, 7) as RateLimitedError;
    expect(error.retryAfter).toBeUndefined();
    expect(error.quotaExhausted).toBe(true);
  });
});

// ── webhooks ────────────────────────────────────────────────────────────

const SECRET = "whsec_test";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const reason = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof WebhookSignatureError ? e.reason : e),
  );
const event = (timestamp: unknown) => JSON.stringify({ event: "webhook.test", timestamp, data: {} });

describe("webhooks: a secret that cannot be encoded as UTF-8", () => {
  it.each(["\ud800", "abc\udc00", "\udc00\ud800", "x\ud83d"])("%j raises missing_secret in every helper", async (secret) => {
    const body = event("2026-11-19T12:00:00Z");
    const repaired = createHmac("sha256", enc.encode(secret)).update(body).digest("hex");
    expect(await reason(computeSignature(body, secret))).toBe("missing_secret");
    expect(await reason(verifySignature(body, repaired, secret))).toBe("missing_secret");
    expect(await reason(verifyWebhook(body, repaired, secret, { toleranceMs: 0 }))).toBe("missing_secret");
  });

  it("a secret with a surrogate pair is used as is", async () => {
    const secret = "k𝄞";
    const body = event("2026-11-19T12:00:00Z");
    expect(await computeSignature(body, secret)).toBe(sign(body, secret));
  });
});

describe("webhooks: timestamp years and the window edge", () => {
  const T = Date.UTC(2026, 10, 19, 12, 0, 0);

  it("year 0000 fails the replay check; 0001 and 9999 are read", async () => {
    const zero = event("0000-01-01T00:00:00Z");
    const near0 = new Date(0);
    near0.setUTCFullYear(0, 0, 1);
    expect(await reason(verifyWebhook(zero, sign(zero), SECRET, { now: near0.getTime() }))).toBe("stale_timestamp");
    for (const [ts, y] of [["0001-01-01T00:00:00Z", 1], ["9999-12-31T23:59:59Z", 9999]] as const) {
      const at = new Date(0);
      at.setUTCFullYear(y, y === 1 ? 0 : 11, y === 1 ? 1 : 31);
      at.setUTCHours(y === 1 ? 0 : 23, y === 1 ? 0 : 59, y === 1 ? 0 : 59, 0);
      const body = event(ts);
      expect(await reason(verifyWebhook(body, sign(body), SECRET, { now: at.getTime() })), ts).toBe("ok");
    }
  });

  it("the edge of the window is exact: at the edge passes, one microsecond past fails", async () => {
    // now = T + 300000 ms; window 300000 ms.
    const cases: Array<[string, string]> = [
      ["2026-11-19T12:00:00Z", "ok"],
      ["2026-11-19T12:00:00.000000Z", "ok"],
      ["2026-11-19T11:59:59.999999Z", "stale_timestamp"],
      ["2026-11-19T11:59:59.9999999Z", "stale_timestamp"], // extra digits are cut, not rounded
      ["2026-11-19T12:00:00.000001Z", "ok"],
    ];
    for (const [ts, want] of cases) {
      const body = event(ts);
      expect(await reason(verifyWebhook(body, sign(body), SECRET, { now: T + 300_000 })), ts).toBe(want);
    }
    // And from the other side: the timestamp ahead of now.
    const ahead = event("2026-11-19T12:05:00.000001Z");
    expect(await reason(verifyWebhook(ahead, sign(ahead), SECRET, { now: T }))).toBe("stale_timestamp");
    const edge = event("2026-11-19T12:05:00Z");
    expect(await reason(verifyWebhook(edge, sign(edge), SECRET, { now: T }))).toBe("ok");
  });

  it("a fractional now and window are compared exactly in microseconds", async () => {
    const body = event("2026-11-19T12:00:00.000500Z");
    expect(await reason(verifyWebhook(body, sign(body), SECRET, { now: T + 1000.5, toleranceMs: 1000 }))).toBe("ok");
    expect(await reason(verifyWebhook(body, sign(body), SECRET, { now: T + 1000.501, toleranceMs: 1000 }))).toBe("stale_timestamp");
  });
});

describe("webhooks: the window setting", () => {
  const body = event("2026-11-19T12:00:00Z");
  const T = Date.UTC(2026, 10, 19, 12, 0, 0);

  it("NaN is a RangeError, raised before any check of the delivery", async () => {
    for (const sig of [sign(body), "", "0".repeat(64)]) {
      await expect(verifyWebhook(body, sig, SECRET, { toleranceMs: Number.NaN, now: T })).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("an empty secret is still reported first", async () => {
    expect(await reason(verifyWebhook(body, sign(body), "", { toleranceMs: Number.NaN }))).toBe("missing_secret");
  });

  it.each([-1, -0.001, -Infinity])("%d makes every delivery stale", async (toleranceMs) => {
    expect(await reason(verifyWebhook(body, sign(body), SECRET, { toleranceMs, now: T }))).toBe("stale_timestamp");
  });

  it("0 disables the check; Infinity accepts any well-formed timestamp", async () => {
    expect(await reason(verifyWebhook(body, sign(body), SECRET, { toleranceMs: 0, now: 0 }))).toBe("ok");
    expect(await reason(verifyWebhook(body, sign(body), SECRET, { toleranceMs: Infinity, now: 0 }))).toBe("ok");
    const bad = event("2026-11-19T12:00:00z");
    expect(await reason(verifyWebhook(bad, sign(bad), SECRET, { toleranceMs: Infinity, now: T }))).toBe("stale_timestamp");
  });
});
