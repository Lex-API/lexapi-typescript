import { describe, expect, it, vi } from "vitest";

import { LexAPI } from "../src/index.js";
import {
  AuthenticationError,
  CreditsExhaustedError,
  InternalServerError,
  InvalidCelexError,
  InvalidParamsError,
  InvalidUrlError,
  LexAPIError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  TierForbiddenError,
  TimeoutError,
  UpstreamError,
  normalizeRetryAfterSeconds,
} from "../src/errors.js";
import { jsonResponse } from "./helpers.js";

function clientFor(response: Response) {
  return new LexAPI({
    apiKey: "lex_test_key",
    fetch: vi.fn(async () => response.clone()),
    retry: { maxRetries: 0 },
  });
}

async function errorFrom(response: Response): Promise<LexAPIError> {
  const error = await clientFor(response)
    .getInfo()
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LexAPIError);
  return error as LexAPIError;
}

describe("typed envelope parsing", () => {
  it.each([
    [404, "NOT_FOUND", NotFoundError],
    [400, "INVALID_CELEX", InvalidCelexError],
    [400, "INVALID_URL", InvalidUrlError],
    [400, "INVALID_PARAMS", InvalidParamsError],
    [429, "RATE_LIMITED", RateLimitedError],
    [403, "TIER_FORBIDDEN", TierForbiddenError],
    [402, "CREDITS_EXHAUSTED", CreditsExhaustedError],
    [502, "UPSTREAM_ERROR", UpstreamError],
    [504, "TIMEOUT", TimeoutError],
    [500, "INTERNAL", InternalServerError],
  ] as const)("maps HTTP %i code %s to %o", async (status, code, ctor) => {
    const error = await errorFrom(
      jsonResponse(status, { success: false, error: { code, message: "boom" } }),
    );
    expect(error).toBeInstanceOf(ctor);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.message).toContain("boom");
  });

  it("keeps error.details", async () => {
    const error = await errorFrom(
      jsonResponse(400, {
        success: false,
        error: { code: "INVALID_PARAMS", message: "bad", details: { field: "query" } },
      }),
    );
    expect(error.details).toEqual({ field: "query" });
  });

  it("extracts resetsAt on CREDITS_EXHAUSTED from error.details", async () => {
    const error = await errorFrom(
      jsonResponse(402, {
        success: false,
        error: {
          code: "CREDITS_EXHAUSTED",
          message: "Monthly credit pool exhausted",
          details: { operation: "search", weight: 3, resetsAt: "2026-08-01T00:00:00.000Z" },
        },
      }),
    );
    expect(error).toBeInstanceOf(CreditsExhaustedError);
    expect((error as CreditsExhaustedError).resetsAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("falls back to usage.resetsAt for CREDITS_EXHAUSTED", async () => {
    const error = await errorFrom(
      jsonResponse(402, {
        success: false,
        error: { code: "CREDITS_EXHAUSTED", message: "exhausted" },
        usage: { resetsAt: "2026-08-01T00:00:00.000Z" },
      }),
    );
    expect((error as CreditsExhaustedError).resetsAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("preserves unknown codes on the base class (forward compat)", async () => {
    const error = await errorFrom(
      jsonResponse(418, { success: false, error: { code: "TEAPOT", message: "short and stout" } }),
    );
    expect(error.constructor).toBe(LexAPIError);
    expect(error.code).toBe("TEAPOT");
    expect(error.status).toBe(418);
  });
});

describe("legacy bare envelope parsing", () => {
  it("uses the error string as the message and derives the code from the status", async () => {
    const error = await errorFrom(jsonResponse(404, { error: "Document not found" }));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("Document not found");
  });

  it("combines legacy {error, message} pairs", async () => {
    const error = await errorFrom(
      jsonResponse(400, { error: "Invalid parameters", message: "query must be a string" }),
    );
    expect(error).toBeInstanceOf(InvalidParamsError);
    expect(error.message).toContain("Invalid parameters");
    expect(error.message).toContain("query must be a string");
  });

  it("maps 401 to AuthenticationError", async () => {
    const error = await errorFrom(jsonResponse(401, { error: "Invalid API key" }));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("tolerates non-JSON error bodies", async () => {
    const error = await errorFrom(new Response("Bad Gateway", { status: 502 }));
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toContain("HTTP 502");
  });

  it("reads Retry-After from the header (preferred over the JSON body field)", async () => {
    const error = await errorFrom(
      jsonResponse(429, { error: "Rate limit hit", retryAfter: 9999999 }, { "retry-after": "7" }),
    );
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfter).toBe(7);
  });

  it("supports HTTP-date Retry-After headers", async () => {
    const date = new Date(Date.now() + 12_000).toUTCString();
    const error = await errorFrom(
      jsonResponse(429, { error: "Rate limit hit" }, { "retry-after": date }),
    );
    expect(error.retryAfter).toBeGreaterThanOrEqual(10);
    expect(error.retryAfter).toBeLessThanOrEqual(13);
  });

  it("normalizes a buggy epoch-seconds JSON retryAfter when no header is present", async () => {
    const epochSeconds = Math.round(Date.now() / 1000) + 42;
    const error = await errorFrom(
      jsonResponse(429, { error: "Rate limit hit", retryAfter: epochSeconds }),
    );
    expect(error.retryAfter).toBeGreaterThanOrEqual(40);
    expect(error.retryAfter).toBeLessThanOrEqual(44);
  });
});

describe("normalizeRetryAfterSeconds", () => {
  it("passes small delta values through", () => {
    expect(normalizeRetryAfterSeconds(30)).toBe(30);
  });

  it("converts epoch-seconds to a delta", () => {
    const value = normalizeRetryAfterSeconds(Date.now() / 1000 + 60);
    expect(value).toBeGreaterThanOrEqual(58);
    expect(value).toBeLessThanOrEqual(62);
  });

  it("converts epoch-millis to a delta", () => {
    const value = normalizeRetryAfterSeconds(Date.now() + 60_000);
    expect(value).toBeGreaterThanOrEqual(58);
    expect(value).toBeLessThanOrEqual(62);
  });

  it("clamps past values to zero", () => {
    expect(normalizeRetryAfterSeconds(Date.now() / 1000 - 100)).toBe(0);
  });
});

describe("error context (body, headers, legacy details)", () => {
  it("keeps legacy validation `details` (e.g. /search parameter errors)", async () => {
    const error = await errorFrom(
      jsonResponse(400, { error: "Invalid search parameters", details: ["month must be 1-12"] }),
    );
    expect(error).toBeInstanceOf(InvalidParamsError);
    expect(error.details).toEqual(["month must be 1-12"]);
  });

  it("exposes the raw body for legacy-only fields (export tier gate upgradeUrl)", async () => {
    const error = await errorFrom(
      jsonResponse(403, {
        error: "Bulk export is a BUSINESS-tier feature",
        message: "Upgrade your plan to export the LexAPI corpus in bulk.",
        upgradeUrl: "/pricing",
      }),
    );
    expect(error).toBeInstanceOf(TierForbiddenError);
    expect(error.message).toContain("BUSINESS-tier");
    expect((error.body as { upgradeUrl?: string }).upgradeUrl).toBe("/pricing");
  });

  it("maps 503 to ServiceUnavailableError (derived code)", async () => {
    const error = await errorFrom(new Response("Service Unavailable", { status: 503 }));
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("exposes RateLimit-* headers on RateLimitedError", async () => {
    const error = await errorFrom(
      jsonResponse(
        429,
        {
          error: "Rate limit exceeded",
          message: "You can make up to 60 requests per minute on your current plan",
          retryAfter: 42,
        },
        {
          "retry-after": "42",
          "ratelimit-limit": "60",
          "ratelimit-remaining": "0",
          "ratelimit-reset": "42",
          "ratelimit-policy": "60;w=60",
        },
      ),
    );
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfter).toBe(42);
    expect((error as RateLimitedError).rateLimit).toEqual({ limit: 60, remaining: 0, reset: 42, policy: "60;w=60" });
    expect(error.headers?.rateLimit?.remaining).toBe(0);
  });

  it("types the CREDITS_EXHAUSTED details (operation / weight / available)", async () => {
    const error = (await errorFrom(
      jsonResponse(402, {
        success: false,
        error: {
          code: "CREDITS_EXHAUSTED",
          message: "Credit pool exhausted",
          details: {
            operation: "semantic_case_law",
            weight: 5,
            available: 2,
            included: 30000,
            topup: 0,
            used: 29998,
            resetsAt: "2026-07-01T00:00:00.000Z",
          },
        },
      }),
    )) as CreditsExhaustedError;
    expect(error).toBeInstanceOf(CreditsExhaustedError);
    expect(error.operation).toBe("semantic_case_law");
    expect(error.weight).toBe(5);
    expect(error.available).toBe(2);
    expect(error.details?.used).toBe(29998);
    expect(error.resetsAt).toBe("2026-07-01T00:00:00.000Z");
  });
});
