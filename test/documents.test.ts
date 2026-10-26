import { describe, expect, it, vi } from "vitest";

import { LexAPI, NotFoundError, InvalidUrlError, UpstreamError } from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

function client(fetchMock: typeof fetch) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
}

const SEARCH_BODY = {
  searchParameters: { query: "GDPR", documentType: "regulation" },
  totalResults: 245,
  totalPages: 25,
  pagesFetched: 1,
  resultCount: 10,
  results: [
    {
      title: "Regulation (EU) 2016/679",
      celexNumber: "32016R0679",
      celex: "32016R0679",
      form: "Regulation",
      documentType: "Regulation",
      documentTypeCode: "regulation",
      date: "2016-04-27",
      dateOfDocumentISO: "2016-04-27",
      author: "European Parliament and Council",
      availableLanguages: ["EN", "FR"],
      url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679",
    },
  ],
  subscription: { tier: "STARTER" },
  usage: { current: 3, limit: 5000, remaining: 4997, unit: "credits" },
  credits: { operation_weight: 3, remaining: 4997 },
  fetchedAt: "2026-07-02T10:00:00.000Z",
};

const DOCUMENT = {
  celex: "32016R0679",
  celexNumber: "32016R0679",
  title: "Regulation (EU) 2016/679 (GDPR)",
  documentType: "Regulation",
  documentTypeCode: "regulation",
  author: "European Parliament and Council",
  dateOfDocument: "27/04/2016",
  dateOfDocumentISO: "2016-04-27",
  ecli: null,
  eli: "data.europa.eu/eli/reg/2016/679",
  caseNumber: null,
  parties: null,
  keywords: ["personal data"],
  language: "en",
  content: {
    fullText: "...",
    articles: [{ id: "art_17", number: "Article 17", title: "Right to erasure", content: "..." }],
    recitals: [{ number: 1, text: "The protection of natural persons..." }],
    paragraphs: [],
    sections: [{ type: "chapter", number: "I", title: "General provisions", articleRange: ["art_1", "art_4"] }],
    tables: [],
    annexes: [],
  },
  urls: { html: "https://eur-lex.europa.eu/...", metadata: "https://eur-lex.europa.eu/..." },
};

describe("search", () => {
  it("POSTs the filters and returns typed results", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, SEARCH_BODY));
    const result = await client(fetchMock).search({
      query: "GDPR",
      documentType: "regulation",
      maxPages: 1,
    });

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "GDPR",
      documentType: "regulation",
      maxPages: 1,
    });
    expect(result.results?.[0]?.celex).toBe("32016R0679");
    expect(result.results?.[0]?.availableLanguages).toEqual(["EN", "FR"]);
    expect(result.totalResults).toBe(245);
    expect(result.xWarning).toBeUndefined();
  });

  it("surfaces truncation and partial signals from the body", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        ...SEARCH_BODY,
        truncated: true,
        truncatedAt: 10,
        truncatedReason: "Tier STARTER permits 5 pages; 25 pages exist for this query.",
        partial: true,
        partialReason: "Fetch of page 4 of 5 failed (FetchTimeoutError); 3 page(s) collected before the failure.",
        postFilteredBy: "author,date",
      }),
    );

    const result = await client(fetchMock).search({ query: "GDPR" });

    expect(result.truncated).toBe(true);
    expect(result.truncatedAt).toBe(10);
    expect(result.truncatedReason).toContain("STARTER");
    expect(result.partial).toBe(true);
    expect(result.partialReason).toContain("FetchTimeoutError");
    expect(result.postFilteredBy).toBe("author,date");
  });

  it("surfaces the X-Warning header as xWarning", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, SEARCH_BODY, { "x-warning": "maxPages clamped to 5 for tier STARTER" }),
    );

    const result = await client(fetchMock).search({ query: "GDPR", maxPages: 50 });

    expect(result.xWarning).toBe("maxPages clamped to 5 for tier STARTER");
  });

  it("retries on 429, and on 502 because search is a read-only POST (5xx is refunded)", async () => {
    const rateLimited = jsonResponse(429, { success: false, error: { code: "RATE_LIMITED", message: "slow down" } });
    const ok = jsonResponse(200, SEARCH_BODY);
    const fetchMock = fetchSequence(rateLimited, ok);
    await expect(client(fetchMock).search({ query: "GDPR" })).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const upstream = jsonResponse(502, { success: false, error: { code: "UPSTREAM_ERROR", message: "EUR-Lex down" } });
    const fetchMock2 = fetchSequence(upstream, ok);
    await expect(client(fetchMock2).search({ query: "GDPR" })).resolves.toBeTruthy();
    expect(fetchMock2).toHaveBeenCalledTimes(2);
  });

  it("does not retry search on 502 when retryReadOnlyPosts is off", async () => {
    const upstream = jsonResponse(502, { success: false, error: { code: "UPSTREAM_ERROR", message: "EUR-Lex down" } });
    const fetchMock = fetchSequence(upstream, jsonResponse(200, SEARCH_BODY));
    const strict = new LexAPI({
      apiKey: "lex_test_key",
      fetch: fetchMock,
      retry: { ...FAST_RETRY, retryReadOnlyPosts: false },
    });
    await expect(strict.search({ query: "GDPR" })).rejects.toThrow(UpstreamError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends fresh and surfaces hint, cache and source headers", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        {
          ...SEARCH_BODY,
          totalResults: 0,
          resultCount: 0,
          results: [],
          hint: "No results. EUR-Lex keyword search is literal — try fewer terms, or use semantic search",
        },
        {
          "x-search-source": "soap",
          "x-search-cache": "bypass",
          "x-ignored-documenttypes": "frobnicate,other",
          "x-documenttype-fanout": "4",
          "ratelimit-limit": "60",
          "ratelimit-remaining": "59",
          "ratelimit-reset": "42",
          "ratelimit-policy": "60;w=60",
        },
      ),
    );

    const result = await client(fetchMock).search({ query: "*", year: 2024, fresh: true });

    expect(JSON.parse(lastCall(fetchMock)[1].body as string)).toEqual({ query: "*", year: 2024, fresh: true });
    expect(result.hint).toContain("semantic search");
    expect(result.headers?.searchSource).toBe("soap");
    expect(result.headers?.searchCache).toBe("bypass");
    expect(result.headers?.ignoredDocumentTypes).toEqual(["frobnicate", "other"]);
    expect(result.headers?.documentTypeFanOut).toBe(4);
    expect(result.headers?.rateLimit).toEqual({ limit: 60, remaining: 59, reset: 42, policy: "60;w=60" });
  });

  it("surfaces the labelled corpus fallback (source: corpus, partial)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        {
          ...SEARCH_BODY,
          partial: true,
          partialReason: "EUR-Lex is unreachable (...); served from the LexAPI corpus mirror instead.",
          source: "corpus",
        },
        { "x-search-source": "corpus", "x-search-cache": "miss" },
      ),
    );

    const result = await client(fetchMock).search({ query: "GDPR" });

    expect(result.source).toBe("corpus");
    expect(result.partial).toBe(true);
    expect(result.headers?.searchSource).toBe("corpus");
  });
});

describe("getDocument", () => {
  it("POSTs the CELEX with payload-control params and returns the parsed document", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, document: DOCUMENT, subscription: { tier: "STARTER" } }),
    );

    const result = await client(fetchMock).getDocument({
      celexNumber: "32016R0679",
      language: "en",
      include: ["metadata", "articles"],
      articleId: "17",
    });

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/documentContent");
    expect(JSON.parse(init.body as string)).toEqual({
      celexNumber: "32016R0679",
      language: "en",
      include: ["metadata", "articles"],
      articleId: "17",
    });
    expect(result.success).toBe(true);
    expect(result.document.content?.articles?.[0]?.id).toBe("art_17");
    expect(result.document.content?.sections?.[0]?.articleRange).toEqual(["art_1", "art_4"]);
  });

  it("maps 404 to NotFoundError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(404, {
        success: false,
        error: { code: "NOT_FOUND", message: "Document 39999X9999 does not exist on EUR-Lex" },
      }),
    );

    await expect(client(fetchMock).getDocument({ celexNumber: "39999X9999" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("getDocumentsBatch", () => {
  it("surfaces trimming signals (body + X-Warning header) and per-CELEX errors", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        {
          success: true,
          requested: 7,
          processed: 5,
          successful: 4,
          failed: 1,
          trimmed: true,
          trimmedTo: 5,
          trimmedReason: "Batch size limited to 5 for tier STARTER",
          documents: [DOCUMENT],
          errors: [{ celexNumber: "69999XX9999", error: "FetchTimeoutError", message: "upstream timed out" }],
        },
        { "x-warning": "Batch size limited to 5 for tier STARTER" },
      ),
    );

    const result = await client(fetchMock).getDocumentsBatch({
      celexNumbers: ["32016R0679", "62018CJ0311"],
    });

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/documentContent/batch");
    expect(JSON.parse(init.body as string).celexNumbers).toEqual(["32016R0679", "62018CJ0311"]);
    expect(result.trimmed).toBe(true);
    expect(result.trimmedTo).toBe(5);
    expect(result.xWarning).toBe("Batch size limited to 5 for tier STARTER");
    expect(result.errors[0]?.error).toBe("FetchTimeoutError");
  });
});

describe("getRecentDocuments", () => {
  it("serializes filters as query params on GET", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, results: [], resultCount: 0, totalResults: 0 }),
    );

    await client(fetchMock).getRecentDocuments({
      days: 14,
      documentType: "judgment",
      author: "court-of-justice",
      language: "fr",
      limit: 25,
    });

    const [url, init] = lastCall(fetchMock);
    expect(init.method).toBe("GET");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/documents/recent");
    expect(parsed.searchParams.get("days")).toBe("14");
    expect(parsed.searchParams.get("documentType")).toBe("judgment");
    expect(parsed.searchParams.get("author")).toBe("court-of-justice");
    expect(parsed.searchParams.get("language")).toBe("fr");
    expect(parsed.searchParams.get("limit")).toBe("25");
    expect(parsed.searchParams.has("domain")).toBe(false); // undefined params omitted
  });

  it("works with no params and surfaces languageFilter", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        results: [],
        languageFilter: { requested: "EN", kept: 8, beforeFilter: 10 },
      }),
    );

    const result = await client(fetchMock).getRecentDocuments();

    expect(lastCall(fetchMock)[0]).toBe("https://lex-api.com/api/v1/documents/recent");
    expect(result.languageFilter?.kept).toBe(8);
  });
});

describe("getDocumentByUrl", () => {
  it("echoes back sourceUrl and extractedCelex", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679",
        extractedCelex: "32016R0679",
        document: DOCUMENT,
      }),
    );

    const result = await client(fetchMock).getDocumentByUrl({
      url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679",
    });

    expect(lastCall(fetchMock)[0]).toBe("https://lex-api.com/api/v1/documents/url");
    expect(result.extractedCelex).toBe("32016R0679");
    expect(result.document.celex).toBe("32016R0679");
  });

  it("maps INVALID_URL to InvalidUrlError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(400, {
        success: false,
        error: { code: "INVALID_URL", message: "URL had no resolvable CELEX" },
      }),
    );

    await expect(
      client(fetchMock).getDocumentByUrl({ url: "https://example.com/nope" }),
    ).rejects.toThrow(InvalidUrlError);
  });
});

describe("getDocumentMetadata", () => {
  it("returns metadata with URLs and no content", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        metadata: {
          celex: "32016R0679",
          celexNumber: "32016R0679",
          title: "Regulation (EU) 2016/679 (GDPR)",
          documentTypeCode: "regulation",
          urls: {
            html: "https://eur-lex.europa.eu/html",
            metadata: "https://eur-lex.europa.eu/all",
            pdf: "https://eur-lex.europa.eu/pdf",
            xml: "https://eur-lex.europa.eu/xml",
          },
        },
      }),
    );

    const result = await client(fetchMock).getDocumentMetadata({ celexNumber: "32016R0679" });

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/documents/metadata");
    expect(JSON.parse(init.body as string)).toEqual({ celexNumber: "32016R0679" });
    expect(result.metadata.urls?.pdf).toBe("https://eur-lex.europa.eu/pdf");
  });
});

describe("resolve", () => {
  it("wraps the identifier in the request body", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        identifier: "ECLI:EU:C:2020:559",
        identifierType: "ecli",
        resolvedVia: "ecli",
        celex: "62018CJ0311",
        urls: { html: "https://eur-lex.europa.eu/html" },
      }),
    );

    const result = await client(fetchMock).resolve("ECLI:EU:C:2020:559");

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/resolve");
    expect(JSON.parse(init.body as string)).toEqual({ identifier: "ECLI:EU:C:2020:559" });
    expect(result.celex).toBe("62018CJ0311");
    expect(result.resolvedVia).toBe("ecli");
  });

  it("maps 404 (identifier did not resolve) to NotFoundError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(404, {
        success: false,
        error: { code: "NOT_FOUND", message: "ECLI not in corpus" },
      }),
    );

    await expect(client(fetchMock).resolve("ECLI:EU:C:1900:1")).rejects.toThrow(NotFoundError);
  });
});

describe("text availability, language labels and source headers (2026-08 → 2026-10 API)", () => {
  it("returns content: null with a textAvailability verdict and consolidated pointers", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        {
          success: true,
          document: {
            ...DOCUMENT,
            celex: "32008R1272",
            content: null,
            textAvailability: {
              available: false,
              reason: "too_large",
              retryable: false,
              availableLanguages: null,
              source: "parse-worker",
              latestConsolidated: { celex: "02008R1272-20260701", date: "2026-07-01", source: "cellar" },
              upcomingConsolidated: { celex: "02008R1272-20270101", date: "2027-01-01", source: "cellar" },
            },
          },
        },
        { "x-text-available": "false", "x-source": "live", "x-language": "en" },
      ),
    );

    const { document, headers } = await client(fetchMock).getDocument({ celexNumber: "32008R1272" });

    expect(document.content).toBeNull();
    expect(document.textAvailability?.available).toBe(false);
    expect(document.textAvailability?.reason).toBe("too_large");
    expect(document.textAvailability?.availableLanguages).toBeNull();
    expect(document.textAvailability?.latestConsolidated?.celex).toBe("02008R1272-20260701");
    expect(document.textAvailability?.upcomingConsolidated?.date).toBe("2027-01-01");
    expect(headers?.textAvailable).toBe(false);
    expect(headers?.source).toBe("live");
  });

  it("sends acceptLanguages and surfaces the fallback labels, titleLanguage and source headers", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        {
          success: true,
          document: {
            ...DOCUMENT,
            celex: "62019TJ0123",
            language: "fr",
            languageRequested: "en",
            languageFallback: "fr",
            title: "Arrêt du Tribunal",
            titleLanguage: "fr",
            textAvailability: { available: true },
          },
        },
        {
          "x-source": "cellar",
          "x-language": "fr",
          "x-language-fallback": "fr",
          "x-corpus-version": "3",
          "x-corpus-fetchedat": "2026-10-01T00:00:00.000Z",
          "x-cache": "miss",
        },
      ),
    );

    const result = await client(fetchMock).getDocument({
      celexNumber: "62019TJ0123",
      language: "en",
      acceptLanguages: ["fr", "de"],
    });

    expect(JSON.parse(lastCall(fetchMock)[1].body as string)).toEqual({
      celexNumber: "62019TJ0123",
      language: "en",
      acceptLanguages: ["fr", "de"],
    });
    expect(result.document.languageFallback).toBe("fr");
    expect(result.document.titleLanguage).toBe("fr");
    expect(result.headers).toMatchObject({
      source: "cellar",
      language: "fr",
      languageFallback: "fr",
      corpusVersion: 3,
      corpusFetchedAt: "2026-10-01T00:00:00.000Z",
      cache: "miss",
    });
  });

  it("accepts acceptLanguages: 'any' on the batch endpoint and surfaces textUnavailable + source split", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        {
          success: true,
          requested: 3,
          processed: 3,
          successful: 3,
          failed: 0,
          textUnavailable: 1,
          documents: [
            { ...DOCUMENT, titleLanguage: "en" },
            { ...DOCUMENT, celex: "62018CJ0311" },
            { ...DOCUMENT, celex: "32019D0003(01)", content: null, textAvailability: { available: false, reason: "not_in_language", availableLanguages: ["es", "it"] } },
          ],
          errors: [],
        },
        {
          "x-batch-corpus-hits": "1",
          "x-batch-cellar-served": "1",
          "x-batch-oj-recovered": "0",
          "x-batch-live-fetches": "1",
          "x-batch-text-unavailable": "1",
        },
      ),
    );

    const result = await client(fetchMock).getDocumentsBatch({
      celexNumbers: ["32016R0679", "62018CJ0311", "32019D0003(01)"],
      acceptLanguages: "any",
    });

    expect(JSON.parse(lastCall(fetchMock)[1].body as string).acceptLanguages).toBe("any");
    expect(result.textUnavailable).toBe(1);
    expect(result.documents[0]?.titleLanguage).toBe("en");
    expect(result.documents[2]?.textAvailability?.availableLanguages).toEqual(["es", "it"]);
    expect(result.headers?.batch).toEqual({
      corpusHits: 1,
      cellarServed: 1,
      ojRecovered: 0,
      liveFetches: 1,
      textUnavailable: 1,
    });
  });

  it("returns titleLanguage and consolidated hints on metadata", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        {
          success: true,
          metadata: {
            celex: "32006R1907",
            celexNumber: "32006R1907",
            title: "Regulation (EC) No 1907/2006 (REACH)",
            titleLanguage: "en",
            author: null,
            latestConsolidated: { celex: "02006R1907-20260622", date: "2026-06-22", source: "cellar" },
            newestConsolidated: { celex: "02006R1907-20260622", date: "2026-06-22", source: "cellar", availableLanguages: ["et"] },
            urls: { html: "h", metadata: "m", pdf: "p", xml: "x" },
          },
        },
        { "x-source": "corpus", "x-corpus-version": "2" },
      ),
    );

    const result = await client(fetchMock).getDocumentMetadata({ celexNumber: "32006R1907", bypassCorpus: false });

    expect(result.metadata.titleLanguage).toBe("en");
    expect(result.metadata.author).toBeNull();
    expect(result.metadata.latestConsolidated?.celex).toBe("02006R1907-20260622");
    expect(result.metadata.newestConsolidated?.availableLanguages).toEqual(["et"]);
    expect(result.headers?.source).toBe("corpus");
    // corpusVersion is only lifted to the top level on the version endpoints
    expect((result as { corpusVersion?: number }).corpusVersion).toBeUndefined();
    expect(result.headers?.corpusVersion).toBe(2);
  });

  it("forwards bypassCorpus on getDocumentByUrl", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        sourceUrl: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
        extractedCelex: "32016R0679",
        document: DOCUMENT,
      }),
    );

    await client(fetchMock).getDocumentByUrl({
      url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
      bypassCorpus: true,
    });

    expect(JSON.parse(lastCall(fetchMock)[1].body as string)).toEqual({
      url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
      bypassCorpus: true,
    });
  });

  it("sends multi-value recent filters as repeated query params", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        {
          success: true,
          results: [],
          languageFilter: { requested: "FR", kept: 8, beforeFilter: 10, partialMetadataKept: 2 },
        },
        { "x-source": "live", "x-language-filter": "FR", "x-language-kept": "8/10" },
      ),
    );

    const result = await client(fetchMock).getRecentDocuments({
      documentType: ["regulation", "directive"],
      author: ["commission"],
      subdomain: "LEGISLATION",
      language: "fr",
    });

    const url = new URL(lastCall(fetchMock)[0]);
    expect(url.searchParams.getAll("documentType")).toEqual(["regulation", "directive"]);
    expect(url.searchParams.getAll("author")).toEqual(["commission"]);
    expect(url.searchParams.get("subdomain")).toBe("LEGISLATION");
    expect(result.languageFilter?.partialMetadataKept).toBe(2);
    expect(result.headers?.languageFilter).toBe("FR");
    expect(result.headers?.languageKept).toBe("8/10");
  });

  it("types corpus-backed resolution paths (ecli-corpus / eli-corpus)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        identifier: "ECLI:EU:C:2020:559",
        identifierType: "ecli",
        resolvedVia: "ecli-corpus",
        celex: "62018CJ0311",
        urls: { metadata: "m", html: "h", pdf: "p", xml: "x" },
        credits: { operation_weight: 1, remaining: 99 },
      }),
    );

    const result = await client(fetchMock).resolve("ECLI:EU:C:2020:559");

    expect(result.resolvedVia).toBe("ecli-corpus");
    expect(result.credits?.operation_weight).toBe(1);
  });
});
