import { describe, expect, it, vi } from "vitest";

import {
  AS_OF_REASONS,
  CreditsExhaustedError,
  InvalidParamsError,
  LexAPI,
  TierForbiddenError,
  type AsOfReason,
} from "../src/index.js";
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

describe("semanticSearch — current result shape", () => {
  it("types the default snippet, structured fields and semanticUsage.unitsCharged", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        ...CASE_LAW_BODY,
        results: [
          {
            case_id: "ECLI_EU_C_2024_785_en_c0007",
            score: 0.764,
            jurisdiction: "EU",
            language: "en",
            case_name: "Land Hessen",
            court: "Court of Justice",
            decision_date: "2024-09-26",
            parties: "Land Hessen v TR",
            summary: "The Court examined whether…",
            snippet: "The Court examined whether, under the GDPR…",
            outcome: "upheld",
            metadata: { celex_id: "62021CJ0768", document_type: "judgment", paragraph_number: 12 },
          },
        ],
        semanticUsage: { current: 3, limit: 100, remaining: 97, unitsCharged: 1 },
      }),
    );

    const result = await client(fetchMock).semanticSearch({ query: "breach notification" });
    const hit = result.results[0]!;

    expect(hit.snippet).toContain("GDPR");
    expect(hit.text).toBeUndefined();
    expect(hit.decision_date).toBe("2024-09-26");
    expect(hit.metadata?.paragraph_number).toBe(12);
    expect(hit.outcome).toBe("upheld");
    expect(result.semanticUsage?.unitsCharged).toBe(1);
    expect(result.subscription?.maxResults).toBe(20);
  });
});

const CONSOLIDATED_HIT = {
  id: "c1d2",
  score: 0.88,
  snippet: "Institutions shall at all times satisfy the following own funds requirements…",
  article_ref: "art_92",
  law_id: "02013R0575-20240709",
  law_title: "Regulation (EU) No 575/2013 (consolidated)",
  language: "en",
  consolidated: true,
  consolidatedAsOf: "2024-07-09",
  baseCelex: "32013R0575",
  consolidatedNote:
    "The act as amended, consolidated as of 2024-07-09; not the authentic text. Only the Official Journal text is authentic.",
  baseAct: { law_id: "32013R0575", article_ref: "art_92", score: 0.84 },
  metadata: {},
};

describe("semanticLegislationSearch — consolidated merge + asOf (#284 / lex-api PR #298)", () => {
  it("omits asOf from the wire body when not provided", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, searchType: "semantic-legislation", results: [CONSOLIDATED_HIT] }),
    );

    const result = await client(fetchMock).semanticLegislationSearch({ query: "own funds requirements" });

    expect(lastBody(fetchMock)).toEqual({ query: "own funds requirements" });
    const hit = result.results[0]!;
    expect(hit.consolidated).toBe(true);
    expect(hit.consolidatedAsOf).toBe("2024-07-09");
    expect(hit.baseCelex).toBe("32013R0575");
    expect(hit.consolidatedNote).toContain("not the authentic text");
    expect(hit.baseAct).toEqual({ law_id: "32013R0575", article_ref: "art_92", score: 0.84 });
    expect(result.asOf).toBeUndefined();
    expect(result.asOfSummary).toBeUndefined();
  });

  it("sends asOf alongside the other options and surfaces every asOf field", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        searchType: "semantic-legislation",
        query: "own funds requirements",
        resultCount: 3,
        results: [
          {
            ...CONSOLIDATED_HIT,
            id: "asof:02013R0575-20190627:art_92",
            law_id: "02013R0575-20190627",
            consolidatedAsOf: "2019-06-27",
            chapter: null,
            section: "Own funds requirements",
            asOf: "2019-06-01",
            asOfResolved: true,
            asOfVersion: { celex: "02013R0575-20190627", date: "2019-06-27", kind: "consolidated" },
            matchedVersion: { id: "c1d2", law_id: "02013R0575-20240709", consolidatedAsOf: "2024-07-09" },
          },
          {
            id: "b7",
            score: 0.71,
            snippet: "…",
            article_ref: "art_3",
            law_id: "32016R0679",
            asOf: "2019-06-01",
            asOfResolved: true,
            asOfVersion: { celex: "32016R0679", date: null, kind: "as_published" },
          },
          {
            id: "z9",
            score: 0.69,
            snippet: "…",
            article_ref: "art_1",
            law_id: "32024R1689",
            asOf: "2019-06-01",
            asOfResolved: false,
            asOfReason: "not_yet_adopted",
          },
        ],
        asOf: "2019-06-01",
        asOfSummary: { liveFetches: 1, unresolved: 1 },
        tookMs: 2400,
        subscription: { tier: "PROFESSIONAL", maxResults: 50 },
        credits: { operation_weight: 9, remaining: 991 },
      }),
    );

    const result = await client(fetchMock).semanticLegislationSearch({
      query: "own funds requirements",
      asOf: "2019-06-01",
      limit: 3,
      minScore: 0.5,
      language: "en",
      includeText: false,
    });

    const [url] = fetchMock.mock.calls.at(-1)! as unknown as [string];
    expect(url).toBe("https://lex-api.com/api/v1/legislation/semantic");
    expect(lastBody(fetchMock)).toEqual({
      query: "own funds requirements",
      limit: 3,
      min_score: 0.5,
      language: "en",
      asOf: "2019-06-01",
    });

    expect(result.asOf).toBe("2019-06-01");
    expect(result.asOfSummary).toEqual({ liveFetches: 1, unresolved: 1 });

    const [swapped, asPublished, unresolved] = result.results;
    expect(swapped?.asOfResolved).toBe(true);
    expect(swapped?.asOfVersion).toEqual({ celex: "02013R0575-20190627", date: "2019-06-27", kind: "consolidated" });
    expect(swapped?.matchedVersion?.law_id).toBe("02013R0575-20240709");
    expect(swapped?.chapter).toBeNull();
    expect(asPublished?.asOfVersion?.kind).toBe("as_published");
    expect(asPublished?.asOfVersion?.date).toBeNull();
    expect(unresolved?.asOfResolved).toBe(false);
    expect(unresolved?.asOfReason).toBe("not_yet_adopted");
  });

  it("maps an invalid asOf (legacy-shape 400) to InvalidParamsError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(400, { error: "Invalid asOf", message: "asOf cannot be in the future" }),
    );

    const error = await client(fetchMock)
      .semanticLegislationSearch({ query: "gdpr", asOf: "2999-01-01" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidParamsError);
    expect((error as InvalidParamsError).message).toContain("asOf cannot be in the future");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps the search-admission 402 to CreditsExhaustedError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(402, {
        success: false,
        error: {
          code: "CREDITS_EXHAUSTED",
          message: "Credit pool exhausted",
          details: { operation: "semantic_legis", weight: 5, available: 2, resetsAt: "2026-11-01T00:00:00.000Z" },
        },
      }),
    );

    const error = await client(fetchMock)
      .semanticLegislationSearch({ query: "gdpr", asOf: "2020-01-01" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CreditsExhaustedError);
    expect((error as CreditsExhaustedError).operation).toBe("semantic_legis");
    expect((error as CreditsExhaustedError).weight).toBe(5);
    expect((error as CreditsExhaustedError).available).toBe(2);
  });

  it("exports the asOfReason enum exactly as openapi.yaml lists it", () => {
    // Copied verbatim from SemanticLegislationResult.asOfReason in lex-api openapi.yaml @ 633eb67.
    const spec = [
      "not_yet_adopted", "not_yet_in_force", "no_longer_in_force", "in_force_dates_unknown",
      "not_in_language", "text_unavailable", "article_not_in_version", "part_not_resolvable",
      "article_unknown", "version_list_unavailable", "version_lookup_cap", "fetch_budget_exhausted",
      "fetch_pending", "fetch_capacity", "fetch_failed", "fetch_timeout", "request_deadline",
      "insufficient_credits", "credit_check_failed",
    ];
    expect([...AS_OF_REASONS]).toEqual(spec);
    const typed: AsOfReason[] = [...AS_OF_REASONS];
    expect(typed).toHaveLength(19);
  });
});
