import { describe, expect, it, vi } from "vitest";

import { isLexAPIError, LexAPI, NationalAllowanceExhaustedError } from "../src/index.js";
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
  it("GETs /national/coverage with no query", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        updatedAt: "2026-10-28T00:00:00.000Z",
        jurisdictions: [
          {
            code: "AT",
            name: "Austria",
            live: true,
            launchedAt: "2026-11-03T00:00:00.000Z",
            legislation: { available: true, documents: 12000, from: "1945" },
            caseLaw: { available: true, documents: 4000, courts: ["Verfassungsgerichtshof"] },
            semanticSearch: { legislation: true, caseLaw: true },
            sources: [{ name: "RIS", url: "https://ris.bka.gv.at", licence: "CC BY 4.0", attribution: "Data source: RIS, Bundeskanzleramt Österreich." }],
            lastSyncAt: "2026-10-27T03:00:00.000Z",
          },
          { code: "ES", name: "Spain", live: false, legislation: { available: false }, caseLaw: { available: false }, semanticSearch: { legislation: false, caseLaw: false }, sources: [] },
        ],
      }),
    );

    const result = await client(fetchMock).getNationalCoverage();

    const [url] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/national/coverage");
    expect(result.jurisdictions).toHaveLength(2);
    expect(result.jurisdictions[0]?.code).toBe("AT");
    expect(result.jurisdictions[0]?.sources[0]?.attribution).toContain("RIS");
    expect(result.jurisdictions[1]?.live).toBe(false);
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
        page: 1,
        limit: 20,
        includeRepealed: false,
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
    expect(result.results).toHaveLength(2);
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
  });
});
