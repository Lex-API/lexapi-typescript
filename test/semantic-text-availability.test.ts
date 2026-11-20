import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  LexAPI,
  type EuSemanticCaseLawResult,
  type NationalSemanticCaseLawResult,
  type SemanticCaseLawResult,
  type SemanticHitTextAvailability,
  type SemanticHitTextUnavailableReason,
  type TextAvailability,
  type TextUnavailableReason,
} from "../src/index.js";
import { FAST_RETRY, jsonResponse } from "./helpers.js";

const BASE_URL = "http://127.0.0.1:9/api/v1";

/** A fetch stub that answers `body` and refuses any URL outside the local base URL. */
function stub(body: unknown) {
  return vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
    if (!String(url).startsWith(`${BASE_URL}/`)) throw new Error(`unexpected URL ${String(url)}`);
    return jsonResponse(200, body);
  });
}

function client(fetchMock: ReturnType<typeof stub>) {
  return new LexAPI({
    apiKey: "lex_test_key",
    baseUrl: BASE_URL,
    fetch: fetchMock as unknown as typeof fetch,
    retry: FAST_RETRY,
  });
}

function sentBody(fetchMock: ReturnType<typeof stub>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const HIT = {
  case_id: "snapshot-uuid",
  score: 0.82,
  case_name: "Schrems II",
  ecli: "ECLI:EU:C:2020:559",
  metadata: { celex_id: "62018CJ0311", document_type: "judgment" },
};

function body(results: unknown[]) {
  return { success: true, searchType: "semantic-case-law", resultCount: results.length, results };
}

describe("SemanticHitTextAvailability (types)", () => {
  it("is an optional field of the case-law hit, kept apart from the document type", () => {
    expectTypeOf<SemanticCaseLawResult["textAvailability"]>().toEqualTypeOf<
      SemanticHitTextAvailability | undefined
    >();
    expectTypeOf<EuSemanticCaseLawResult["textAvailability"]>().toEqualTypeOf<
      SemanticHitTextAvailability | undefined
    >();
    expectTypeOf<SemanticHitTextAvailability["available"]>().toEqualTypeOf<boolean>();
    expectTypeOf<SemanticHitTextAvailability["reason"]>().toEqualTypeOf<
      SemanticHitTextUnavailableReason | undefined
    >();
    expectTypeOf<SemanticHitTextAvailability>().not.toEqualTypeOf<TextAvailability>();
    expectTypeOf<SemanticHitTextUnavailableReason>().not.toEqualTypeOf<TextUnavailableReason>();
    // Inherited at the type level; the national route does not send it.
    expectTypeOf<NationalSemanticCaseLawResult["textAvailability"]>().toEqualTypeOf<
      SemanticHitTextAvailability | undefined
    >();
  });

  it("keeps the reason open: documented values and a future one type-check", () => {
    const known: SemanticHitTextUnavailableReason[] = ["not_in_corpus", "unknown"];
    const future: SemanticHitTextUnavailableReason = "some_future_reason";
    const value: SemanticHitTextAvailability = { available: false, reason: future };
    expectTypeOf(known).toEqualTypeOf<SemanticHitTextUnavailableReason[]>();
    expectTypeOf(value.reason).toEqualTypeOf<SemanticHitTextUnavailableReason | undefined>();
    const present: SemanticHitTextAvailability = { available: true };
    expectTypeOf(present).toEqualTypeOf<SemanticHitTextAvailability>();
  });
});

describe("semanticSearch textAvailability (API 2.30.0)", () => {
  it("passes through a hit that carries text", async () => {
    const hit = { ...HIT, text: "Full judgment text...", textAvailability: { available: true } };
    const fetchMock = stub(body([hit]));
    const res = await client(fetchMock).semanticSearch({ query: "data transfers", includeText: true });
    expect(sentBody(fetchMock)["include"]).toEqual(["text"]);
    const first = res.results[0]!;
    expect(first.textAvailability).toEqual({ available: true });
    expect(first.text).toBe("Full judgment text...");
    expect(first.snippet).toBeUndefined();
  });

  it("passes through not_in_corpus with the snippet kept", async () => {
    const hit = {
      ...HIT,
      snippet: "The Court held that the decision is invalid...",
      textAvailability: { available: false, reason: "not_in_corpus" },
    };
    const res = await client(stub(body([hit]))).semanticSearch({ query: "data transfers", includeText: true });
    const first = res.results[0]!;
    expect(first.textAvailability).toEqual({ available: false, reason: "not_in_corpus" });
    expect(first.snippet).toBe("The Court held that the decision is invalid...");
    expect(first.text).toBeUndefined();
    if (first.textAvailability?.available === false && first.textAvailability.reason === "not_in_corpus") {
      expect(first.metadata?.celex_id).toBe("62018CJ0311");
    } else {
      throw new Error("expected not_in_corpus");
    }
  });

  it("passes through unknown", async () => {
    const hit = { ...HIT, snippet: "Summary head", textAvailability: { available: false, reason: "unknown" } };
    const res = await client(stub(body([hit]))).semanticSearch({ query: "q", includeText: true });
    expect(res.results[0]!.textAvailability).toEqual({ available: false, reason: "unknown" });
  });

  it("passes an unknown future reason through unchanged", async () => {
    const hit = { ...HIT, snippet: "Summary head", textAvailability: { available: false, reason: "a_future_reason" } };
    const res = await client(stub(body([hit]))).semanticSearch({ query: "q", includeText: true });
    const reason: SemanticHitTextUnavailableReason | undefined = res.results[0]!.textAvailability?.reason;
    expect(reason).toBe("a_future_reason");
  });

  it("leaves the field absent without includeText", async () => {
    const hit = { ...HIT, snippet: "Preview" };
    const fetchMock = stub(body([hit]));
    const res = await client(fetchMock).semanticSearch({ query: "q" });
    expect(sentBody(fetchMock)).not.toHaveProperty("include");
    expect(res.results[0]).not.toHaveProperty("textAvailability");
    expect(res.results[0]!.snippet).toBe("Preview");
  });

  it("does not shape-check hit fields: a malformed textAvailability is returned as received", async () => {
    // SDK contract §1.3: hit fields are not shape-checked; the SDK passes them through.
    const hits = [
      { ...HIT, textAvailability: "yes" },
      { ...HIT, textAvailability: { reason: "unknown" } },
    ];
    const res = await client(stub(body(hits))).semanticSearch({ query: "q", includeText: true });
    expect(res.results[0]!["textAvailability"]).toBe("yes");
    expect(res.results[1]!["textAvailability"]).toEqual({ reason: "unknown" });
  });
});
