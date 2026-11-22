import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  AS_OF_LOOKUP_REASONS,
  InvalidCelexError,
  InvalidParamsError,
  LexAPI,
  NotFoundError,
  VERSION,
  type AsOfLookupReason,
  type LegislationAsOfProvision,
  type LegislationAsOfRequest,
  type LegislationAsOfResponse,
  type LegislationAsOfVersion,
} from "../src/index.js";
import { FAST_RETRY, jsonResponse } from "./helpers.js";

const BASE_URL = "http://127.0.0.1:9/api/v1";

/** A fetch stub that answers `response` and refuses any URL outside the local base URL. */
function stub(response: Response) {
  return vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
    if (!String(url).startsWith(`${BASE_URL}/`)) throw new Error(`unexpected URL ${String(url)}`);
    return response.clone();
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

function lastCall(fetchMock: ReturnType<typeof stub>): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
}

const ACT = {
  celex: "32016R0679",
  dateOfDocument: "2016-04-27",
  entryIntoForce: "2016-05-24",
  inForceToday: true,
};

const provenance = (celex: string, page: "TXT/HTML" | "ALL") => ({
  publisher: "Publications Office of the European Union",
  sourceUrl: `https://eur-lex.europa.eu/legal-content/EN/${page}/?uri=CELEX:${celex}`,
  sourceIdentifier: celex,
  retrievedAt: null,
  contentHash: null,
  versionIdentifier: celex,
  language: "en",
  licence: "EUR-Lex legal notice",
});

const RESOLVED_VERSION = {
  success: true,
  document: "32016R0679",
  language: "en",
  asOf: "2019-06-01",
  asOfResolved: true,
  asOfVersion: {
    celex: "02016R0679-20160504",
    kind: "consolidated",
    date: "2016-05-04",
    checkedAt: "2026-11-18T04:43:00.000Z",
  },
  act: ACT,
  consolidated: true,
  consolidatedAsOf: "2016-05-04",
  baseCelex: "32016R0679",
  consolidatedNote:
    "The act as amended, consolidated as of 2016-05-04; not the authentic text. Only the act as published in the Official Journal is authentic (32016R0679).",
  provenance: provenance("02016R0679-20160504", "ALL"),
  credits: { operation_weight: 1, remaining: 999 },
};

const RESOLVED_PROVISION = {
  ...RESOLVED_VERSION,
  provision: {
    id: "art_17",
    number: "Article 17",
    title: "Right to erasure (‘right to be forgotten’)",
    text: "1. The data subject shall have the right to obtain from the controller the erasure of personal data …",
  },
  provenance: provenance("02016R0679-20160504", "TXT/HTML"),
};

const unresolved = (asOfReason: string, extra: Record<string, unknown> = {}) => ({
  success: true,
  document: "32016R0679",
  language: "en",
  asOf: "2016-05-10",
  asOfResolved: false,
  asOfReason,
  act: ACT,
  provenance: provenance("32016R0679", "ALL"),
  credits: { operation_weight: 1, remaining: 998 },
  ...extra,
});

describe("legislationAsOf — request", () => {
  it("POSTs the four fields to /legislation/as-of with the SDK's headers", async () => {
    const fetchMock = stub(jsonResponse(200, RESOLVED_PROVISION));

    await client(fetchMock).legislationAsOf({
      document: "32016R0679",
      asOf: "2019-06-01",
      provision: "art_17",
      language: "fr",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/legislation/as-of`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "x-api-key": "lex_test_key",
      accept: "application/json",
      "user-agent": `lexapi-typescript/${VERSION}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      document: "32016R0679",
      asOf: "2019-06-01",
      provision: "art_17",
      language: "fr",
    });
  });

  it("omits provision and language when not given", async () => {
    const fetchMock = stub(jsonResponse(200, RESOLVED_VERSION));

    await client(fetchMock).legislationAsOf({ document: "32016R0679", asOf: "2019-06-01" });

    expect(lastCall(fetchMock)[1].body).toBe('{"document":"32016R0679","asOf":"2019-06-01"}');
  });

  it("sends only the documented fields", async () => {
    const fetchMock = stub(jsonResponse(200, RESOLVED_VERSION));
    const request = { document: "32016R0679", asOf: "2019-06-01", extra: 1 } as unknown as LegislationAsOfRequest;

    await client(fetchMock).legislationAsOf(request);

    expect(lastCall(fetchMock)[1].body).toBe('{"document":"32016R0679","asOf":"2019-06-01"}');
  });

  it("sends document and provision as given — the API decides what is valid", async () => {
    const cases: LegislationAsOfRequest[] = [
      { document: "32016r0679", asOf: "2019-06-01", provision: "Art. 5" },
      { document: "CELEX:32016R0679", asOf: "2019-06-01", provision: "Annex III" },
      { document: "02016R0679-20160504", asOf: "2019-06-01", provision: "rct_26-28" },
      { document: "11957E/TXT", asOf: "1960-01-01" },
    ];
    for (const request of cases) {
      const fetchMock = stub(jsonResponse(200, RESOLVED_VERSION));
      await client(fetchMock).legislationAsOf(request);
      expect(JSON.parse(lastCall(fetchMock)[1].body as string)).toEqual(request);
    }
  });
});

describe("legislationAsOf — answers", () => {
  it("returns a resolved answer with the provision", async () => {
    const fetchMock = stub(jsonResponse(200, RESOLVED_PROVISION, { "x-lexapi-version": "2.26.0" }));

    const result = await client(fetchMock).legislationAsOf({
      document: "32016R0679",
      asOf: "2019-06-01",
      provision: "art_17",
    });

    expect(result.asOfResolved).toBe(true);
    expect(result.asOfReason).toBeUndefined();
    expect(result.asOfVersion).toEqual(RESOLVED_VERSION.asOfVersion);
    expect(result.act).toEqual(ACT);
    expect(result.provision?.id).toBe("art_17");
    expect(result.provision?.number).toBe("Article 17");
    expect(result.provision?.text).toContain("erasure");
    expect(result.consolidated).toBe(true);
    expect(result.consolidatedAsOf).toBe("2016-05-04");
    expect(result.baseCelex).toBe("32016R0679");
    expect(result.consolidatedNote).toContain("not the authentic text");
    expect(result.provenance.versionIdentifier).toBe("02016R0679-20160504");
    expect(result.credits?.operation_weight).toBe(1);
    expect(result.headers).toBeDefined();
  });

  it("returns a resolved version without a provision when none was asked", async () => {
    const fetchMock = stub(jsonResponse(200, RESOLVED_VERSION));

    const result = await client(fetchMock).legislationAsOf({ document: "32016R0679", asOf: "2019-06-01" });

    expect(result.asOfResolved).toBe(true);
    expect(result.asOfVersion?.kind).toBe("consolidated");
    expect(result.provision).toBeUndefined();
  });

  it("returns the act as published when no consolidated version is listed for the date", async () => {
    const fetchMock = stub(
      jsonResponse(200, {
        success: true,
        document: "32024R1689",
        language: "en",
        asOf: "2024-09-01",
        asOfResolved: true,
        asOfVersion: { celex: "32024R1689", kind: "as_published", validUntil: "2026-07-26" },
        act: { celex: "32024R1689", dateOfDocument: "2024-06-13", entryIntoForce: "2024-08-01", inForceToday: true },
        provenance: provenance("32024R1689", "ALL"),
      }),
    );

    const result = await client(fetchMock).legislationAsOf({ document: "32024R1689", asOf: "2024-09-01" });

    expect(result.asOfResolved).toBe(true);
    expect(result.asOfVersion).toEqual({ celex: "32024R1689", kind: "as_published", validUntil: "2026-07-26" });
    expect(result.asOfVersion?.date).toBeUndefined();
    expect(result.consolidated).toBeUndefined();
    expect(result.baseCelex).toBeUndefined();
    expect(result.consolidatedNote).toBeUndefined();
  });

  it.each([
    ["not_yet_in_force", {}],
    ["amendment_not_consolidated", {}],
    ["article_not_in_version", { asOfVersion: { celex: "02016R0679-20160504", kind: "consolidated", date: "2016-05-04" } }],
  ] as const)("returns an unresolved answer (%s) without throwing", async (reason, extra) => {
    const fetchMock = stub(jsonResponse(200, unresolved(reason, extra)));

    const result = await client(fetchMock).legislationAsOf({
      document: "32016R0679",
      asOf: "2016-05-10",
      provision: "art_17",
    });

    expect(result.success).toBe(true);
    expect(result.asOfResolved).toBe(false);
    expect(result.asOfReason).toBe(reason);
    expect(result.provision).toBeUndefined();
    expect(result.consolidated).toBeUndefined();
    expect(result.act.celex).toBe("32016R0679");
    expect(result.asOfVersion?.celex).toBe("asOfVersion" in extra ? "02016R0679-20160504" : undefined);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("passes through a reason this SDK version does not know", async () => {
    const fetchMock = stub(jsonResponse(200, unresolved("some_future_reason")));

    const result = await client(fetchMock).legislationAsOf({ document: "32016R0679", asOf: "2016-05-10" });

    expect(result.asOfResolved).toBe(false);
    expect(result.asOfReason).toBe("some_future_reason");
    expect((AS_OF_LOOKUP_REASONS as readonly string[]).includes(result.asOfReason!)).toBe(false);
  });
});

describe("legislationAsOf — errors", () => {
  const failure = (fetchMock: ReturnType<typeof stub>, request: LegislationAsOfRequest) =>
    client(fetchMock)
      .legislationAsOf(request)
      .catch((e: unknown) => e);

  it("throws NotFoundError for an unknown act (404 NOT_FOUND)", async () => {
    const fetchMock = stub(
      jsonResponse(404, {
        success: false,
        error: { code: "NOT_FOUND", message: "No EU act with the CELEX number 32099R9999 was found." },
      }),
    );

    const error = await failure(fetchMock, { document: "32099R9999", asOf: "2020-01-01" });

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).status).toBe(404);
    expect((error as NotFoundError).message).toContain("32099R9999");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws InvalidParamsError for an invalid asOf (400 INVALID_PARAMS)", async () => {
    const fetchMock = stub(
      jsonResponse(400, {
        success: false,
        error: { code: "INVALID_PARAMS", message: "asOf cannot be in the future" },
      }),
    );

    const error = await failure(fetchMock, { document: "32016R0679", asOf: "2999-01-01" });

    expect(error).toBeInstanceOf(InvalidParamsError);
    expect((error as InvalidParamsError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws InvalidCelexError for a document that is not an EU act (400 INVALID_CELEX)", async () => {
    const fetchMock = stub(
      jsonResponse(400, {
        success: false,
        error: { code: "INVALID_CELEX", message: '"62018CJ0311" is case law. This endpoint covers EU legislation only.' },
      }),
    );

    const error = await failure(fetchMock, { document: "62018CJ0311", asOf: "2020-01-01" });

    expect(error).toBeInstanceOf(InvalidCelexError);
    expect((error as InvalidCelexError).status).toBe(400);
  });

  it("throws NotFoundError naming the endpoint on an API without the route", async () => {
    const fetchMock = stub(
      jsonResponse(404, {
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "Unknown API endpoint: POST /api/v1/legislation/as-of. See https://lex-api.com/docs for the endpoint reference.",
        },
      }),
    );

    const error = await failure(fetchMock, { document: "32016R0679", asOf: "2019-06-01" });

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toContain("Unknown API endpoint: POST /api/v1/legislation/as-of");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("legislationAsOf — types", () => {
  it("lists the 21 documented reasons, in spec order", () => {
    expect([...AS_OF_LOOKUP_REASONS]).toEqual([
      "not_yet_adopted", "not_yet_in_force", "no_longer_in_force", "in_force_dates_unknown",
      "act_type_not_supported", "version_list_unavailable", "version_lookup_cap", "not_in_language",
      "amendment_not_consolidated", "text_unavailable", "article_not_in_version", "provision_ambiguous",
      "version_not_parsed", "fetch_budget_exhausted", "fetch_pending", "fetch_capacity", "fetch_failed",
      "fetch_timeout", "request_deadline", "insufficient_credits", "credit_check_failed",
    ]);
    const typed: AsOfLookupReason[] = [...AS_OF_LOOKUP_REASONS];
    expect(new Set(typed).size).toBe(21);
  });

  it("types the request, the open reason enum and the optional answer fields", () => {
    expectTypeOf<Parameters<LexAPI["legislationAsOf"]>[0]>().toEqualTypeOf<LegislationAsOfRequest>();
    expectTypeOf<ReturnType<LexAPI["legislationAsOf"]>>().toEqualTypeOf<Promise<LegislationAsOfResponse>>();
    expectTypeOf<{ document: string; asOf: string }>().toMatchTypeOf<LegislationAsOfRequest>();
    expectTypeOf<(typeof AS_OF_LOOKUP_REASONS)[number]>().toMatchTypeOf<AsOfLookupReason>();
    expectTypeOf<"provision_ambiguous">().toMatchTypeOf<AsOfLookupReason>();
    expectTypeOf<string>().toMatchTypeOf<AsOfLookupReason>();
    expectTypeOf<LegislationAsOfResponse["asOfResolved"]>().toEqualTypeOf<boolean>();
    expectTypeOf<LegislationAsOfResponse["asOfReason"]>().toEqualTypeOf<AsOfLookupReason | undefined>();
    expectTypeOf<LegislationAsOfResponse["provision"]>().toEqualTypeOf<LegislationAsOfProvision | undefined>();
    expectTypeOf<LegislationAsOfResponse["asOfVersion"]>().toEqualTypeOf<LegislationAsOfVersion | undefined>();
    expectTypeOf<NonNullable<LegislationAsOfResponse["provision"]>["text"]>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<LegislationAsOfResponse["asOfVersion"]>["date"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<LegislationAsOfResponse["provenance"]["contentHash"]>().toEqualTypeOf<string | null>();
  });
});
