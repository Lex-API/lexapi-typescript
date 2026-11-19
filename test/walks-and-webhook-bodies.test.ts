// SDK contract §1.2, §1.3, §1.4 and §1.9: page-size checks on every iterator,
// repeat runs across signalled edge pages, zero citation counts, strict UTF-8
// webhook bodies, the past-due error's base class and quota codes.
// Loopback stubs only.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  InvalidResponseError,
  LexAPI,
  LexAPIError,
  PaymentPastDueError,
  RateLimitedError,
  TierForbiddenError,
  WebhookSignatureError,
  isLexAPIError,
  verifySignature,
  verifyWebhook,
} from "../src/index.js";

const BASE = "http://127.0.0.1:9/api/v1";

afterEach(() => {
  vi.restoreAllMocks();
});

function server(handler: (url: URL, call: number) => unknown, status = 200, headers: Record<string, string> = {}) {
  let call = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    expect(url.origin).toBe("http://127.0.0.1:9");
    return new Response(JSON.stringify(handler(url, call++)), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  });
  const client = new LexAPI({ apiKey: "lex_test_key", baseUrl: BASE, fetch: fetchFn, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
  return { client, fetchFn, requests: () => fetchFn.mock.calls.length };
}

async function walk<T>(it: AsyncIterable<T>, bound = 1_000): Promise<{ pages: T[]; error?: unknown }> {
  const pages: T[] = [];
  try {
    for await (const page of it) {
      pages.push(page);
      if (pages.length > bound) throw new Error("iterator did not end");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "iterator did not end") throw error;
    return { pages, error };
  }
  return { pages };
}

const offsetOf = (url: URL) => Number(url.searchParams.get("offset") ?? 0);

describe("paginateNationalDocuments: page size", () => {
  it.each([
    ["0", 0],
    ["-1", -1],
    ["1.5", 1.5],
    ['"5"', "5"],
    ["true", true],
    ["NaN", Number.NaN],
  ])("a limit of %s is a RangeError before any request", async (_label, limit) => {
    const { client, fetchFn } = server(() => {
      throw new Error("no request expected");
    });
    const { pages, error } = await walk(client.paginateNationalDocuments("AT", { limit } as never));
    expect(error).toBeInstanceOf(RangeError);
    expect(pages).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a positive integer limit, or none, is sent as before", async () => {
    for (const params of [{ limit: 25 }, {}]) {
      const { client, fetchFn } = server(() => ({ jurisdiction: "AT", hasMore: false, results: [] }));
      const { error } = await walk(client.paginateNationalDocuments("AT", params));
      expect(error).toBeUndefined();
      const sent = new URL(String(fetchFn.mock.calls[0]![0])).searchParams.get("limit");
      expect(sent).toBe("limit" in params ? "25" : null);
    }
  });
});

describe("edge walks: a signalled page is still the previous page", () => {
  const group = [{ celexNumber: "A", citationCount: 2 }];

  it.each([
    ["an echoed offset", (url: URL) => ({ offset: offsetOf(url) })],
    ["totalEdges", () => ({ totalEdges: 1_000 })],
  ])("A, A, A (with %s), A, A, A throws at the sixth request", async (_label, signal) => {
    const { client, requests } = server((url, call) => ({
      success: true, targetDocument: "X", limit: 2, ...(call === 2 ? signal(url) : {}), citedBy: group,
    }));
    const { pages, error } = await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(requests()).toBe(6);
    expect(pages).toHaveLength(5);
  });

  it("paginateCites follows the same rule", async () => {
    const { client, requests } = server((url, call) => ({
      success: true, sourceDocument: "X", limit: 2, ...(call === 2 ? { offset: offsetOf(url) } : {}), cites: group,
    }));
    const { error } = await walk(client.paginateCites("X", { limit: 2 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(requests()).toBe(6);
  });

  it("a signalled page is not counted: A, A, A (signal), A, A, then a short page ends without an error", async () => {
    const { client, requests } = server((url, call) => ({
      success: true, targetDocument: "X", limit: 2, ...(call === 2 ? { offset: offsetOf(url) } : {}),
      citedBy: call < 5 ? group : [{ celexNumber: "A", citationCount: 1 }],
    }));
    const { error } = await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(error).toBeUndefined();
    expect(requests()).toBe(6);
  });

  it("A, B (with a signal), B, B, B throws at the fifth request", async () => {
    const b = [{ celexNumber: "B", citationCount: 2 }];
    const { client, requests } = server((url, call) => ({
      success: true, targetDocument: "X", limit: 2, ...(call === 1 ? { offset: offsetOf(url) } : {}), citedBy: call === 0 ? group : b,
    }));
    const { error } = await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(requests()).toBe(5);
  });
});

describe("edge walks: a citationCount of 0", () => {
  it("on a group with three edges counts the three edges", async () => {
    const { client, fetchFn } = server((url) => ({
      success: true, targetDocument: "X", limit: 3,
      citedBy: offsetOf(url) === 0
        ? [{ celexNumber: "A", citationCount: 0, citations: [{ extractedAt: "t1" }, { extractedAt: "t2" }, { extractedAt: "t3" }] }]
        : [],
    }));
    const { error } = await walk(client.paginateCitedBy("X", { limit: 3 }));
    expect(error).toBeUndefined();
    expect(fetchFn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("offset"))).toEqual(["0", "3"]);
  });

  it("next to counted groups adds its list length", async () => {
    const { client, fetchFn } = server((url) => ({
      success: true, targetDocument: "X", limit: 3,
      citedBy: offsetOf(url) === 0
        ? [{ celexNumber: "A", citationCount: 2 }, { celexNumber: "B", citationCount: 0, citations: [{ extractedAt: "t1" }] }]
        : [],
    }));
    await walk(client.paginateCitedBy("X", { limit: 3 }));
    expect(fetchFn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("offset"))).toEqual(["0", "3"]);
  });

  it.each([
    ["an empty edge list", { citations: [] }],
    ["no edge list", {}],
  ])("with %s counts 0", async (_label, extra) => {
    const { client, requests } = server(() => ({
      success: true, targetDocument: "X", limit: 2, citedBy: [{ celexNumber: "A", citationCount: 0, ...extra }],
    }));
    const { error } = await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(error).toBeUndefined();
    expect(requests()).toBe(1);
  });
});

describe("webhook bodies are strict UTF-8", () => {
  const SECRET = "whsec_test";
  const NOW = Date.parse("2026-11-19T12:00:00.000Z");
  const PAYLOAD = { event: "webhook.test", timestamp: "2026-11-19T12:00:00.000Z", delivery: { id: "d1" }, data: { note: "é" } };
  const RAW = JSON.stringify(PAYLOAD);
  const enc = new TextEncoder();
  const sign = (bytes: Uint8Array) => createHmac("sha256", SECRET).update(bytes).digest("hex");
  const withBytes = (bad: number[]) => {
    const head = enc.encode(`{"event":"webhook.test","timestamp":"2026-11-19T12:00:00.000Z","data":{"note":"`);
    const tail = enc.encode(`"}}`);
    return new Uint8Array([...head, ...bad, ...tail]);
  };

  it.each([
    ["0xFF", [0xff]],
    ["0xFE", [0xfe]],
    ["a lone continuation byte", [0x80]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["an overlong slash", [0xc0, 0xaf]],
    ["an overlong three-byte sequence", [0xe0, 0x80, 0xaf]],
    ["a truncated three-byte sequence", [0xe2, 0x82]],
    ["a code point above U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
    ["a 0xF5 lead byte", [0xf5, 0x80, 0x80, 0x80]],
    ["latin-1 text", [0x63, 0x61, 0x66, 0xe9]],
  ])("%s with a valid signature is malformed_body", async (_label, bad) => {
    const body = withBytes(bad);
    const signature = sign(body);
    expect(await verifySignature(body, signature, SECRET)).toBe(true);
    for (const input of [body, body.buffer.slice(0), Buffer.from(body)]) {
      const error = await verifyWebhook(input, signature, SECRET, { now: NOW }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WebhookSignatureError);
      expect((error as WebhookSignatureError).reason).toBe("malformed_body");
    }
  });

  it("a body ending in a truncated sequence is malformed_body", async () => {
    const body = new Uint8Array([...enc.encode(RAW), 0xe2]);
    const error = await verifyWebhook(body, sign(body), SECRET, { now: NOW }).catch((e: unknown) => e);
    expect((error as WebhookSignatureError).reason).toBe("malformed_body");
  });

  it("an invalid signature is still reported as such, whatever the bytes", async () => {
    const error = await verifyWebhook(withBytes([0xff]), "0".repeat(64), SECRET, { now: NOW }).catch((e: unknown) => e);
    expect((error as WebhookSignatureError).reason).toBe("invalid_signature");
  });

  it("a body with one leading byte order mark verifies; the mark is ignored", async () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(RAW)]);
    for (const input of [body, body.buffer.slice(0)]) {
      const event = await verifyWebhook(input, sign(body), SECRET, { now: NOW });
      expect(event).toEqual(PAYLOAD);
    }
  });

  it("a string body with one leading byte order mark verifies over its UTF-8 bytes", async () => {
    const text = `﻿${RAW}`;
    const event = await verifyWebhook(text, sign(enc.encode(text)), SECRET, { now: NOW });
    expect(event).toEqual(PAYLOAD);
  });

  it("two byte order marks are malformed_body", async () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...enc.encode(RAW)]);
    const error = await verifyWebhook(body, sign(body), SECRET, { now: NOW }).catch((e: unknown) => e);
    expect((error as WebhookSignatureError).reason).toBe("malformed_body");
  });

  it("valid multi-byte text verifies as before", async () => {
    const body = enc.encode(JSON.stringify({ ...PAYLOAD, data: { note: "Größe € 𝄞" } }));
    const event = await verifyWebhook(body, sign(body), SECRET, { now: NOW });
    expect((event as unknown as { data: { note: string } }).data.note).toBe("Größe € 𝄞");
  });

  it("a body nested 100,000 levels deep is malformed_body or parsed, never a raw RangeError", async () => {
    const deep = enc.encode(`{"timestamp":"2026-11-19T12:00:00.000Z","x":${"[".repeat(100_000)}${"]".repeat(100_000)}}`);
    const outcome = await verifyWebhook(deep, sign(deep), SECRET, { now: NOW }).then(
      () => "parsed",
      (e: unknown) => (e instanceof WebhookSignatureError ? e.reason : e),
    );
    expect(["parsed", "malformed_body"]).toContain(outcome);
  });
});

describe("PaymentPastDueError extends TierForbiddenError", () => {
  const BODY = { success: false, code: "PAYMENT_PAST_DUE", error: "Payment past due", billingUrl: "https://example.test/billing" };

  it("is a TierForbiddenError with its own code, name and fields", () => {
    const error = LexAPIError.fromResponse(403, BODY);
    expect(error.constructor).toBe(PaymentPastDueError);
    expect(error).toBeInstanceOf(TierForbiddenError);
    expect(error).toBeInstanceOf(LexAPIError);
    expect(isLexAPIError(error, TierForbiddenError)).toBe(true);
    expect(isLexAPIError(error, PaymentPastDueError)).toBe(true);
    expect(error.code).toBe("PAYMENT_PAST_DUE");
    expect(error.name).toBe("PaymentPastDueError");
    expect(error.message.startsWith("[PAYMENT_PAST_DUE] ")).toBe(true);
    expect((error as PaymentPastDueError).billingUrl).toBe("https://example.test/billing");
    expect(new PaymentPastDueError("x")).toBeInstanceOf(TierForbiddenError);
    expect(new PaymentPastDueError("x").code).toBe("PAYMENT_PAST_DUE");
  });

  it("a tier error is not a PaymentPastDueError", () => {
    const tier = LexAPIError.fromResponse(403, { success: false, error: { code: "TIER_FORBIDDEN", message: "Upgrade" } });
    expect(tier.constructor).toBe(TierForbiddenError);
    expect(tier).not.toBeInstanceOf(PaymentPastDueError);
    expect(isLexAPIError(tier, PaymentPastDueError)).toBe(false);
    expect(new TierForbiddenError("x").code).toBe("TIER_FORBIDDEN");
  });

  it("an error from another copy of the package matches both classes", () => {
    const kinds = (LexAPIError.fromResponse(403, BODY) as unknown as Record<symbol, unknown>)[Symbol.for("@lexapi/client.errorKinds")];
    expect(kinds).toEqual(["PaymentPastDueError", "TierForbiddenError", "LexAPIError"]);
    const foreign = Object.defineProperty({}, Symbol.for("@lexapi/client.errorKinds"), { value: kinds });
    expect(foreign instanceof TierForbiddenError).toBe(true);
    expect(foreign instanceof PaymentPastDueError).toBe(true);
  });

  it("is never retried, also by a handler that catches TierForbiddenError", async () => {
    const { client, requests } = server(() => BODY, 403, { "x-lexapi-version": "2.29.0", "retry-after": "0" });
    const error = await client.getInfo().catch((e: unknown) => e);
    expect(requests()).toBe(1);
    expect(error instanceof TierForbiddenError && error instanceof PaymentPastDueError).toBe(true);
  });

  it("types", () => {
    expectTypeOf<PaymentPastDueError>().toMatchTypeOf<TierForbiddenError>();
    expectTypeOf<PaymentPastDueError["billingUrl"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PaymentPastDueError["accessEndedAt"]>().toEqualTypeOf<string | undefined>();
    const handle = (e: TierForbiddenError) => e.code;
    expect(handle(new PaymentPastDueError("x"))).toBe("PAYMENT_PAST_DUE");
  });
});

describe("quota 429: the code in either place", () => {
  const RESETS = "2026-11-20T00:00:00.000Z";

  it.each([
    ["the top-level code next to another error.code", { success: false, code: "QUOTA_EXHAUSTED", error: { code: "INTERNAL", message: "x" }, resetsAt: RESETS }],
    ["the top-level code next to an unknown error.code", { success: false, code: "QUOTA_EXHAUSTED", error: { code: "SOMETHING_NEW", message: "x" } }],
    ["error.code next to another top-level code", { success: false, code: "RATE_LIMITED", error: { code: "QUOTA_EXHAUSTED", message: "x" } }],
    ["the top-level code next to error.code RATE_LIMITED", { success: false, code: "QUOTA_EXHAUSTED", error: { code: "RATE_LIMITED", message: "x" } }],
  ])("%s is a quota 429, not retried, no retryAfter", async (_label, body) => {
    const { client, requests } = server(() => body, 429, { "x-lexapi-version": "2.29.0", "retry-after": "1" });
    const error = (await client.getInfo().catch((e: unknown) => e)) as RateLimitedError;
    expect(requests()).toBe(1);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.quotaExhausted).toBe(true);
    expect(error.retryAfter).toBeUndefined();
  });

  it("quotaExhausted reads error.code too on an error built by hand", () => {
    const error = new RateLimitedError("x", 429, undefined, undefined, { body: { success: false, error: { code: "QUOTA_EXHAUSTED", message: "x" } } });
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.quotaExhausted).toBe(true);
  });

  it("the code on another status is not a quota 429 by the top-level code alone", () => {
    const error = LexAPIError.fromResponse(503, { success: false, code: "QUOTA_EXHAUSTED", error: { code: "INTERNAL", message: "x" } });
    expect(error).not.toBeInstanceOf(RateLimitedError);
  });
});

describe("retry-hint details", () => {
  const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

  it("a wait from an epoch value is rounded to the nearest second, halves up", async () => {
    const { normalizeRetryAfterSeconds } = await import("../src/retryHints.js");
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(normalizeRetryAfterSeconds(NOW / 1000 + 29.5)).toBe(30);
    expect(normalizeRetryAfterSeconds(NOW / 1000 + 29.49)).toBe(29);
    expect(normalizeRetryAfterSeconds(NOW + 29_500)).toBe(30);
    expect(normalizeRetryAfterSeconds(NOW + 29_499)).toBe(29);
  });

  it("year 0000 is a valid year", async () => {
    const { httpDateMs, retryAfterHeaderSeconds } = await import("../src/retryHints.js");
    const jan1 = new Date(0);
    jan1.setUTCFullYear(0, 0, 1);
    expect(httpDateMs("Sat, 01 Jan 0000 00:00:00 GMT", NOW)).toBe(jan1.getTime());
    expect(httpDateMs("Tue, 29 Feb 0000 00:00:00 GMT", NOW)).toBeDefined(); // 0000 is a leap year
    expect(httpDateMs("Sat Jan  1 00:00:00 0000", NOW)).toBe(jan1.getTime());
    expect(retryAfterHeaderSeconds("Sat, 01 Jan 0000 00:00:00 GMT")).toBe(0); // a past date, not absent
  });
});
