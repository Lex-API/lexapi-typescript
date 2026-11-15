import { describe, expect, expectTypeOf, it } from "vitest";

import {
  InvalidParamsError,
  isLexAPIError,
  LexAPI,
  LexAPIError,
  NationalSemanticFilterUnreachableError,
  NationalSemanticUnavailableError,
  RateLimitedError,
  ServiceUnavailableError,
  type NationalSemanticCaseLawResponse,
  type NationalSemanticLegislationResponse,
  type ResolveResponse,
  type ResolvedVia,
} from "../src/index.js";
import { AT_CASE_LAW_HIT, DE_LEGISLATION_HIT } from "./fixtures/national.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

const APP = { "x-lexapi-version": "2.16.0" };

function client(fetchMock: typeof fetch, retryReadOnlyPosts = false) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: { ...FAST_RETRY, retryReadOnlyPosts } });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const INCOMPLETE_503 = {
  success: false,
  code: "NATIONAL_SEMANTIC_UNAVAILABLE",
  error: "National semantic search incomplete",
  message: "The Czech Republic (CZ) semantic index could not complete this search in time.",
  jurisdiction: "CZ",
  partialReason: "SEARCH_INCOMPLETE",
  retryAfter: 10,
};

const REPEATED_503 = {
  success: false,
  code: "NATIONAL_SEMANTIC_UNAVAILABLE",
  error: "National semantic search incomplete",
  message: "The Czech Republic (CZ) semantic index has repeatedly been unable to complete this search.",
  jurisdiction: "CZ",
  partialReason: "SEARCH_INCOMPLETE",
};

const UNREACHABLE_422 = {
  success: false,
  code: "NATIONAL_SEMANTIC_FILTER_UNREACHABLE",
  error: "National semantic search cannot cover these filters",
  message: "The Germany (DE) semantic index cannot search this slice completely.",
  jurisdiction: "DE",
  partialReason: "SEARCH_INCOMPLETE",
};

describe("partial national semantic answers (200)", () => {
  it("keeps partial / partialReason / hint on a case-law answer", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        searchType: "semantic-case-law",
        jurisdiction: "AT",
        query: "Datenschutz",
        resultCount: 1,
        results: [AT_CASE_LAW_HIT],
        partial: true,
        partialReason: "SEARCH_INCOMPLETE",
        hint: "The national index did not finish this search. A retry may return a complete answer.",
      }),
    );

    const result = await client(fetchMock).nationalSemanticSearch("AT", { query: "Datenschutz" });

    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe("SEARCH_INCOMPLETE");
    expect(result.hint).toContain("retry");
  });

  it("keeps partial / partialReason on a legislation answer", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        searchType: "semantic-legislation",
        jurisdiction: "DE",
        query: "Haftung",
        resultCount: 1,
        results: [DE_LEGISLATION_HIT],
        partial: true,
        partialReason: "SEARCH_INCOMPLETE",
      }),
    );

    const result = await client(fetchMock).nationalLegislationSemanticSearch("DE", { query: "Haftung" });

    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe("SEARCH_INCOMPLETE");
  });

  it("types the fields as optional", () => {
    expectTypeOf<NationalSemanticCaseLawResponse["partial"]>().toEqualTypeOf<true | undefined>();
    expectTypeOf<NationalSemanticLegislationResponse["partial"]>().toEqualTypeOf<true | undefined>();
    expectTypeOf<"SEARCH_INCOMPLETE">().toMatchTypeOf<NonNullable<NationalSemanticCaseLawResponse["partialReason"]>>();
  });
});

describe("NATIONAL_SEMANTIC_UNAVAILABLE with SEARCH_INCOMPLETE (503)", () => {
  it("is a NationalSemanticUnavailableError, never a RateLimitedError, with retryAfter and partialReason", async () => {
    const fetchMock = fetchSequence(jsonResponse(503, INCOMPLETE_503, { ...APP, "retry-after": "10" }));

    const e = (await caught(client(fetchMock).nationalSemanticSearch("CZ", { query: "liability for damage" }))) as LexAPIError;

    expect(isLexAPIError(e, NationalSemanticUnavailableError)).toBe(true);
    expect(isLexAPIError(e, ServiceUnavailableError)).toBe(true);
    expect(e).not.toBeInstanceOf(RateLimitedError);
    expect(e.code).toBe("NATIONAL_SEMANTIC_UNAVAILABLE");
    expect(e.retryAfter).toBe(10);
    expect((e as NationalSemanticUnavailableError).partialReason).toBe("SEARCH_INCOMPLETE");
    expect((e as NationalSemanticUnavailableError).jurisdiction).toBe("CZ");
    // retryReadOnlyPosts is off: a POST is not retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads retryAfter from the body when the header is missing", async () => {
    const fetchMock = fetchSequence(jsonResponse(503, INCOMPLETE_503, APP));

    const e = (await caught(client(fetchMock).nationalSemanticSearch("CZ", { query: "liability for damage" }))) as LexAPIError;

    expect(e).toBeInstanceOf(NationalSemanticUnavailableError);
    expect(e.retryAfter).toBe(10);
  });

  it("is retried after retryAfter when retryReadOnlyPosts is on", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(503, { ...INCOMPLETE_503, retryAfter: 0 }, { ...APP, "retry-after": "0" }),
      jsonResponse(200, { success: true, jurisdiction: "CZ", resultCount: 0, results: [] }),
    );

    const result = await client(fetchMock, true).nationalSemanticSearch("CZ", { query: "liability for damage" });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is not retried once the server stops sending retryAfter (repeatedly incomplete)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(503, REPEATED_503, APP),
      jsonResponse(200, { success: true, jurisdiction: "CZ", resultCount: 0, results: [] }),
    );

    const e = (await caught(client(fetchMock, true).nationalSemanticSearch("CZ", { query: "liability for damage" }))) as LexAPIError;

    expect(e).toBeInstanceOf(NationalSemanticUnavailableError);
    expect(e.retryAfter).toBeUndefined();
    expect((e as NationalSemanticUnavailableError).partialReason).toBe("SEARCH_INCOMPLETE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is retried at most once per call, even with retryReadOnlyPosts and maxRetries > 1", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(503, { ...INCOMPLETE_503, retryAfter: 0 }, { ...APP, "retry-after": "0" }),
      jsonResponse(503, { ...INCOMPLETE_503, retryAfter: 0 }, { ...APP, "retry-after": "0" }),
      jsonResponse(200, { success: true, jurisdiction: "CZ", resultCount: 0, results: [] }),
    );

    const e = await caught(client(fetchMock, true).nationalSemanticSearch("CZ", { query: "liability for damage" }));

    expect(e).toBeInstanceOf(NationalSemanticUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads partialReason from typed-envelope details too (no wait: not retried)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        503,
        {
          success: false,
          error: {
            code: "NATIONAL_SEMANTIC_UNAVAILABLE",
            message: "National semantic search incomplete",
            details: { jurisdiction: "CZ", partialReason: "SEARCH_INCOMPLETE" },
          },
        },
        APP,
      ),
      jsonResponse(200, { success: true, jurisdiction: "CZ", resultCount: 0, results: [] }),
    );

    const e = (await caught(
      client(fetchMock, true).nationalSemanticSearch("CZ", { query: "liability for damage" }),
    )) as NationalSemanticUnavailableError;

    expect(e).toBeInstanceOf(NationalSemanticUnavailableError);
    expect(e.partialReason).toBe("SEARCH_INCOMPLETE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the plain index-unavailable 503 has no partialReason", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        503,
        { success: false, code: "NATIONAL_SEMANTIC_UNAVAILABLE", error: "National semantic index unavailable", jurisdiction: "AT" },
        APP,
      ),
    );

    const e = (await caught(client(fetchMock).nationalSemanticSearch("AT", { query: "Datenschutz" }))) as NationalSemanticUnavailableError;

    expect(e.partialReason).toBeUndefined();
  });
});

describe("503 with a retry-after is not a rate limit", () => {
  it("a code-less 503 with Retry-After and a body retryAfter is a ServiceUnavailableError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(503, { success: false, error: "Service unavailable", retryAfter: 5 }, { ...APP, "retry-after": "0" }),
      jsonResponse(200, { success: true, celex: "32016R0679" }),
    );
    const c = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: { ...FAST_RETRY, maxRetries: 0 } });

    const e = (await caught(c.getCounterparts("AT-NOR-10001597"))) as LexAPIError;

    expect(e).toBeInstanceOf(ServiceUnavailableError);
    expect(e).not.toBeInstanceOf(RateLimitedError);
    expect(e.code).toBe("SERVICE_UNAVAILABLE");
    // Only the header is read on a code-less 503.
    expect(e.retryAfter).toBe(0);
  });

  it("a code-less app-origin 503 with Retry-After keeps the GET retry policy", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(503, { success: false, error: "Service unavailable", retryAfter: 0 }, { ...APP, "retry-after": "0" }),
      jsonResponse(200, { success: true, celex: "32016R0679" }),
    );

    await client(fetchMock).getCounterparts("AT-NOR-10001597");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("only a 429 is a RateLimitedError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(429, { error: "Rate limit exceeded", retryAfter: 1 }, { "ratelimit-limit": "15" }),
    );
    const c = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: { ...FAST_RETRY, maxRetries: 0 } });

    const e = await caught(c.getCounterparts("AT-NOR-10001597"));

    expect(e).toBeInstanceOf(RateLimitedError);
  });
});

describe("NATIONAL_SEMANTIC_FILTER_UNREACHABLE (422)", () => {
  it("is a NationalSemanticFilterUnreachableError (an InvalidParamsError) with its own code, not retried", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(422, UNREACHABLE_422, APP),
      jsonResponse(200, { success: true, jurisdiction: "DE", resultCount: 0, results: [] }),
    );

    const e = (await caught(
      client(fetchMock, true).nationalLegislationSemanticSearch("DE", { query: "Haftung", filters: { inForce: true } }),
    )) as NationalSemanticFilterUnreachableError;

    expect(isLexAPIError(e, NationalSemanticFilterUnreachableError)).toBe(true);
    expect(isLexAPIError(e, InvalidParamsError)).toBe(true);
    expect(e.name).toBe("NationalSemanticFilterUnreachableError");
    expect(e.code).toBe("NATIONAL_SEMANTIC_FILTER_UNREACHABLE");
    expect(e.status).toBe(422);
    expect(e.jurisdiction).toBe("DE");
    expect(e.partialReason).toBe("SEARCH_INCOMPLETE");
    expect(e.retryAfter).toBeUndefined();
    expect(e.param).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("/resolve verified + eli-cellar", () => {
  it("passes verified and resolvedVia eli-cellar through", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        identifier: "http://data.europa.eu/eli/dec/2019/166/oj",
        identifierType: "eli",
        resolvedVia: "eli-cellar",
        verified: true,
        celex: "32019D0003(01)",
        urls: {},
      }),
    );

    const result = await client(fetchMock).resolve("http://data.europa.eu/eli/dec/2019/166/oj");

    expect(result.resolvedVia).toBe("eli-cellar");
    expect(result.verified).toBe(true);
  });

  it("verified is optional (older servers do not send it)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        identifier: "32016R0679",
        identifierType: "celex",
        resolvedVia: "celex",
        celex: "32016R0679",
        urls: {},
      }),
    );

    const result = await client(fetchMock).resolve("32016R0679");

    expect(result.verified).toBeUndefined();
    expectTypeOf<ResolveResponse["verified"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<"eli-cellar">().toMatchTypeOf<ResolvedVia>();
  });
});
