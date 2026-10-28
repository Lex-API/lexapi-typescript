import { describe, expect, it, vi } from "vitest";

import { LexAPI, NotFoundError, RateLimitedError, RequestAbortedError, TierForbiddenError } from "../src/index.js";
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
      jsonResponse(502, { success: false, error: { code: "UPSTREAM_ERROR", message: "flaky" } }, { "ratelimit-limit": "60" }),
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

describe("citations — 2026-10 additions", () => {
  it("types corrigendum edges, titleSource and relationSync on cited-by, and forwards language", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        targetDocument: "32008R1272",
        totalCitations: 2,
        uniqueDocuments: 2,
        limit: 100,
        offset: 0,
        citedBy: [
          {
            celexNumber: "32008R1272R(01)",
            title: "Rectificatif",
            titleSource: "citation-source",
            citationCount: 1,
            citations: [{ citationType: "corrigendum", contextSnippet: null }],
          },
        ],
        relationSync: { source: "cellar", status: "pending", syncedAt: "2026-10-07T09:12:00.000Z" },
      }),
    );

    const result = await client(fetchMock).getCitedBy("32008R1272", { citationType: "corrigendum", language: "fr" });

    const url = new URL(lastCall(fetchMock)[0]);
    expect(url.searchParams.get("citationType")).toBe("corrigendum");
    expect(url.searchParams.get("language")).toBe("fr");
    expect(result.citedBy[0]?.citations?.[0]?.citationType).toBe("corrigendum");
    expect(result.citedBy[0]?.titleSource).toBe("citation-source");
    expect(result.relationSync?.status).toBe("pending");
  });

  it("surfaces relationSync with a skipped reason on the network", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        document: "62018CJ0311",
        network: { celexNumber: "62018CJ0311", citesCount: 0, citedByCount: 0, cites: [], citedBy: [] },
        paging: { limit: 100, offset: 0, citesTotal: 0, citedByTotal: 0 },
        relationSync: { source: "cellar", status: "skipped", reason: "not-applicable", syncedAt: null },
      }),
    );

    const result = await client(fetchMock).getCitationNetwork("62018CJ0311", { language: "de" });

    expect(new URL(lastCall(fetchMock)[0]).searchParams.get("language")).toBe("de");
    expect(result.relationSync).toEqual({ source: "cellar", status: "skipped", reason: "not-applicable", syncedAt: null });
  });

  it("forwards language on path and related, and types titleSource", async () => {
    const pathMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        from: "32016R0679",
        to: "31995L0046",
        found: true,
        pathLength: 1,
        maxDepth: 4,
        path: [
          { celexNumber: "32016R0679", title: "GDPR", titleSource: "corpus" },
          { celexNumber: "31995L0046", title: "Directive 95/46/EC", titleSource: "corpus-fallback-lang" },
        ],
      }),
    );
    const path = await client(pathMock).getCitationPath("32016R0679", "31995L0046", { maxDepth: 4, language: "it" });
    const pathUrl = new URL(lastCall(pathMock)[0]);
    expect(pathUrl.searchParams.get("maxDepth")).toBe("4");
    expect(pathUrl.searchParams.get("language")).toBe("it");
    expect(path.path[1]?.titleSource).toBe("corpus-fallback-lang");

    const relatedMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        celexNumber: "32016R0679",
        method: "bibliographic-coupling",
        count: 1,
        related: [{ celexNumber: "32016L0680", sharedCount: 9, titleSource: "corpus" }],
      }),
    );
    await client(relatedMock).getRelatedDocuments("32016R0679", { limit: 5, language: "it" });
    const relatedUrl = new URL(lastCall(relatedMock)[0]);
    expect(relatedUrl.searchParams.get("limit")).toBe("5");
    expect(relatedUrl.searchParams.get("language")).toBe("it");
  });

  it("paginates cited-by in raw-row offsets until a short page", async () => {
    const page = (celex: string, offset: number, rows: number) =>
      jsonResponse(200, {
        success: true,
        targetDocument: "32016R0679",
        totalCitations: 5,
        limit: 2,
        offset,
        citedBy: [{ celexNumber: celex, citationCount: rows, citations: [] }],
      });
    const fetchMock = fetchSequence(page("A", 0, 2), page("B", 2, 2), page("C", 4, 1));

    const seen: string[] = [];
    for await (const p of client(fetchMock).paginateCitedBy("32016R0679", { limit: 2 })) {
      seen.push(...p.citedBy.map((g) => g.celexNumber!));
    }

    expect(seen).toEqual(["A", "B", "C"]);
    const offsets = fetchMock.mock.calls.map((c) => new URL((c as unknown as [string])[0]).searchParams.get("offset"));
    expect(offsets).toEqual(["0", "2", "4"]);
  });

  it("keeps paginating past totalCitations when raw rows outnumber distinct pairs (review S8)", async () => {
    // 150 raw rows forming 90 distinct pairs: totalCitations (90) < limit (100),
    // but the first page is full (100 raw rows), so a second page exists.
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true, targetDocument: "X", totalCitations: 90, limit: 100, offset: 0,
        citedBy: [{ celexNumber: "A", citationCount: 60 }, { celexNumber: "B", citationCount: 40 }],
      }),
      jsonResponse(200, {
        success: true, targetDocument: "X", totalCitations: 90, limit: 100, offset: 100,
        citedBy: [{ celexNumber: "B", citationCount: 50 }],
      }),
    );

    const pages: number[] = [];
    for await (const p of client(fetchMock).paginateCitedBy("X")) pages.push(p.citedBy.length);

    expect(pages).toEqual([2, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops paginating cites on an empty page", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, sourceDocument: "X", limit: 100, offset: 0, cites: [{ celexNumber: "Y", citationCount: 100 }] }),
      jsonResponse(200, { success: true, sourceDocument: "X", limit: 100, offset: 100, cites: [] }),
    );

    let pages = 0;
    for await (const _p of client(fetchMock).paginateCites("32016R0679")) pages++;

    expect(pages).toBe(2);
  });
});

describe("includeNational (citation graph + national ids, API 2.5.0)", () => {
  it("sends includeNational on getCites / getCitedBy and keeps it in the response", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, sourceDocument: "AT-NOR-10001597", cites: [], includeNational: true }),
      jsonResponse(200, { success: true, targetDocument: "AT-NOR-10001597", citedBy: [], includeNational: true }),
    );
    const c = client(fetchMock);

    const cites = await c.getCites("AT-NOR-10001597", { includeNational: true });
    expect(new URL(lastCall(fetchMock)[0]).searchParams.get("includeNational")).toBe("true");
    expect(cites.includeNational).toBe(true);

    const citedBy = await c.getCitedBy("AT-NOR-10001597", { includeNational: true });
    expect(new URL(lastCall(fetchMock)[0]).searchParams.get("includeNational")).toBe("true");
    expect(citedBy.includeNational).toBe(true);
  });

  it("sends includeNational on getCitationNetwork, getCitationPath, getRelatedDocuments and getCitationStats", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true, document: "32016R0679",
        network: { celexNumber: "32016R0679", citesCount: 0, citedByCount: 0, cites: [], citedBy: [] },
        paging: { limit: 100, offset: 0, citesTotal: 0, citedByTotal: 0 },
        includeNational: true,
      }),
      jsonResponse(200, { success: true, from: "32016R0679", to: "AT-NOR-10001597", found: false, path: [], includeNational: true }),
      jsonResponse(200, { success: true, celexNumber: "32016R0679", method: "bibliographic-coupling", count: 0, related: [], includeNational: true }),
      jsonResponse(200, { success: true, stats: { totalCitations: 0, uniqueSourceDocuments: 0, uniqueTargetDocuments: 0, mostCited: [], mostCiting: [] }, includeNational: true }),
    );
    const c = client(fetchMock);

    const network = await c.getCitationNetwork("32016R0679", { includeNational: true });
    expect(new URL(lastCall(fetchMock)[0]).searchParams.get("includeNational")).toBe("true");
    expect(network.includeNational).toBe(true);

    const path = await c.getCitationPath("32016R0679", "AT-NOR-10001597", { includeNational: true });
    expect(new URL(lastCall(fetchMock)[0]).searchParams.get("includeNational")).toBe("true");
    expect(path.includeNational).toBe(true);

    const related = await c.getRelatedDocuments("32016R0679", { includeNational: true });
    expect(new URL(lastCall(fetchMock)[0]).searchParams.get("includeNational")).toBe("true");
    expect(related.includeNational).toBe(true);

    const stats = await c.getCitationStats({ includeNational: true });
    expect(new URL(lastCall(fetchMock)[0]).searchParams.get("includeNational")).toBe("true");
    expect(stats.includeNational).toBe(true);
  });

  it("getCitationStats still works with no params at all (back-compat)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, stats: { totalCitations: 1, uniqueSourceDocuments: 1, uniqueTargetDocuments: 1, mostCited: [], mostCiting: [] } }),
    );
    const stats = await client(fetchMock).getCitationStats();
    expect(stats.includeNational).toBeUndefined();
    expect(new URL(lastCall(fetchMock)[0]).searchParams.get("includeNational")).toBeNull();
  });

  it("getCitationStats(options) — a 0.2.0-shaped single CallOptions argument is still honoured as options, not silently read as params (review round 2)", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, { success: true, stats: {} }));
    // A JS-shaped (or non-literal-variable) 0.2.0 call: getCitationStats({ signal }).
    // If `signal` were silently read as `params.signal` instead of `options.signal`,
    // the abort would be ignored and the call would go through to fetch.
    const legacyCallOptions = { signal: AbortSignal.abort() };
    await expect(client(fetchMock).getCitationStats(legacyCallOptions)).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getCitationStats({ includeNational }, options) — the two-argument form still forwards options", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, { success: true, stats: {} }));
    await expect(
      client(fetchMock).getCitationStats({ includeNational: true }, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includeNational=true below BUSINESS is a 403 TierForbiddenError (legacy shape, upgradeUrl)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(403, {
        success: false,
        code: "TIER_FORBIDDEN",
        error: "National-law access requires a BUSINESS plan or higher",
        message: "National documents in citation results are available on the BUSINESS, SCALE and ENTERPRISE plans. Your current plan: STARTER.",
        upgradeUrl: "/pricing",
      }),
    );
    const err = await client(fetchMock).getCitedBy("32016R0679", { includeNational: true }).catch((e) => e);
    expect(err).toBeInstanceOf(TierForbiddenError);
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ upgradeUrl: "/pricing" });
  });

  it("a national id of a jurisdiction that is not live is a 404 NotFoundError (legacy shape, top-level code since #320)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(404, { success: false, code: "NOT_FOUND", error: "Document not found: XX-NOR-99999999" }),
    );
    const err = await client(fetchMock).getCites("XX-NOR-99999999").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("Document not found: XX-NOR-99999999");
  });
});
