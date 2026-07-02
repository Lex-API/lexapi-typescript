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

  it("retries on 429 but not on 502 (non-idempotent POST)", async () => {
    const rateLimited = jsonResponse(429, { success: false, error: { code: "RATE_LIMITED", message: "slow down" } });
    const ok = jsonResponse(200, SEARCH_BODY);
    const fetchMock = fetchSequence(rateLimited, ok);
    await expect(client(fetchMock).search({ query: "GDPR" })).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const upstream = jsonResponse(502, { success: false, error: { code: "UPSTREAM_ERROR", message: "EUR-Lex down" } });
    const fetchMock2 = fetchSequence(upstream, ok);
    await expect(client(fetchMock2).search({ query: "GDPR" })).rejects.toThrow(UpstreamError);
    expect(fetchMock2).toHaveBeenCalledTimes(1);
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
