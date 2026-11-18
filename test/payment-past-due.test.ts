/**
 * `PAYMENT_PAST_DUE` (403) and the unknown-endpoint 404 (API 2.27.0;
 * SDK contract §1.3). Mocked fetch only.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  LexAPI,
  LexAPIError,
  NotFoundError,
  PaymentPastDueError,
  TierForbiddenError,
  isLexAPIError,
  type ErrorCode,
} from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

const PAST_DUE_BODY = {
  success: false,
  code: "PAYMENT_PAST_DUE",
  error: "Payment past due",
  message: "Your subscription payment failed, so API requests are refused.",
  accessEndedAt: "2026-11-25T09:14:03.000Z",
  billingUrl: "https://example.test/dashboard#billing",
};

function client(fetchMock: typeof fetch) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: { ...FAST_RETRY, retryReadOnlyPosts: true } });
}

describe("PaymentPastDueError", () => {
  it("maps the legacy-shape 403 and exposes both fields", async () => {
    const fetchMock = fetchSequence(jsonResponse(403, PAST_DUE_BODY, { "x-lexapi-version": "2.27.0" }));
    const error = (await client(fetchMock).getInfo().catch((e: unknown) => e)) as PaymentPastDueError;
    expect(error.constructor).toBe(PaymentPastDueError);
    expect(error.name).toBe("PaymentPastDueError");
    expect(error.code).toBe("PAYMENT_PAST_DUE");
    expect(error.status).toBe(403);
    expect(error.message).toContain("Payment past due: Your subscription payment failed");
    expect(error.accessEndedAt).toBe("2026-11-25T09:14:03.000Z");
    expect(error.billingUrl).toBe("https://example.test/dashboard#billing");
    expect(error.retryAfter).toBeUndefined();
    expect(error.body).toEqual(PAST_DUE_BODY);
  });

  it("accessEndedAt is undefined when the server does not send it", () => {
    const { accessEndedAt: _omitted, ...body } = PAST_DUE_BODY;
    const error = LexAPIError.fromResponse(403, body) as PaymentPastDueError;
    expect(error).toBeInstanceOf(PaymentPastDueError);
    expect(error.accessEndedAt).toBeUndefined();
    expect(error.billingUrl).toBe("https://example.test/dashboard#billing");
  });

  it.each([
    [{ accessEndedAt: 1795598043000, billingUrl: { href: "x" } }],
    [{ accessEndedAt: null, billingUrl: null }],
    [{ accessEndedAt: ["2026-11-25T09:14:03.000Z"], billingUrl: true }],
  ])("non-string fields are undefined: %j", (fields) => {
    const error = LexAPIError.fromResponse(403, { ...PAST_DUE_BODY, ...fields }) as PaymentPastDueError;
    expect(error).toBeInstanceOf(PaymentPastDueError);
    expect(error.accessEndedAt).toBeUndefined();
    expect(error.billingUrl).toBeUndefined();
  });

  it("reads the typed envelope's details", () => {
    const error = LexAPIError.fromResponse(403, {
      success: false,
      error: {
        code: "PAYMENT_PAST_DUE",
        message: "Payment past due",
        details: { accessEndedAt: "2026-11-26T00:00:00.000Z", billingUrl: "https://example.test/billing" },
      },
    }) as PaymentPastDueError;
    expect(error.constructor).toBe(PaymentPastDueError);
    expect(error.accessEndedAt).toBe("2026-11-26T00:00:00.000Z");
    expect(error.billingUrl).toBe("https://example.test/billing");
  });

  it("details win over the top level, field by field", () => {
    const error = LexAPIError.fromResponse(403, {
      ...PAST_DUE_BODY,
      details: { billingUrl: "https://example.test/from-details" },
    }) as PaymentPastDueError;
    expect(error.billingUrl).toBe("https://example.test/from-details");
    expect(error.accessEndedAt).toBe("2026-11-25T09:14:03.000Z");
  });

  it("a non-string value in details is used, not skipped: the field is undefined", () => {
    const error = LexAPIError.fromResponse(403, {
      ...PAST_DUE_BODY,
      details: { billingUrl: 5, accessEndedAt: null },
    }) as PaymentPastDueError;
    expect(error.billingUrl).toBeUndefined();
    expect(error.accessEndedAt).toBeUndefined();
  });

  it("the code maps by code on another status too", () => {
    const error = LexAPIError.fromResponse(402, PAST_DUE_BODY) as PaymentPastDueError;
    expect(error.constructor).toBe(PaymentPastDueError);
    expect(error.code).toBe("PAYMENT_PAST_DUE");
    expect(error.status).toBe(402);
    expect(error.billingUrl).toBe("https://example.test/dashboard#billing");
  });

  it("no usable fields at all: still the typed error, both undefined", () => {
    const error = LexAPIError.fromResponse(403, { code: "PAYMENT_PAST_DUE", error: "Payment past due" }) as PaymentPastDueError;
    expect(error).toBeInstanceOf(PaymentPastDueError);
    expect(error.accessEndedAt).toBeUndefined();
    expect(error.billingUrl).toBeUndefined();
  });

  it("is a LexAPIError and not a TierForbiddenError", () => {
    const error = LexAPIError.fromResponse(403, PAST_DUE_BODY);
    expect(error instanceof LexAPIError).toBe(true);
    expect(error instanceof PaymentPastDueError).toBe(true);
    expect(error instanceof TierForbiddenError).toBe(false);
    expect(isLexAPIError(error, PaymentPastDueError)).toBe(true);
    expect(isLexAPIError(error, TierForbiddenError)).toBe(false);
    expect(new TierForbiddenError("x") instanceof PaymentPastDueError).toBe(false);
    expect(PaymentPastDueError.kind).toBe("PaymentPastDueError");
  });

  it("constructs directly with the 403 default", () => {
    const error = new PaymentPastDueError("x");
    expect(error.status).toBe(403);
    expect(error.code).toBe("PAYMENT_PAST_DUE");
    expect(error.billingUrl).toBeUndefined();
  });

  it.each([
    ["a free GET", (c: LexAPI) => c.getInfo()],
    ["a billed GET", (c: LexAPI) => c.getCites("32016R0679")],
    ["a read-only POST with the opt-in", (c: LexAPI) => c.search({ query: "gdpr" })],
  ])("is never retried: %s", async (_label, call) => {
    const fetchMock = fetchSequence(
      jsonResponse(403, PAST_DUE_BODY, { "x-lexapi-version": "2.27.0", "ratelimit-limit": "60", "retry-after": "0" }),
      jsonResponse(200, { success: true }),
    );
    await expect(call(client(fetchMock))).rejects.toBeInstanceOf(PaymentPastDueError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("other 403s are unchanged", () => {
    const typed = LexAPIError.fromResponse(403, { success: false, error: { code: "TIER_FORBIDDEN", message: "Upgrade" } });
    expect(typed.constructor).toBe(TierForbiddenError);
    const legacyCode = LexAPIError.fromResponse(403, { success: false, code: "TIER_FORBIDDEN", error: "Upgrade required" });
    expect(legacyCode.constructor).toBe(TierForbiddenError);
    // An API before 2.27.0: a failed payment was a 403 without a code.
    const codeless = LexAPIError.fromResponse(403, {
      error: "Subscription inactive",
      message: "Please activate your subscription or downgrade to the FREE tier",
    });
    expect(codeless.constructor).toBe(TierForbiddenError);
    expect(codeless.code).toBe("TIER_FORBIDDEN");
    expect(codeless instanceof PaymentPastDueError).toBe(false);
    // A 403 without the code stays the tier error, whatever fields it carries.
    const withField = LexAPIError.fromResponse(403, { error: "Subscription inactive", billingUrl: "https://x.test/b" });
    expect(withField.constructor).toBe(TierForbiddenError);
    expect(withField.code).toBe("TIER_FORBIDDEN");
    expect((withField as unknown as { billingUrl?: unknown }).billingUrl).toBeUndefined();
    // The legacy `error` text is never a code.
    expect(LexAPIError.fromResponse(403, { error: "PAYMENT_PAST_DUE" }).constructor).toBe(TierForbiddenError);
    expect(LexAPIError.fromResponse(403, null).constructor).toBe(TierForbiddenError);
  });

  it("types", () => {
    expectTypeOf<PaymentPastDueError["accessEndedAt"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PaymentPastDueError["billingUrl"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PaymentPastDueError>().toMatchTypeOf<LexAPIError>();
    expectTypeOf<"PAYMENT_PAST_DUE">().toMatchTypeOf<ErrorCode>();
    expectTypeOf<"SOMETHING_NEW">().toMatchTypeOf<ErrorCode>();
    expectTypeOf<NotFoundError["unknownEndpoint"]>().toEqualTypeOf<boolean>();
  });
});

describe("NotFoundError.unknownEndpoint", () => {
  const UNKNOWN_MESSAGE = "Unknown API endpoint: GET /api/v1/serach. See the endpoint reference.";

  it("is true for a 404 carrying details.reason unknown_endpoint", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(404, {
        success: false,
        error: { code: "NOT_FOUND", message: UNKNOWN_MESSAGE, details: { reason: "unknown_endpoint" } },
      }),
    );
    const error = (await client(fetchMock).getInfo().catch((e: unknown) => e)) as NotFoundError;
    expect(error.constructor).toBe(NotFoundError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe(`[NOT_FOUND] ${UNKNOWN_MESSAGE} (HTTP 404)`);
    expect(error.unknownEndpoint).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is false for a missing document", () => {
    const plain = LexAPIError.fromResponse(404, {
      success: false,
      error: { code: "NOT_FOUND", message: "Document 39999X9999 does not exist on EUR-Lex (EN)" },
    }) as NotFoundError;
    expect(plain.unknownEndpoint).toBe(false);
    const national = LexAPIError.fromResponse(404, {
      success: false,
      error: { code: "NOT_FOUND", message: "No AT document found", details: { id: "AT-NOR-99999999", jurisdiction: "AT" } },
    }) as NotFoundError;
    expect(national.unknownEndpoint).toBe(false);
  });

  it.each([
    ["another reason", { reason: "not_held" }],
    ["a different case", { reason: "UNKNOWN_ENDPOINT" }],
    ["a boolean", { reason: true }],
    ["a list", { reason: ["unknown_endpoint"] }],
    ["an object", { reason: { value: "unknown_endpoint" } }],
    ["details that is the string itself", "unknown_endpoint"],
    ["details that is a list", ["unknown_endpoint"]],
    ["null details", null],
  ])("is false for %s", (_label, details) => {
    const error = LexAPIError.fromResponse(404, {
      success: false,
      error: { code: "NOT_FOUND", message: "nope", details },
    }) as NotFoundError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.unknownEndpoint).toBe(false);
  });

  it("is false on an older API: the message prefix alone never sets it", () => {
    const typed = LexAPIError.fromResponse(404, {
      success: false,
      error: { code: "NOT_FOUND", message: UNKNOWN_MESSAGE },
    }) as NotFoundError;
    expect(typed.unknownEndpoint).toBe(false);
    // A top-level `reason` outside `details` is not the documented place.
    const stray = LexAPIError.fromResponse(404, { error: UNKNOWN_MESSAGE, reason: "unknown_endpoint" }) as NotFoundError;
    expect(stray).toBeInstanceOf(NotFoundError);
    expect(stray.unknownEndpoint).toBe(false);
    expect((LexAPIError.fromResponse(404, "<html>") as NotFoundError).unknownEndpoint).toBe(false);
    expect(new NotFoundError("x").unknownEndpoint).toBe(false);
  });

  it("reads the legacy shape's top-level details too", () => {
    const error = LexAPIError.fromResponse(404, {
      success: false,
      code: "NOT_FOUND",
      error: "Unknown API endpoint",
      details: { reason: "unknown_endpoint" },
    }) as NotFoundError;
    expect(error.unknownEndpoint).toBe(true);
  });
});
