/**
 * Top-level `code` on legacy-shape bodies and `QUOTA_EXHAUSTED`
 * (PLAN.md §1.2 / §1.3; lex-api PR #304). The code takes precedence over the
 * status-derived one, a quota 429 is never retried and exposes no
 * retry-after, and the absence-based detection stays as the fallback for
 * older servers.
 */
import { describe, expect, it } from "vitest";

import { InvalidParamsError, LexAPI, LexAPIError, RateLimitedError } from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

const QUOTA_BODY = {
  success: false,
  code: "QUOTA_EXHAUSTED",
  error: "Daily quota exceeded",
  message: "You've reached your daily limit of 1000 API calls. Resets at midnight UTC.",
  resetsAt: "2026-10-27T00:00:00.000Z",
  usage: { current: 1000, limit: 1000, resetsAt: "2026-10-27T00:00:00.000Z", unit: "calls" },
};

function client(fetchMock: typeof fetch) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });
}

describe("QUOTA_EXHAUSTED and top-level codes", () => {
  it("a QUOTA_EXHAUSTED 429 is not retried and has no retryAfter, even with Retry-After", async () => {
    const fetchMock = fetchSequence(jsonResponse(429, QUOTA_BODY, { "retry-after": "0", "ratelimit-reset": "0" }));
    const error = (await client(fetchMock).getInfo().catch((e: unknown) => e)) as RateLimitedError;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.code).toBe("QUOTA_EXHAUSTED");
    expect(error.quotaExhausted).toBe(true);
    expect(error.retryAfter).toBeUndefined();
    expect(error.resetsAt).toBe("2026-10-27T00:00:00.000Z");
  });

  it("the top-level resetsAt wins over usage.resetsAt", () => {
    const error = LexAPIError.fromResponse(429, { ...QUOTA_BODY, resetsAt: "2026-11-01T00:00:00.000Z" }) as RateLimitedError;
    expect(error.resetsAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("a RATE_LIMITED 429 is still retried", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(429, { success: false, code: "RATE_LIMITED", error: "Rate limit exceeded", retryAfter: 0 }, { "retry-after": "0" }),
      jsonResponse(200, { success: true }),
    );
    await client(fetchMock).getInfo();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the top-level code takes precedence over the status; the legacy error text never does", () => {
    const typed = LexAPIError.fromResponse(400, { success: false, code: "INVALID_CELEX", error: "Bad CELEX" });
    expect(typed.code).toBe("INVALID_CELEX");
    expect(typed.message).toContain("Bad CELEX");
    const legacy = LexAPIError.fromResponse(400, { error: "Bad request" });
    expect(legacy).toBeInstanceOf(InvalidParamsError);
    expect(LexAPIError.fromResponse(429, { error: "QUOTA_EXHAUSTED" }).code).toBe("RATE_LIMITED");
  });

  it("an unknown top-level code is kept raw on the base type", () => {
    const error = LexAPIError.fromResponse(418, { code: "SOMETHING_NEW", error: "x" });
    expect(error.constructor).toBe(LexAPIError);
    expect(error.code).toBe("SOMETHING_NEW");
  });

  it("older servers without a code: the shape-based quota detection still applies", () => {
    const error = LexAPIError.fromResponse(429, {
      error: "Daily quota exceeded",
      usage: { current: 1000, limit: 1000, resetsAt: "2026-10-27T00:00:00.000Z" },
    }) as RateLimitedError;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.quotaExhausted).toBe(true);
    expect(error.resetsAt).toBe("2026-10-27T00:00:00.000Z");
  });
});
