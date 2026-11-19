// SDK contract §1.2, §1.4, §1.8 and §1.9: how export lines end and are
// trimmed, chunk handling, the `_meta` line, `truncated`; the signature header,
// the order of webhook checks and the timestamp form; quota 429s and failed
// payments on any status. Loopback stubs only.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LexAPI,
  LexAPIError,
  NetworkError,
  PaymentPastDueError,
  RateLimitedError,
  WebhookSignatureError,
  verifySignature,
  verifyWebhook,
} from "../src/index.js";

const BASE = "http://127.0.0.1:9/api/v1";
const enc = new TextEncoder();

afterEach(() => {
  vi.restoreAllMocks();
});

// ── export ──────────────────────────────────────────────────────────────

type Source = { body: ReadableStream<unknown>; cancelled: () => boolean };

/** A body that yields the given chunks, as they are (any type). */
function source(chunks: unknown[]): Source {
  let cancelled = false;
  let i = 0;
  const body = new ReadableStream<unknown>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

function exportClient(body: ReadableStream<unknown>, headers: Record<string, string> = {}) {
  const fetchFn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    expect(String(input).startsWith("http://127.0.0.1:9/")).toBe(true);
    return new Response(body as ReadableStream<Uint8Array>, {
      status: 200,
      headers: { "content-type": "application/x-ndjson", ...headers },
    });
  });
  return new LexAPI({ apiKey: "lex_test_key", baseUrl: BASE, fetch: fetchFn, retry: { maxRetries: 0 } });
}

async function readAll(body: ReadableStream<unknown>, headers?: Record<string, string>) {
  const stream = await exportClient(body, headers).export();
  const rows: unknown[] = [];
  let error: unknown;
  try {
    for await (const row of stream) rows.push(row);
  } catch (e) {
    error = e;
  }
  return { rows, error, invalidLines: stream.invalidLines, meta: stream.meta, truncated: stream.truncated, complete: stream.complete };
}

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? Array.from(enc.encode(p)) : p)));

const BOM = [0xef, 0xbb, 0xbf];

/** A transcript with a leading BOM, CRLF endings, 2/3/4-byte characters, a blank line and an invalid line. */
const TRANSCRIPT = bytes(
  BOM,
  '{"_meta":{"total":3}}\r\n',
  '{"celex":"A","t":"é€𝄞"}\r\n',
  " \t\r\n",
  '{"celex":"', [0xff], '"}\n',
  '{"celex":"B","t":"Ωß😀"}\n',
  '{"_done":{"complete":true}}\r\n',
);
const EXPECTED = {
  rows: [{ celex: "A", t: "é€𝄞" }, { celex: "B", t: "Ωß😀" }],
  invalidLines: 1,
  meta: { total: 3 },
};

describe("export: chunk boundaries", () => {
  it("every two-way split of a transcript reads the same", async () => {
    for (let cut = 0; cut <= TRANSCRIPT.length; cut++) {
      const { rows, invalidLines, meta, error } = await readAll(source([TRANSCRIPT.slice(0, cut), TRANSCRIPT.slice(cut)]).body);
      expect(error, `cut ${cut}`).toBeUndefined();
      expect(rows, `cut ${cut}`).toEqual(EXPECTED.rows);
      expect(invalidLines, `cut ${cut}`).toBe(EXPECTED.invalidLines);
      expect(meta, `cut ${cut}`).toMatchObject(EXPECTED.meta);
    }
  });

  it("one byte per chunk reads the same", async () => {
    const { rows, invalidLines, meta } = await readAll(source(Array.from(TRANSCRIPT, (b) => new Uint8Array([b]))).body);
    expect(rows).toEqual(EXPECTED.rows);
    expect(invalidLines).toBe(1);
    expect(meta).toMatchObject(EXPECTED.meta);
  });

  it("every three-way split around the invalid line reads the same", async () => {
    const at = TRANSCRIPT.indexOf(0xff);
    for (let a = at - 12; a <= at + 2; a++) {
      for (let b = a; b <= at + 6; b++) {
        const { rows, invalidLines } = await readAll(source([TRANSCRIPT.slice(0, a), TRANSCRIPT.slice(a, b), TRANSCRIPT.slice(b)]).body);
        expect(rows, `${a}/${b}`).toEqual(EXPECTED.rows);
        expect(invalidLines, `${a}/${b}`).toBe(1);
      }
    }
  });

  it("ArrayBuffer and DataView chunks read like Uint8Array chunks; the body is released", async () => {
    const half = TRANSCRIPT.length >> 1;
    const variants: unknown[][] = [
      [TRANSCRIPT.slice(0, half).buffer, TRANSCRIPT.slice(half).buffer],
      [new DataView(TRANSCRIPT.slice(0, half).buffer), new DataView(TRANSCRIPT.slice(half).buffer)],
      [Buffer.from(TRANSCRIPT.slice(0, half)), Buffer.from(TRANSCRIPT.slice(half))],
      // A view into a larger buffer: only its own bytes count.
      [new Uint8Array([9, 9, ...TRANSCRIPT.slice(0, half), 9]).subarray(2, 2 + half), TRANSCRIPT.slice(half)],
    ];
    for (const chunks of variants) {
      const { body } = source(chunks);
      const result = await readAll(body);
      expect(result.rows).toEqual(EXPECTED.rows);
      expect(result.invalidLines).toBe(1);
      expect(body.locked).toBe(false);
    }
  });

  it.each([
    ["a string", "{}"],
    ["a number", 7],
    ["null", null],
    ["an object", { length: 3 }],
  ])("a chunk that is %s ends the walk with an SDK error and cancels the body", async (_label, chunk) => {
    const { body, cancelled } = source([bytes('{"_meta":{}}\n{"celex":"A"}\n'), chunk, bytes('{"celex":"B"}\n')]);
    const { rows, error } = await readAll(body);
    expect(rows).toEqual([{ celex: "A" }]);
    expect(error).toBeInstanceOf(NetworkError);
    expect(cancelled()).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("a source that reuses one buffer between reads does not corrupt a line split across reads", async () => {
    const all = bytes('{"_meta":{}}\n{"celex":"A","t":"', "x".repeat(40), "€", "y".repeat(40), '"}\n{"_done":{"complete":true}}\n');
    const size = 16;
    const shared = new Uint8Array(size);
    let pos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pos >= all.length) return controller.close();
        const n = Math.min(size, all.length - pos);
        shared.fill(0x21);
        shared.set(all.subarray(pos, pos + n));
        pos += n;
        controller.enqueue(shared.subarray(0, n));
      },
    }, { highWaterMark: 0 }); // the next pull, which overwrites the buffer, waits for the next read
    const { rows, invalidLines } = await readAll(body);
    expect(rows).toEqual([{ celex: "A", t: `${"x".repeat(40)}€${"y".repeat(40)}` }]);
    expect(invalidLines).toBe(0);
  });
});

describe("export: line ends, trimming and the byte order mark", () => {
  const read = (...lines: Array<string | number[]>) =>
    readAll(source([bytes('{"_meta":{}}\n', ...lines, '{"_done":{"complete":true}}\n')]).body);

  it("only a line feed ends a line: CR, U+0085, U+2028 and U+2029 do not", async () => {
    const { rows, invalidLines } = await read('{"a":1}\r{"b":2}\n', '{"c":"x\u0085y z w"}\n');
    expect(rows).toEqual([{ c: "x\u0085y z w" }]);
    expect(invalidLines).toBe(1); // {"a":1}\r{"b":2} is one line with text after the value
  });

  it("spaces, tabs and carriage returns around a line are removed", async () => {
    const { rows, invalidLines } = await read(' \t\r{"a":1}\r\t \r\n');
    expect(rows).toEqual([{ a: 1 }]);
    expect(invalidLines).toBe(0);
  });

  it.each([
    ["a no-break space", " "],
    ["a vertical tab", "\u000b"],
    ["a form feed", "\u000c"],
    ["a byte order mark", "﻿"],
    ["an ideographic space", "　"],
    ["a line separator", " "],
  ])("%s around a line is part of it: an invalid line", async (_label, pad) => {
    for (const line of [`${pad}{"a":1}\n`, `{"a":1}${pad}\n`]) {
      const { rows, invalidLines } = await read(line);
      expect(rows).toEqual([]);
      expect(invalidLines).toBe(1);
    }
  });

  it("a line of only spaces, tabs and carriage returns is skipped and not counted", async () => {
    const { rows, invalidLines } = await read("\n", " \t \n", "\r\n", '{"a":1}\n');
    expect(rows).toEqual([{ a: 1 }]);
    expect(invalidLines).toBe(0);
  });

  it("a byte order mark at the very start is ignored", async () => {
    const { meta, rows, invalidLines } = await readAll(source([bytes(BOM, '{"_meta":{"total":1}}\n{"a":1}\n{"_done":{"complete":true}}\n')]).body);
    expect(meta).toMatchObject({ total: 1 });
    expect(rows).toEqual([{ a: 1 }]);
    expect(invalidLines).toBe(0);
  });

  it("a byte order mark after leading whitespace, or on a later line, is part of its line", async () => {
    const late = await readAll(source([bytes(" ", BOM, '{"_meta":{"total":1}}\n{"a":1}\n{"_done":{"complete":true}}\n')]).body);
    expect(late.meta).toBeUndefined();
    expect(late.invalidLines).toBe(1);
    const later = await read(BOM, '{"a":1}\n', '{"b":2}\n');
    expect(later.rows).toEqual([{ b: 2 }]);
    expect(later.invalidLines).toBe(1);
  });

  it("a byte order mark before the _done line makes it invalid: no trailer", async () => {
    const { rows, error, complete } = await readAll(source([bytes('{"_meta":{}}\n{"a":1}\n', BOM, '{"_done":{"complete":true}}\n')]).body);
    expect(rows).toEqual([{ a: 1 }]);
    expect(complete).toBe(false);
    expect(error).toBeInstanceOf(LexAPIError);
  });

  it.each([
    ["NaN", '{"a":NaN}'],
    ["Infinity", '{"a":Infinity}'],
    ["text after the value", '{"a":1} {"b":2}'],
    ["an array", "[1]"],
    ["a number", "1"],
  ])("a line with %s is invalid", async (_label, line) => {
    const { rows, invalidLines } = await read(`${line}\n`);
    expect(rows).toEqual([]);
    expect(invalidLines).toBe(1);
  });
});

describe("export: the _meta line and truncated", () => {
  it("a _meta line after the first line is skipped and not counted; meta stays unset", async () => {
    for (const first of ['{"a":1}', "not json", '{"_error":{"code":"X"}}']) {
      const { rows, meta, invalidLines } = await readAll(
        source([bytes(`${first}\n{"_meta":{"total":9}}\n{"b":2}\n{"_done":{"complete":true}}\n`)]).body,
      );
      expect(meta, first).toBeUndefined();
      expect(rows.some((r) => typeof r === "object" && r !== null && "_meta" in r)).toBe(false);
      expect(invalidLines, first).toBe(first === "not json" ? 1 : 0);
    }
  });

  it("a blank first line: a _meta line after it is skipped and not counted", async () => {
    for (const first of ["", " \t", "\r", "\ufeff"]) {
      const { rows, meta, invalidLines } = await readAll(
        source([bytes(`${first}\n{"_meta":{"total":9}}\n{"a":1}\n{"_done":{"complete":true}}\n`)]).body,
      );
      expect(meta, JSON.stringify(first)).toBeUndefined();
      expect(rows).toEqual([{ a: 1 }]);
      expect(invalidLines).toBe(0);
    }
  });

  it("a second _meta line is skipped and does not replace the first", async () => {
    const { meta, rows, invalidLines } = await readAll(
      source([bytes('{"_meta":{"total":1}}\n{"_meta":{"total":9}}\n{"a":1}\n{"_done":{"complete":true}}\n')]).body,
    );
    expect(meta).toMatchObject({ total: 1 });
    expect(rows).toEqual([{ a: 1 }]);
    expect(invalidLines).toBe(0);
  });

  it("with no trailer flag, header or _meta.truncated, truncated is false", async () => {
    const stream = await exportClient(source([bytes('{"_meta":{}}\n{"a":1}\n{"_done":{"complete":true}}\n')]).body).export();
    expect(stream.truncated).toBe(false);
    for await (const _ of stream) void _;
    expect(stream.truncated).toBe(false);
  });

  it("the hints still apply", async () => {
    const header = await exportClient(source([bytes('{"_meta":{}}\n')]).body, { "x-export-truncated": "1" }).export();
    expect(header.truncated).toBe(true);
    const meta = await exportClient(source([bytes('{"_meta":{"truncated":true}}\n')]).body).export();
    expect(meta.truncated).toBe(true);
  });
});

// ── webhooks ────────────────────────────────────────────────────────────

const SECRET = "whsec_test";
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const sign = (body: Uint8Array | string) => createHmac("sha256", SECRET).update(body).digest("hex");
const event = (timestamp: unknown) => JSON.stringify({ event: "webhook.test", timestamp, data: {} });
const reason = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof WebhookSignatureError ? e.reason : e),
  );

describe("webhooks: the signature header", () => {
  const body = event("2026-11-19T12:00:00Z");
  const sig = sign(body);

  it("spaces, tabs, CR and LF around the header are removed; either case is accepted", async () => {
    for (const header of [` ${sig} `, `\t${sig}\r\n`, `\r\n\t ${sig}`, sig.toUpperCase(), `  ${sig.toUpperCase()}\n`]) {
      expect(await verifySignature(body, header, SECRET), JSON.stringify(header)).toBe(true);
    }
  });

  it.each([
    ["a byte order mark", "﻿"],
    ["a no-break space", " "],
    ["a vertical tab", "\u000b"],
    ["a form feed", "\u000c"],
    ["a next-line character", "\u0085"],
    ["a line separator", " "],
  ])("%s around the header fails", async (_label, pad) => {
    for (const header of [`${pad}${sig}`, `${sig}${pad}`]) {
      expect(await verifySignature(body, header, SECRET)).toBe(false);
      expect(await reason(verifyWebhook(body, header, SECRET, { now: NOW }))).toBe("invalid_signature");
    }
  });

  it("an absent or empty header is missing_signature; one of only whitespace is invalid_signature", async () => {
    for (const header of [null, undefined, ""]) {
      expect(await reason(verifyWebhook(body, header, SECRET, { now: NOW }))).toBe("missing_signature");
    }
    for (const header of [" ", "\t\r\n", "\u00a0"]) {
      expect(await reason(verifyWebhook(body, header, SECRET, { now: NOW }))).toBe("invalid_signature");
      expect(await verifySignature(body, header, SECRET)).toBe(false);
    }
  });

  it("63 or 65 digits, or a space inside, fail", async () => {
    for (const header of [sig.slice(1), `${sig}0`, `${sig.slice(0, 32)} ${sig.slice(32)}`, `sha256=${sig}`]) {
      expect(await verifySignature(body, header, SECRET)).toBe(false);
    }
  });
});

describe("webhooks: bodies that are JSON but not an object", () => {
  it.each(["null", "[]", '[{"timestamp":"2026-11-19T12:00:00Z"}]', "1", '"text"', "true"])("%s is malformed_body, with or without the replay window", async (text) => {
    expect(await reason(verifyWebhook(text, sign(text), SECRET, { now: NOW }))).toBe("malformed_body");
    expect(await reason(verifyWebhook(text, sign(text), SECRET, { toleranceMs: 0 }))).toBe("malformed_body");
  });
});

describe("webhooks: order of checks", () => {
  const stale = event("2020-01-01T00:00:00Z");
  const fresh = event("2026-11-19T12:00:00Z");

  it("secret, then a missing header, then the signature, then the body, then the timestamp", async () => {
    expect(await reason(verifyWebhook("not json", null, "", { now: NOW }))).toBe("missing_secret");
    expect(await reason(verifyWebhook("not json", "", SECRET, { now: NOW }))).toBe("missing_signature");
    expect(await reason(verifyWebhook("not json", undefined, SECRET, { now: NOW }))).toBe("missing_signature");
    expect(await reason(verifyWebhook("not json", "0".repeat(64), SECRET, { now: NOW }))).toBe("invalid_signature");
    expect(await reason(verifyWebhook("\ud800", sign("x"), SECRET, { now: NOW }))).toBe("invalid_signature");
    expect(await reason(verifyWebhook("null", sign("null"), SECRET, { now: NOW }))).toBe("malformed_body");
    expect(await reason(verifyWebhook(stale, sign(stale), SECRET, { now: NOW }))).toBe("stale_timestamp");
    expect(await reason(verifyWebhook(fresh, sign(fresh), SECRET, { now: NOW }))).toBe("ok");
  });

  it("an empty secret raises in every helper", async () => {
    const { computeSignature } = await import("../src/index.js");
    for (const p of [computeSignature("x", ""), verifySignature("x", sign("x"), ""), verifyWebhook("x", sign("x"), "")]) {
      expect(await reason(p)).toBe("missing_secret");
    }
  });
});

describe("webhooks: the timestamp form", () => {
  it.each([
    "2026-11-19T12:00:00Z",
    "2026-11-19T12:00:00.5Z",
    "2026-11-19T12:00:00.123Z",
    "2026-11-19T12:00:00.123456Z",
    "2026-11-19T13:00:00+01:00",
    "2026-11-19T06:30:00-05:30",
    "2026-11-19T12:00:00.000+00:00",
    "2026-11-19T12:00:00-00:00",
  ])("%s is accepted", async (timestamp) => {
    const body = event(timestamp);
    expect(await reason(verifyWebhook(body, sign(body), SECRET, { now: NOW }))).toBe("ok");
  });

  it.each([
    ["lower-case z", "2026-11-19T12:00:00z"],
    ["lower-case t", "2026-11-19t12:00:00Z"],
    ["a space for T", "2026-11-19 12:00:00Z"],
    ["no zone", "2026-11-19T12:00:00"],
    ["no seconds", "2026-11-19T12:00Z"],
    ["an empty fraction", "2026-11-19T12:00:00.Z"],
    ["an offset without a colon", "2026-11-19T13:00:00+0100"],
    ["an hour-only offset", "2026-11-19T13:00:00+01"],
    ["the zone name UTC", "2026-11-19T12:00:00 UTC"],
    ["RFC 2822 text", "Thu, 19 Nov 2026 12:00:00 GMT"],
    ["a date only", "2026-11-19"],
    ["surrounding spaces", " 2026-11-19T12:00:00Z "],
    ["month 13", "2026-13-19T12:00:00Z"],
    ["30 February", "2026-02-30T12:00:00Z"],
    ["hour 24", "2026-11-19T24:00:00Z"],
    ["minute 60", "2026-11-19T12:60:00Z"],
    ["second 60", "2026-11-19T12:00:60Z"],
    ["offset hour 24", "2026-11-19T12:00:00+24:00"],
    ["offset minute 60", "2026-11-19T12:00:00+00:60"],
    ["a five-digit year", "+02026-11-19T12:00:00Z"],
    ["non-ASCII digits", "２026-11-19T12:00:00Z"],
    ["a number", 1795089600000],
    ["null", null],
  ])("%s fails the replay check", async (_label, timestamp) => {
    const body = event(timestamp);
    expect(await reason(verifyWebhook(body, sign(body), SECRET, { now: NOW }))).toBe("stale_timestamp");
    expect(await reason(verifyWebhook(body, sign(body), SECRET, { toleranceMs: 0 }))).toBe("ok");
  });

  it("a missing timestamp fails the replay check", async () => {
    const body = JSON.stringify({ event: "webhook.test" });
    expect(await reason(verifyWebhook(body, sign(body), SECRET, { now: NOW }))).toBe("stale_timestamp");
  });
});

// ── quota 429s, failed payments, page sizes ─────────────────────────────

function apiClient(replies: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let call = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    expect(String(input).startsWith("http://127.0.0.1:9/")).toBe(true);
    const r = replies[Math.min(call++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", "x-lexapi-version": "2.29.0", ...r.headers },
    });
  });
  const client = new LexAPI({ apiKey: "lex_test_key", baseUrl: BASE, fetch: fetchFn, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
  return { client, fetchFn };
}

const USAGE = { usage: { current: 1000, limit: 1000, resetsAt: "2026-11-20T00:00:00.000Z" } };

describe("quota 429: the shape test applies only to RATE_LIMITED", () => {
  it("a sent RATE_LIMITED next to QUOTA_EXHAUSTED keeps RATE_LIMITED; any other code becomes QUOTA_EXHAUSTED", () => {
    const keeps = LexAPIError.fromResponse(429, { success: false, code: "QUOTA_EXHAUSTED", error: { code: "RATE_LIMITED", message: "x" } }) as RateLimitedError;
    expect([keeps.code, keeps.quotaExhausted]).toEqual(["RATE_LIMITED", true]);
    const other = LexAPIError.fromResponse(429, { success: false, code: "QUOTA_EXHAUSTED", error: { code: "TIER_FORBIDDEN", message: "x" } }) as RateLimitedError;
    expect(other).toBeInstanceOf(RateLimitedError);
    expect([other.code, other.quotaExhausted]).toEqual(["QUOTA_EXHAUSTED", true]);
  });


  it("an unknown code with usage.resetsAt and no hints is an ordinary 429: retried", async () => {
    const { client, fetchFn } = apiClient([{ status: 429, body: { code: "SOMETHING_NEW", error: "Slow down", ...USAGE } }]);
    const error = await client.getInfo().catch((e: unknown) => e);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(error).not.toBeInstanceOf(RateLimitedError);
    expect((error as LexAPIError).code).toBe("SOMETHING_NEW");
  });

  it("the same body without a code (derived RATE_LIMITED) is a quota 429, keeps RATE_LIMITED, not retried", async () => {
    const { client, fetchFn } = apiClient([{ status: 429, body: { error: "Daily quota exceeded", ...USAGE } }]);
    const error = (await client.getInfo().catch((e: unknown) => e)) as RateLimitedError;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(error.quotaExhausted).toBe(true);
    expect(error.code).toBe("RATE_LIMITED");
  });

  it("on another status the shape does not make a quota error", () => {
    const error = LexAPIError.fromResponse(503, { success: false, error: { code: "RATE_LIMITED", message: "x" }, ...USAGE }) as RateLimitedError;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.quotaExhausted).toBe(false);
  });

  it("on any status the flag is set when the code is QUOTA_EXHAUSTED", () => {
    for (const status of [400, 403, 429, 503]) {
      const error = LexAPIError.fromResponse(status, { success: false, error: { code: "QUOTA_EXHAUSTED", message: "x" } }) as RateLimitedError;
      expect(error.quotaExhausted, String(status)).toBe(true);
      expect(error.code).toBe("QUOTA_EXHAUSTED");
    }
  });
});

describe("PAYMENT_PAST_DUE is never retried, on any status", () => {
  it.each([429, 403, 500, 502, 503, 504])("status %i", async (status) => {
    const { client, fetchFn } = apiClient([
      { status, body: { code: "PAYMENT_PAST_DUE", error: "Payment past due" }, headers: { "retry-after": "0" } },
      { status: 200, body: { success: true } },
    ]);
    const error = await client.getInfo().catch((e: unknown) => e);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(PaymentPastDueError);
    expect((error as PaymentPastDueError).status).toBe(status);
  });
});

describe("page sizes up to 2^53 - 1", () => {
  it("2^53 is a RangeError before any request on every iterator; 2^53 - 1 is sent", async () => {
    const { client, fetchFn } = apiClient([{ status: 200, body: { success: true, citedBy: [], cites: [], deliveries: [], results: [], hasMore: false } }]);
    const walks = (limit: number) => [
      client.paginateCites("X", { limit }),
      client.paginateCitedBy("X", { limit }),
      client.webhooks.paginateDeliveries("w", { limit }),
      client.paginateNationalDocuments("AT", { limit }),
    ];
    for (const it of walks(2 ** 53)) {
      await expect(it.next()).rejects.toBeInstanceOf(RangeError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    for (const it of walks(2 ** 53 - 1)) await it.next();
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
});
