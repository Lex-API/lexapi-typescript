import { describe, expect, it, vi } from "vitest";

import { LexAPI, RateLimitedError } from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

function client(fetchMock: typeof fetch) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
}

describe("extractCitations", () => {
  it("POSTs the CELEX and returns extracted edges", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        message: "Extracted 42 citations",
        document: { celexNumber: "32016R0679", title: "GDPR" },
        citationCount: 42,
        citations: [
          { targetCelex: "31995L0046", citationType: "repeal", contextSnippet: "Directive 95/46/EC is repealed" },
        ],
        alreadyExtracted: false,
      }),
    );

    const result = await client(fetchMock).extractCitations("32016R0679");

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/citations/extract");
    expect(JSON.parse(init.body as string)).toEqual({ celexNumber: "32016R0679" });
    expect(result.citationCount).toBe(42);
    expect(result.citations?.[0]?.citationType).toBe("repeal");
  });

  it("reports idempotent re-extraction via alreadyExtracted", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, citationCount: 42, citations: [], alreadyExtracted: true }),
    );

    const result = await client(fetchMock).extractCitations("32016R0679");

    expect(result.alreadyExtracted).toBe(true);
    expect(result.citations).toEqual([]);
  });
});

describe("cites / cited-by", () => {
  it("GETs outbound edges with citationType/limit/offset query params", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        sourceDocument: "32016R0679",
        totalCitations: 3,
        uniqueDocuments: 1,
        limit: 50,
        offset: 0,
        cites: [
          {
            celexNumber: "31995L0046",
            title: "Data Protection Directive",
            citationCount: 3,
            citations: [{ citationType: "repeal", contextSnippet: null, extractedAt: "2026-06-01T00:00:00.000Z" }],
          },
        ],
      }),
    );

    const result = await client(fetchMock).getCites("32016R0679", {
      citationType: "repeal",
      limit: 50,
      offset: 0,
    });

    const parsed = new URL(lastCall(fetchMock)[0]);
    expect(parsed.pathname).toBe("/api/v1/citations/cites/32016R0679");
    expect(parsed.searchParams.get("citationType")).toBe("repeal");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(parsed.searchParams.get("offset")).toBe("0");
    expect(result.cites[0]?.citations?.[0]?.citationType).toBe("repeal");
  });

  it("GETs inbound edges and encodes the path segment", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, targetDocument: "32016R0679", citedBy: [] }),
    );

    const result = await client(fetchMock).getCitedBy("32016R0679");

    expect(lastCall(fetchMock)[0]).toBe(
      "https://lex-api.com/api/v1/citations/cited-by/32016R0679",
    );
    expect(result.citedBy).toEqual([]);
  });
});

describe("getCitationNetwork", () => {
  it("returns both directions with paging totals", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        document: "62018CJ0311",
        network: {
          celexNumber: "62018CJ0311",
          citesCount: 1,
          citedByCount: 1,
          cites: [{ celexNumber: "32016R0679", title: "GDPR", count: 4, types: ["reference"] }],
          citedBy: [{ celexNumber: "62020CJ0000", title: null, count: 1, types: ["reference"] }],
        },
        paging: { limit: 100, offset: 0, citesTotal: 4, citedByTotal: 1 },
      }),
    );

    const result = await client(fetchMock).getCitationNetwork("62018CJ0311", { limit: 100 });

    expect(result.network.cites[0]?.types).toEqual(["reference"]);
    expect(result.paging.citesTotal).toBe(4);
  });

  it("surfaces the partial-timeout contract (empty network, null totals)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        document: "62018CJ0311",
        network: { celexNumber: "62018CJ0311", citesCount: 0, citedByCount: 0, cites: [], citedBy: [] },
        paging: { limit: 100, offset: 0, citesTotal: null, citedByTotal: null },
        partial: true,
        partialReason: "TIMEOUT",
        message: "Citation network for 62018CJ0311 exceeded the 30000ms server-side budget.",
        timeoutMs: 30000,
      }),
    );

    const result = await client(fetchMock).getCitationNetwork("62018CJ0311");

    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe("TIMEOUT");
    expect(result.paging.citesTotal).toBeNull();
  });
});

describe("getCitationPath / getRelatedDocuments / getCitationStats", () => {
  it("builds the two-segment path URL with maxDepth", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        from: "32016R0679",
        to: "31995L0046",
        found: true,
        pathLength: 1,
        maxDepth: 5,
        path: [
          { celexNumber: "32016R0679", title: "GDPR" },
          { celexNumber: "31995L0046", title: "Data Protection Directive" },
        ],
      }),
    );

    const result = await client(fetchMock).getCitationPath("32016R0679", "31995L0046", { maxDepth: 5 });

    const parsed = new URL(lastCall(fetchMock)[0]);
    expect(parsed.pathname).toBe("/api/v1/citations/path/32016R0679/31995L0046");
    expect(parsed.searchParams.get("maxDepth")).toBe("5");
    expect(result.found).toBe(true);
    expect(result.path).toHaveLength(2);
  });

  it("treats found:false as a graceful 200, not an error", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        from: "32016R0679",
        to: "99999X9999",
        found: false,
        pathLength: null,
        maxDepth: 3,
        path: [],
        message: "No citation path from 32016R0679 to 99999X9999 within 3 hops",
      }),
    );

    const result = await client(fetchMock).getCitationPath("32016R0679", "99999X9999");

    expect(result.found).toBe(false);
    expect(result.pathLength).toBeNull();
    expect(result.message).toContain("No citation path");
  });

  it("returns bibliographic-coupling neighbours", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        celexNumber: "32016R0679",
        method: "bibliographic-coupling",
        seedCitationCount: 42,
        count: 1,
        related: [{ celexNumber: "32018R1725", title: "EUDPR", sharedCount: 12, sharedTargets: ["31995L0046"] }],
      }),
    );

    const result = await client(fetchMock).getRelatedDocuments("32016R0679", { limit: 10 });

    const parsed = new URL(lastCall(fetchMock)[0]);
    expect(parsed.pathname).toBe("/api/v1/citations/related/32016R0679");
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(result.related[0]?.sharedCount).toBe(12);
  });

  it("fetches global stats", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        stats: {
          totalCitations: 1000,
          uniqueSourceDocuments: 100,
          uniqueTargetDocuments: 400,
          mostCited: [{ celexNumber: "31995L0046", title: null, citedByCount: 77 }],
          mostCiting: [{ celexNumber: "32016R0679", title: "GDPR", citesCount: 42 }],
        },
      }),
    );

    const result = await client(fetchMock).getCitationStats();

    expect(lastCall(fetchMock)[0]).toBe("https://lex-api.com/api/v1/citations/stats");
    expect(result.stats.mostCited[0]?.citedByCount).toBe(77);
  });
});

describe("citation GET retry semantics", () => {
  it("retries GET /citations/stats on 502", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(502, { success: false, error: { code: "UPSTREAM_ERROR", message: "flaky" } }),
      jsonResponse(200, { success: true, stats: { totalCitations: 0, uniqueSourceDocuments: 0, uniqueTargetDocuments: 0, mostCited: [], mostCiting: [] } }),
    );

    await client(fetchMock).getCitationStats();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps 429 on extract to RateLimitedError after retries exhaust", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(429, { success: false, error: { code: "RATE_LIMITED", message: "slow down" } }),
    );

    await expect(client(fetchMock).extractCitations("32016R0679")).rejects.toThrow(RateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(1 + FAST_RETRY.maxRetries);
  });
});
