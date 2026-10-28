import { describe, expect, it, vi } from "vitest";

import {
  DocumentWithdrawnError,
  isLexAPIError,
  LexAPI,
  NationalAllowanceExhaustedError,
  NationalSemanticNotEnabledError,
  NationalSemanticUnavailableError,
  NotFoundError,
  ServiceUnavailableError,
  TimeoutError,
  type NationalSemanticLegislationOptions,
} from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

function client(fetchMock: typeof fetch) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
}

const ALLOWANCE_HEADERS = {
  "x-national-limit": "30",
  "x-national-remaining": "29",
  "x-national-reset": "2026-11-01T00:00:00.000Z",
};

describe("getNationalCoverage", () => {
  it("GETs /national/coverage with no query, and keeps the real documents/from shape (int year or null, never a string)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        updatedAt: "2026-10-28T00:00:00.000Z",
        jurisdictions: [
          {
            code: "AT",
            name: "Austria",
            live: true,
            launchedAt: "2026-11-03T00:00:00.000Z",
            // legislation.from is always null today (not a date/year string).
            legislation: { available: true, description: "Federal legislation", documents: 12000, from: null },
            // caseLaw.from is an integer year (firstHeld), or null.
            caseLaw: { available: true, description: "Federal courts", documents: 4000, from: 2000, courts: ["Verfassungsgerichtshof"] },
            semanticSearch: { legislation: true, caseLaw: true },
            sources: [{ name: "RIS", url: "https://ris.bka.gv.at", licence: "CC BY 4.0", attribution: "Data source: RIS, Bundeskanzleramt Österreich." }],
            lastSyncAt: "2026-10-27T03:00:00.000Z",
          },
          // A dark (in-preparation) jurisdiction: unavailable sections carry
          // `documents: null`, `description: ""` and empty `courts`/`sources` — never omitted.
          {
            code: "ES",
            name: "Spain",
            live: false,
            launchedAt: null,
            legislation: { available: false, description: "", documents: null, from: null },
            caseLaw: { available: false, description: "", documents: null, from: null, courts: [] },
            semanticSearch: { legislation: false, caseLaw: false },
            sources: [],
            lastSyncAt: null,
          },
        ],
      }),
    );

    const result = await client(fetchMock).getNationalCoverage();

    const [url] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/national/coverage");
    expect(result.jurisdictions).toHaveLength(2);
    expect(result.jurisdictions[0]?.code).toBe("AT");
    expect(result.jurisdictions[0]?.legislation.from).toBeNull();
    expect(result.jurisdictions[0]?.caseLaw.from).toBe(2000);
    expect(result.jurisdictions[0]?.sources[0]?.attribution).toContain("RIS");
    expect(result.jurisdictions[1]?.live).toBe(false);
    expect(result.jurisdictions[1]?.legislation.documents).toBeNull();
  });
});

describe("getNationalDocument", () => {
  it("GETs /{jurisdiction}/documents/{id}, lower-cased, with language query, and parses nationalAllowance headers", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        {
          document: {
            id: "AT-NOR-12345",
            jurisdiction: "AT",
            language: "de",
            title: "Datenschutzgesetz",
            documentType: "Bundesgesetz",
            version: 3,
            fetchedAt: "2026-10-20T00:00:00.000Z",
            content: { fullText: "§ 1..." },
            textAvailability: { available: true },
            attribution: "Data source: RIS, Bundeskanzleramt Österreich.",
          },
          credits: { operation_weight: 1, remaining: 29 },
        },
        ALLOWANCE_HEADERS,
      ),
    );

    const result = await client(fetchMock).getNationalDocument("AT", "AT-NOR-12345", { language: "de" });

    const [url] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/at/documents/AT-NOR-12345?language=de");
    expect(result.document.id).toBe("AT-NOR-12345");
    expect(result.document.attribution).toContain("RIS");
    expect(result.credits?.operation_weight).toBe(1);
    expect(result.headers?.nationalAllowance).toEqual({ limit: 30, remaining: 29, resetsAt: "2026-11-01T00:00:00.000Z" });
  });

  it("lower-cases an upper-case jurisdiction code and URL-encodes the id", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { document: { id: "DE-X/1", jurisdiction: "DE", language: "de", version: 1, attribution: "x" } }),
    );

    await client(fetchMock).getNationalDocument("DE", "DE-X/1");

    const [url] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/de/documents/DE-X%2F1");
  });
});

describe("listNationalDocuments", () => {
  it("GETs /{jurisdiction}/documents with page/limit/q/type/includeRepealed (type maps to documentType)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        jurisdiction: "AT",
        total: 2,
        totalExact: true,
        page: 1,
        limit: 20,
        includeRepealed: false,
        hasMore: false,
        nextCursor: null,
        results: [
          { id: "AT-NOR-1", jurisdiction: "AT", language: "de", title: "A", version: 1, fetchedAt: "2026-10-01T00:00:00.000Z" },
          { id: "AT-NOR-2", jurisdiction: "AT", language: "de", title: "B", version: 2, fetchedAt: "2026-10-02T00:00:00.000Z" },
        ],
      }),
    );

    const result = await client(fetchMock).listNationalDocuments("AT", { q: "Datenschutz", documentType: "Gesetz", limit: 20, page: 1, includeRepealed: true });

    const [url] = lastCall(fetchMock);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/at/documents");
    expect(parsed.searchParams.get("q")).toBe("Datenschutz");
    expect(parsed.searchParams.get("type")).toBe("Gesetz");
    expect(parsed.searchParams.get("limit")).toBe("20");
    expect(parsed.searchParams.get("page")).toBe("1");
    expect(parsed.searchParams.get("includeRepealed")).toBe("true");
    expect(result.total).toBe(2);
    expect(result.totalExact).toBe(true);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.results).toHaveLength(2);
  });

  it("sends cursor instead of page, and omits page from the query when unset", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        jurisdiction: "AT", total: 1200, totalExact: false, limit: 20, includeRepealed: false,
        hasMore: true, nextCursor: "eyJhIjoxfQ", results: [],
      }),
    );
    const result = await client(fetchMock).listNationalDocuments("AT", { cursor: "abc123" });
    const parsed = new URL(lastCall(fetchMock)[0]);
    expect(parsed.searchParams.get("cursor")).toBe("abc123");
    expect(parsed.searchParams.has("page")).toBe(false);
    expect(result.page).toBeUndefined();
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("eyJhIjoxfQ");
  });

  it("paginateNationalDocuments walks pages via nextCursor and stops on hasMore: false", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        jurisdiction: "AT", total: 3, totalExact: true, limit: 2, includeRepealed: false,
        hasMore: true, nextCursor: "c1",
        results: [{ id: "AT-NOR-1", jurisdiction: "AT", language: "de", version: 1, fetchedAt: "2026-10-01T00:00:00.000Z" }],
      }),
      jsonResponse(200, {
        jurisdiction: "AT", total: 3, totalExact: true, limit: 2, includeRepealed: false,
        hasMore: false, nextCursor: null,
        results: [{ id: "AT-NOR-2", jurisdiction: "AT", language: "de", version: 1, fetchedAt: "2026-10-02T00:00:00.000Z" }],
      }),
    );
    const seen: string[] = [];
    for await (const page of client(fetchMock).paginateNationalDocuments("AT", { limit: 2 })) {
      seen.push(...page.results.map((r) => r.id!));
    }
    expect(seen).toEqual(["AT-NOR-1", "AT-NOR-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [secondCallUrl] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const secondUrl = new URL(secondCallUrl);
    expect(secondUrl.searchParams.get("cursor")).toBe("c1");
  });

  it("a page past the first 1,000 rows via `page` is a 400 InvalidParamsError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(400, {
        success: false,
        error: { code: "INVALID_PARAMS", message: "page reaches past the first 1000 results — page further with cursor (each page's nextCursor)" },
      }),
    );
    await expect(client(fetchMock).listNationalDocuments("AT", { page: 51, limit: 20 })).rejects.toThrow(/page/i);
  });

  it("a slow page is a retry-safe 504 TimeoutError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(504, { success: false, error: { code: "TIMEOUT", message: "The listing took too long. Narrow it (q, type) and retry." } }),
    );
    const err = await client(fetchMock).listNationalDocuments("AT", { q: "x".repeat(3) }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.status).toBe(504);
  });
});

describe("DocumentWithdrawnError (410, lex-api PR #320)", () => {
  it("getNationalDocument: typed envelope, details nested", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(410, {
        success: false,
        error: {
          code: "DOCUMENT_WITHDRAWN",
          message: "AT document AT-NOR-5 was withdrawn by its source and is no longer served",
          details: { id: "AT-NOR-5", jurisdiction: "AT", withdrawnAt: "2026-10-20T00:00:00.000Z" },
        },
      }),
    );
    const err = await client(fetchMock).getNationalDocument("AT", "AT-NOR-5").catch((e) => e);
    expect(err).toBeInstanceOf(DocumentWithdrawnError);
    expect(err.status).toBe(410);
    expect(err.id).toBe("AT-NOR-5");
    expect(err.jurisdiction).toBe("AT");
    expect(err.withdrawnAt).toBe("2026-10-20T00:00:00.000Z");
  });

  it("citation routes: legacy shape, id/jurisdiction/withdrawnAt as top-level siblings — still readable via the same getters", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(410, {
        success: false,
        code: "DOCUMENT_WITHDRAWN",
        error: "Document withdrawn: AT-NOR-5",
        message: "AT document AT-NOR-5 was withdrawn by its source and is no longer served.",
        id: "AT-NOR-5",
        jurisdiction: "AT",
        withdrawnAt: "2026-10-20T00:00:00.000Z",
      }),
    );
    const err = await client(fetchMock).getCites("AT-NOR-5").catch((e) => e);
    expect(err).toBeInstanceOf(DocumentWithdrawnError);
    expect(err.id).toBe("AT-NOR-5");
    expect(err.jurisdiction).toBe("AT");
    expect(err.withdrawnAt).toBe("2026-10-20T00:00:00.000Z");
  });
});

describe("legislation semantic never sends hyde, even if injected on the request object", () => {
  it("strips a bypassed hyde field from the wire body", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, searchType: "semantic-legislation", jurisdiction: "AT", results: [] }),
    );
    const bypassed = { query: "Kündigungsfrist", hyde: true } as NationalSemanticLegislationOptions & { hyde?: boolean };
    await client(fetchMock).nationalLegislationSemanticSearch("AT", bypassed);
    const [, init] = lastCall(fetchMock);
    const body = JSON.parse(init.body as string);
    expect(body.hyde).toBeUndefined();
  });
});

describe("nationalSemanticSearch", () => {
  it("POSTs /{jurisdiction}/search/semantic, maps camelCase options to the wire shape, and keeps national fields", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        searchType: "semantic-case-law",
        jurisdiction: "AT",
        query: "Datenschutz bei Bankgeschäften",
        resultCount: 1,
        results: [
          {
            score: 0.81,
            snippet: "…",
            case_number: "12 Os 1/20",
            metadata: { celex_id: "AT-JUD-OGH-1" },
            documentId: "AT-JUD-OGH-1",
            jurisdiction: "AT",
            attribution: "Data source: RIS.",
          },
        ],
        hyde: false,
        attribution: "Data source: RIS.",
        tookMs: 120,
        subscription: { tier: "FREE", maxResults: 10 },
      }),
    );

    const result = await client(fetchMock).nationalSemanticSearch("at", {
      query: "Datenschutz bei Bankgeschäften",
      hyde: true,
      includeText: true,
      filters: { court: "OGH" },
    });

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/at/search/semantic");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "Datenschutz bei Bankgeschäften",
      include: ["text"],
      filters: { court: "OGH" },
      hyde: true,
    });
    expect(result.results[0]?.documentId).toBe("AT-JUD-OGH-1");
    expect(result.results[0]?.attribution).toContain("RIS");
    // hyde was requested but the national index never rewrites.
    expect(result.hyde).toBe(false);
  });
});

describe("nationalLegislationSemanticSearch", () => {
  it("POSTs /{jurisdiction}/legislation/semantic and preserves the server's snake_case in_force/valid_to", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        searchType: "semantic-legislation",
        jurisdiction: "DE",
        query: "Kündigungsfrist",
        resultCount: 1,
        results: [
          {
            score: 0.77,
            law_id: "DE-BGB-622",
            article_ref: "622",
            documentId: "DE-BGB-622",
            jurisdiction: "DE",
            in_force: false,
            valid_to: "2020-01-01",
            attribution: "Source: gesetze-im-internet.de.",
          },
        ],
        attribution: "Source: gesetze-im-internet.de.",
        subscription: { tier: "STARTER", maxResults: 20 },
      }),
    );

    const result = await client(fetchMock).nationalLegislationSemanticSearch("DE", {
      query: "Kündigungsfrist",
      filters: { inForce: true },
    });

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/de/legislation/semantic");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "Kündigungsfrist",
      filters: { inForce: true },
    });
    const hit = result.results[0]!;
    expect(hit.in_force).toBe(false);
    expect(hit.valid_to).toBe("2020-01-01");
    expect(hit.documentId).toBe("DE-BGB-622");
  });
});

describe("NationalAllowanceExhaustedError", () => {
  it("is thrown for a 402 NATIONAL_ALLOWANCE_EXHAUSTED response with typed details", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        402,
        {
          success: false,
          error: {
            code: "NATIONAL_ALLOWANCE_EXHAUSTED",
            message: "This month's national-law allowance of 30 calls on the FREE plan is used up.",
            details: {
              jurisdiction: "AT",
              limit: 30,
              remaining: 0,
              resetsAt: "2026-11-01T00:00:00.000Z",
              upgradeUrl: "/pricing",
            },
          },
        },
        { "x-national-limit": "30", "x-national-remaining": "0", "x-national-reset": "2026-11-01T00:00:00.000Z" },
      ),
    );

    let thrown: unknown;
    try {
      await client(fetchMock).getNationalDocument("AT", "AT-NOR-1");
    } catch (err) {
      thrown = err;
    }
    expect(isLexAPIError(thrown, NationalAllowanceExhaustedError)).toBe(true);
    const e = thrown as NationalAllowanceExhaustedError;
    expect(e.status).toBe(402);
    expect(e.jurisdiction).toBe("AT");
    expect(e.limit).toBe(30);
    expect(e.remaining).toBe(0);
    expect(e.resetsAt).toBe("2026-11-01T00:00:00.000Z");
    expect(e.upgradeUrl).toBe("/pricing");
    // A used-up allowance is a usage shortfall, not a transient failure — never retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Errors carry the parsed response headers too (X-National-* on the 402 itself).
    expect(e.headers?.nationalAllowance).toEqual({ limit: 30, remaining: 0, resetsAt: "2026-11-01T00:00:00.000Z" });
  });
});

describe("NationalSemanticNotEnabledError (409)", () => {
  it("is thrown with the legacy-shape body's top-level jurisdiction, and is not retried", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(409, {
        success: false,
        code: "NATIONAL_SEMANTIC_NOT_ENABLED",
        error: "National semantic search not enabled",
        message: "Semantic search over Austria (AT) is not enabled yet. No credits were charged.",
        jurisdiction: "AT",
      }),
    );

    let thrown: unknown;
    try {
      await client(fetchMock).nationalSemanticSearch("AT", { query: "Datenschutz" });
    } catch (err) {
      thrown = err;
    }

    expect(isLexAPIError(thrown, NationalSemanticNotEnabledError)).toBe(true);
    const e = thrown as NationalSemanticNotEnabledError;
    expect(e.status).toBe(409);
    expect(e.code).toBe("NATIONAL_SEMANTIC_NOT_ENABLED");
    expect(e.jurisdiction).toBe("AT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("NationalSemanticUnavailableError (503)", () => {
  it("is thrown, stays instanceof ServiceUnavailableError, and exposes jurisdiction", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        503,
        {
          success: false,
          code: "NATIONAL_SEMANTIC_UNAVAILABLE",
          error: "National semantic index unavailable",
          message: "The Austria (AT) semantic index is temporarily unavailable. No credits were charged. Please try again later.",
          jurisdiction: "AT",
        },
        { "retry-after": "0" },
      ),
      jsonResponse(200, { success: true, searchType: "semantic-case-law", jurisdiction: "AT", query: "x", resultCount: 0, results: [] }),
    );

    // retryReadOnlyPosts is off by default, so a 503 on this read-only POST is not retried —
    // disable retries entirely so the single attempt surfaces the typed error deterministically.
    const c = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: { ...FAST_RETRY, maxRetries: 0 } });

    let thrown: unknown;
    try {
      await c.nationalSemanticSearch("AT", { query: "Datenschutz" });
    } catch (err) {
      thrown = err;
    }

    expect(isLexAPIError(thrown, NationalSemanticUnavailableError)).toBe(true);
    expect(isLexAPIError(thrown, ServiceUnavailableError)).toBe(true);
    const e = thrown as NationalSemanticUnavailableError;
    expect(e.status).toBe(503);
    expect(e.code).toBe("NATIONAL_SEMANTIC_UNAVAILABLE");
    expect(e.jurisdiction).toBe("AT");
  });
});

describe("typed national-document 404", () => {
  it("keeps error.details { id, jurisdiction } from the typed NOT_FOUND envelope", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(404, {
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "No AT document found with id AT-NOR-99999999",
          details: { id: "AT-NOR-99999999", jurisdiction: "AT" },
        },
      }),
    );

    let thrown: unknown;
    try {
      await client(fetchMock).getNationalDocument("AT", "AT-NOR-99999999");
    } catch (err) {
      thrown = err;
    }

    expect(isLexAPIError(thrown, NotFoundError)).toBe(true);
    const e = thrown as NotFoundError;
    expect(e.details).toEqual({ id: "AT-NOR-99999999", jurisdiction: "AT" });
  });
});
