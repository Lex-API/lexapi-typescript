import { describe, expect, it, vi } from "vitest";

import { LexAPI, TierForbiddenError } from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

function client(fetchMock: typeof fetch) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });
}

function lastBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const CASE_LAW_BODY = {
  success: true,
  searchType: "semantic-case-law",
  query: "transfer of personal data to third countries",
  resultCount: 1,
  results: [
    {
      case_id: "0b7f9c2e-snapshot-uuid",
      score: 0.83,
      text: "Full judgment text...",
      case_name: "Schrems II",
      case_number: "C-311/18",
      ecli: "ECLI:EU:C:2020:559",
      court: "Court of Justice",
      metadata: { celex_id: "62018CJ0311", document_type: "judgment" },
    },
  ],
  tookMs: 412,
  subscription: { tier: "PROFESSIONAL", maxResults: 20 },
  credits: { operation_weight: 5, remaining: 995 },
};

describe("semanticSearch (case law)", () => {
  it("maps camelCase options to the wire shape (min_score, include: ['text'])", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, CASE_LAW_BODY));

    const result = await client(fetchMock).semanticSearch({
      query: "transfer of personal data to third countries",
      limit: 10,
      minScore: 0.6,
      language: "en",
      includeText: true,
    });

    const [url] = fetchMock.mock.calls.at(-1)! as unknown as [string];
    expect(url).toBe("https://lex-api.com/api/v1/search/semantic");
    expect(lastBody(fetchMock)).toEqual({
      query: "transfer of personal data to third countries",
      limit: 10,
      min_score: 0.6,
      language: "en",
      include: ["text"],
    });
    expect(result.results[0]?.metadata?.celex_id).toBe("62018CJ0311");
    expect(result.tookMs).toBe(412);
  });

  it("omits optional params that were not provided (no hyde key by default)", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, CASE_LAW_BODY));

    await client(fetchMock).semanticSearch({ query: "adequacy decision" });

    expect(lastBody(fetchMock)).toEqual({ query: "adequacy decision" });
  });

  it("sends hyde: true and exposes hyde + hypotheticalDocument on the response", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        ...CASE_LAW_BODY,
        hyde: true,
        hypotheticalDocument: "The Court finds that automated credit scoring under Article 22...",
        credits: { operation_weight: 15, remaining: 985 },
      }),
    );

    const result = await client(fetchMock).semanticSearch({
      query: "credit scoring article 22",
      hyde: true,
    });

    expect(lastBody(fetchMock)).toEqual({ query: "credit scoring article 22", hyde: true });
    expect(result.hyde).toBe(true);
    expect(result.hypotheticalDocument).toContain("credit scoring");
    expect(result.credits?.operation_weight).toBe(15);
  });

  it("surfaces the HyDE fallback (hyde: false + refunded base rate)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        ...CASE_LAW_BODY,
        hyde: false, // generation failed; premium auto-refunded
        credits: { operation_weight: 5, remaining: 995 },
      }),
    );

    const result = await client(fetchMock).semanticSearch({ query: "gdpr", hyde: true });

    expect(result.hyde).toBe(false);
    expect(result.hypotheticalDocument).toBeUndefined();
    expect(result.credits?.operation_weight).toBe(5);
  });

  it("exposes the low-confidence hint when present", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        ...CASE_LAW_BODY,
        hint: "Results are low-confidence; rephrase or lower min_score.",
      }),
    );

    const result = await client(fetchMock).semanticSearch({ query: "obscure concept" });

    expect(result.hint).toContain("low-confidence");
  });

  it("maps 403 (plan lacks semantic search) to TierForbiddenError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(403, {
        success: false,
        error: { code: "TIER_FORBIDDEN", message: "Semantic search requires STARTER or above" },
      }),
    );

    await expect(client(fetchMock).semanticSearch({ query: "gdpr" })).rejects.toThrow(
      TierForbiddenError,
    );
  });
});

describe("semanticLegislationSearch", () => {
  it("POSTs to /legislation/semantic and returns article-level matches", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        searchType: "semantic-legislation",
        query: "right to be forgotten",
        resultCount: 1,
        results: [
          {
            score: 0.91,
            text: "The data subject shall have the right to obtain...",
            article_ref: "Article 17",
            law_id: "32016R0679",
            law_title: "GDPR",
            metadata: {},
          },
        ],
        tookMs: 130,
      }),
    );

    const result = await client(fetchMock).semanticLegislationSearch({
      query: "right to be forgotten",
      limit: 5,
      minScore: 0.5,
    });

    const [url] = fetchMock.mock.calls.at(-1)! as unknown as [string];
    expect(url).toBe("https://lex-api.com/api/v1/legislation/semantic");
    expect(lastBody(fetchMock)).toEqual({ query: "right to be forgotten", limit: 5, min_score: 0.5 });
    expect(result.results[0]?.article_ref).toBe("Article 17");
    expect(result.results[0]?.law_id).toBe("32016R0679");
  });
});
