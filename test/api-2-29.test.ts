// National asOf labels (API 2.29.0), snapshot timing and not-found details
// (API 2.28.0), and the in-force / provenance fields (API 2.19.0–2.24.0).
import { describe, expect, it, vi } from "vitest";

import { runInNewContext } from "node:vm";

import { LexAPI, LexAPIError, NATIONAL_AS_OF_REASONS, NotFoundError, isNationalAsOfVersion } from "../src/index.js";
import { FAST_RETRY, jsonResponse } from "./helpers.js";
import { DE_LEGISLATION_HIT } from "./fixtures/national.js";

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

function sentBody(fetchMock: ReturnType<typeof stub>): Record<string, unknown> {
  return JSON.parse(lastCall(fetchMock)[1].body as string) as Record<string, unknown>;
}

const PROVENANCE = {
  publisher: "Publications Office of the European Union",
  sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679",
  sourceIdentifier: "32016R0679",
  retrievedAt: null,
  contentHash: null,
  versionIdentifier: "32016R0679",
  language: "en",
  licence: "EUR-Lex legal notice",
};

const FIELD_PROVENANCE = {
  official_source_text: ["title", "content.fullText", "content.articles[].content"],
  machine_extracted_structure: ["documentType", "dateOfDocument", "content.articles"],
};

// ── National legislation semantic search: asOf ──────────────────────

const AT_ASOF_BODY = {
  success: true,
  searchType: "semantic-legislation",
  jurisdiction: "AT",
  query: "Recht auf Auskunft über eigene Daten",
  resultCount: 2,
  results: [
    {
      ...DE_LEGISLATION_HIT,
      jurisdiction: "AT",
      law_id: "AT-NOR-20000001",
      documentId: "AT-NOR-20000001",
      article_ref: "§ 1",
      valid_from: "2018-05-25",
      asOf: "2020-06-01",
      asOfResolved: true,
      asOfVersion: { kind: "current_unit", validFrom: "2018-05-25", validTo: null, sourceId: "NOR40000001", checkedAt: "2026-10-30" },
    },
    {
      ...DE_LEGISLATION_HIT,
      jurisdiction: "AT",
      law_id: "AT-NOR-20000001",
      documentId: "AT-NOR-20000001",
      article_ref: "§ 2",
      valid_from: "2024-01-01",
      asOf: "2020-06-01",
      asOfResolved: false,
      asOfReason: "provision_amended_since",
    },
  ],
  asOf: "2020-06-01",
  asOfSummary: { liveFetches: 0, unresolved: 1 },
  attribution: "Data source: RIS.",
};

describe("nationalLegislationSemanticSearch asOf (API 2.29.0)", () => {
  it("sends asOf as given", async () => {
    const fetchMock = stub(jsonResponse(200, AT_ASOF_BODY));
    await client(fetchMock).nationalLegislationSemanticSearch("AT", {
      query: "Recht auf Auskunft über eigene Daten",
      limit: 2,
      asOf: "2020-06-01",
    });
    expect(lastCall(fetchMock)[0]).toBe(`${BASE_URL}/at/legislation/semantic`);
    expect(sentBody(fetchMock)).toEqual({ query: "Recht auf Auskunft über eigene Daten", limit: 2, asOf: "2020-06-01" });
  });

  it("sends no asOf when none is given", async () => {
    const fetchMock = stub(jsonResponse(200, AT_ASOF_BODY));
    await client(fetchMock).nationalLegislationSemanticSearch("AT", { query: "Auskunft", filters: { inForce: true } });
    const body = sentBody(fetchMock);
    expect(body).toEqual({ query: "Auskunft", filters: { inForce: true } });
    expect("asOf" in body).toBe(false);
  });

  it("passes an asOf string through unchanged, for the server to validate", async () => {
    const fetchMock = stub(jsonResponse(200, AT_ASOF_BODY));
    await client(fetchMock).nationalLegislationSemanticSearch("AT", { query: "Auskunft", asOf: "2020-06-01T12:00:00Z" });
    expect(sentBody(fetchMock)["asOf"]).toBe("2020-06-01T12:00:00Z");
  });

  it("never sends asOf on national case-law search, even when set on the request object", async () => {
    const fetchMock = stub(jsonResponse(200, { success: true, results: [] }));
    const bypassed = { query: "Datenschutz", asOf: "2020-06-01" } as { query: string };
    await client(fetchMock).nationalSemanticSearch("AT", bypassed);
    expect(sentBody(fetchMock)).toEqual({ query: "Datenschutz" });
  });

  it("passes the labels through: resolved hit with current_unit dates, unresolved hit with a reason", async () => {
    const fetchMock = stub(jsonResponse(200, AT_ASOF_BODY));
    const result = await client(fetchMock).nationalLegislationSemanticSearch("AT", { query: "Auskunft", asOf: "2020-06-01" });
    expect(result.asOf).toBe("2020-06-01");
    expect(result.asOfSummary).toEqual({ liveFetches: 0, unresolved: 1 });
    const [resolved, unresolved] = result.results;
    expect(resolved?.asOfResolved).toBe(true);
    expect(resolved?.asOfVersion).toEqual({
      kind: "current_unit",
      validFrom: "2018-05-25",
      validTo: null,
      sourceId: "NOR40000001",
      checkedAt: "2026-10-30",
    });
    expect(resolved?.score).toBe(0.77);
    expect(unresolved?.asOfResolved).toBe(false);
    expect(unresolved?.asOfReason).toBe("provision_amended_since");
    expect(unresolved?.asOfVersion).toBeUndefined();
  });

  it("isNationalAsOfVersion tells the national version from the EU one by kind", () => {
    expect(isNationalAsOfVersion({ kind: "current_unit", validFrom: "2018-05-25", validTo: null, sourceId: null, checkedAt: null })).toBe(true);
    expect(isNationalAsOfVersion({ kind: "consolidated", celex: "02016R0679-20160504", date: "2016-05-04" })).toBe(false);
    expect(isNationalAsOfVersion({ kind: "as_published", celex: "32016R0679", date: null })).toBe(false);
    expect(isNationalAsOfVersion({})).toBe(false);
    for (const value of [null, undefined, "current_unit", 1, true, ["current_unit"]]) {
      expect(isNationalAsOfVersion(value)).toBe(false);
    }
  });

  it("NATIONAL_AS_OF_REASONS lists the documented reasons in spec order", () => {
    expect(NATIONAL_AS_OF_REASONS).toEqual([
      "provision_amended_since",
      "no_longer_in_force",
      "provision_dates_unknown",
      "asof_not_available",
    ]);
  });
});

// ── EU semantic legislation search: inForce ─────────────────────────

describe("semanticLegislationSearch inForce (API 2.19.0)", () => {
  const BODY = {
    success: true,
    searchType: "semantic-legislation",
    results: [
      {
        id: "chunk-1",
        law_id: "31995L0046",
        article_ref: "art_6",
        score: 0.81,
        inForce: false,
        notInForceReason: "no_longer_in_force",
        endOfValidity: "2018-05-24",
        provenance: PROVENANCE,
        fieldProvenance: { official_source_text: ["snippet"], machine_generated_interpretation: ["score"] },
      },
    ],
    inForceFilter: { removedNotInForce: 2, removedUnknown: 1 },
    hint: "Some hits were removed because their in-force status is unknown.",
  };

  it("sends inForce when given and nothing when not", async () => {
    const fetchMock = stub(jsonResponse(200, BODY));
    const api = client(fetchMock);
    await api.semanticLegislationSearch({ query: "data protection", inForce: true });
    expect(sentBody(fetchMock)).toEqual({ query: "data protection", inForce: true });
    await api.semanticLegislationSearch({ query: "data protection", inForce: false });
    expect(sentBody(fetchMock)).toEqual({ query: "data protection", inForce: false });
    await api.semanticLegislationSearch({ query: "data protection" });
    expect(sentBody(fetchMock)).toEqual({ query: "data protection" });
  });

  it("passes the in-force label, provenance and inForceFilter through", async () => {
    const fetchMock = stub(jsonResponse(200, BODY));
    const result = await client(fetchMock).semanticLegislationSearch({ query: "data protection", inForce: true });
    expect(result.inForceFilter).toEqual({ removedNotInForce: 2, removedUnknown: 1 });
    const hit = result.results[0]!;
    expect(hit.inForce).toBe(false);
    expect(hit.notInForceReason).toBe("no_longer_in_force");
    expect(hit.endOfValidity).toBe("2018-05-24");
    expect(hit.provenance?.licence).toBe("EUR-Lex legal notice");
    expect(hit.fieldProvenance?.machine_generated_interpretation).toEqual(["score"]);
  });
});

// ── Documents: provenance and in-force label ────────────────────────

describe("document reads carry provenance and the in-force label (API 2.19.0 / 2.20.0)", () => {
  it("getDocument", async () => {
    const fetchMock = stub(
      jsonResponse(200, {
        success: true,
        document: {
          celex: "32016R0679",
          title: "Regulation (EU) 2016/679",
          content: { articles: [] },
          inForce: true,
          provenance: { ...PROVENANCE, retrievedAt: "2026-11-01T08:00:00.000Z", contentHash: "9f2b" },
          fieldProvenance: FIELD_PROVENANCE,
        },
      }),
    );
    const { document } = await client(fetchMock).getDocument({ celexNumber: "32016R0679" });
    expect(document.inForce).toBe(true);
    expect(document.provenance?.retrievedAt).toBe("2026-11-01T08:00:00.000Z");
    expect(document.fieldProvenance?.official_source_text).toContain("content.articles[].content");
  });

  it("getDocumentMetadata", async () => {
    const fetchMock = stub(
      jsonResponse(200, {
        success: true,
        metadata: {
          celex: "32025R0001",
          inForce: false,
          notInForceReason: "not_yet_in_force",
          entryIntoForce: "2027-01-01",
          provenance: PROVENANCE,
          fieldProvenance: { machine_extracted_structure: ["inForce", "entryIntoForce"] },
        },
      }),
    );
    const { metadata } = await client(fetchMock).getDocumentMetadata({ celexNumber: "32025R0001" });
    expect(metadata.notInForceReason).toBe("not_yet_in_force");
    expect(metadata.entryIntoForce).toBe("2027-01-01");
    expect(metadata.provenance?.contentHash).toBeNull();
    expect(metadata.fieldProvenance?.machine_extracted_structure).toEqual(["inForce", "entryIntoForce"]);
  });

  it("getInfo reports the semantic result caps (API 2.24.0)", async () => {
    const fetchMock = stub(
      jsonResponse(200, { success: true, subscription: { tier: "STARTER", maxSemanticResults: 20, maxSemanticLegislationResults: 20 } }),
    );
    const info = await client(fetchMock).getInfo();
    expect(info.subscription?.maxSemanticResults).toBe(20);
    expect(info.subscription?.maxSemanticLegislationResults).toBe(20);
  });
});

// ── Versions: observedFrom / observedUntil (API 2.28.0) ─────────────

describe("version snapshots (API 2.28.0)", () => {
  it("listDocumentVersions passes observedFrom through, null included", async () => {
    const fetchMock = stub(
      jsonResponse(200, {
        success: true,
        celex: "32016R0679",
        language: "en",
        currentVersion: 2,
        trackedSince: "2026-01-10T08:00:00.000Z",
        semantics: "Versions are LexAPI observation snapshots…",
        versions: [
          { version: 2, isCurrent: true, contentHash: "h2", fetchedAt: "2026-05-20T10:00:00.000Z", observedFrom: null },
          { version: 1, isCurrent: false, contentHash: "h1", fetchedAt: "2026-01-10T08:00:00.000Z", observedFrom: "2026-01-10T08:00:00.000Z" },
        ],
      }),
    );
    const history = await client(fetchMock).listDocumentVersions("32016R0679");
    expect(history.versions.map((v) => v.observedFrom)).toEqual([null, "2026-01-10T08:00:00.000Z"]);
  });

  it("getDocumentVersion passes the snapshot's provenance through", async () => {
    const fetchMock = stub(
      jsonResponse(200, {
        success: true,
        celex: "32016R0679",
        language: "en",
        semantics: "…",
        document: {
          version: 2,
          isCurrent: false,
          contentHash: "h2",
          fetchedAt: "2026-03-15T08:00:00.000Z",
          observedFrom: "2026-03-15T08:00:00.000Z",
          parsedContent: {},
          provenance: { ...PROVENANCE, contentHash: "h2", retrievedAt: "2026-03-15T08:00:00.000Z" },
          fieldProvenance: FIELD_PROVENANCE,
        },
      }),
    );
    const snapshot = await client(fetchMock).getDocumentVersion("32016R0679", 2);
    expect(snapshot.document.observedFrom).toBe("2026-03-15T08:00:00.000Z");
    expect(snapshot.document.provenance?.contentHash).toBe("h2");
    expect(snapshot.document.fieldProvenance).toEqual(FIELD_PROVENANCE);
  });

  it("getDocumentAtDate passes kind, observedFrom/observedUntil, inForceLookup and dateInFuture through", async () => {
    const fetchMock = stub(
      jsonResponse(200, {
        success: true,
        celex: "32016R0679",
        language: "en",
        kind: "observation_snapshot",
        asOf: "2026-04-01",
        semantics: "Versions are LexAPI observation snapshots…",
        inForceLookup: { method: "POST", path: "/api/v1/legislation/as-of" },
        document: {
          version: 2,
          isCurrent: false,
          contentHash: "h2",
          fetchedAt: "2026-03-15T08:00:00.000Z",
          observedFrom: "2026-03-15T08:00:00.000Z",
          observedUntil: "2026-06-01T09:00:00.000Z",
          title: "…",
          parsedContent: {},
        },
      }),
    );
    const atDate = await client(fetchMock).getDocumentAtDate("32016R0679", "2026-04-01");
    expect(lastCall(fetchMock)[0]).toBe(`${BASE_URL}/documents/32016R0679/at/2026-04-01`);
    expect(atDate.kind).toBe("observation_snapshot");
    expect(atDate.document.observedFrom).toBe("2026-03-15T08:00:00.000Z");
    expect(atDate.document.observedUntil).toBe("2026-06-01T09:00:00.000Z");
    expect(atDate.inForceLookup).toEqual({ method: "POST", path: "/api/v1/legislation/as-of" });
    expect(atDate.dateInFuture).toBeUndefined();
  });

  it("getDocumentAtDate for a future date: dateInFuture and the X-Warning header", async () => {
    const fetchMock = stub(
      jsonResponse(
        200,
        {
          success: true,
          celex: "32016R0679",
          language: "en",
          kind: "observation_snapshot",
          asOf: "2099-01-01",
          semantics: "…",
          dateInFuture: true,
          document: { version: 3, isCurrent: true, contentHash: "h3", fetchedAt: "2026-06-01T09:00:00.000Z", observedFrom: "2026-06-01T09:00:00.000Z", observedUntil: null },
        },
        { "x-warning": "The date is in the future; the current version is returned." },
      ),
    );
    const atDate = await client(fetchMock).getDocumentAtDate("32016R0679", "2099-01-01");
    expect(atDate.dateInFuture).toBe(true);
    expect(atDate.document.observedUntil).toBeNull();
    expect(atDate.xWarning).toMatch(/future/);
    expect(atDate.headers?.warning).toMatch(/future/);
  });
});

// ── NotFoundError details (API 2.28.0) ──────────────────────────────

async function notFound(details?: unknown): Promise<NotFoundError> {
  const error: Record<string, unknown> = { code: "NOT_FOUND", message: "No snapshot for that date." };
  if (details !== undefined) error["details"] = details;
  const fetchMock = stub(jsonResponse(404, { success: false, error }, { "x-lexapi-version": "2.28.0" }));
  const err = await client(fetchMock)
    .getDocumentAtDate("32016R0679", "2019-06-01")
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NotFoundError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return err as NotFoundError;
}

describe("NotFoundError on getDocumentAtDate (API 2.28.0)", () => {
  it("before_tracking: reason, trackedSince and inForceLookup", async () => {
    const err = await notFound({
      reason: "before_tracking",
      trackedSince: "2026-01-10T08:00:00.000Z",
      inForceLookup: { method: "POST", path: "/api/v1/legislation/as-of" },
    });
    expect(err.reason).toBe("before_tracking");
    expect(err.beforeTracking).toBe(true);
    expect(err.boundaryUnknown).toBe(false);
    expect(err.unknownEndpoint).toBe(false);
    expect(err.trackedSince).toBe("2026-01-10T08:00:00.000Z");
    expect(err.inForceLookup).toEqual({ method: "POST", path: "/api/v1/legislation/as-of" });
    expect(err.candidates).toEqual([]);
    expect(err.candidatesTruncated).toBe(false);
  });

  it("boundary_unknown: candidates (observedFrom may be null) and candidatesTruncated", async () => {
    const candidates = [
      { version: 1, fetchedAt: "2026-01-10T08:00:00.000Z", observedFrom: "2026-01-10T08:00:00.000Z" },
      { version: 2, fetchedAt: "2026-05-20T10:00:00.000Z", observedFrom: null },
    ];
    const err = await notFound({ reason: "boundary_unknown", candidates, candidatesTruncated: true });
    expect(err.reason).toBe("boundary_unknown");
    expect(err.boundaryUnknown).toBe(true);
    expect(err.beforeTracking).toBe(false);
    expect(err.candidates).toEqual(candidates);
    expect(err.candidatesTruncated).toBe(true);
    expect(err.trackedSince).toBeUndefined();
    expect(err.inForceLookup).toBeUndefined();
  });

  it("boundary_unknown with no candidates: an empty list, not truncated", async () => {
    const err = await notFound({ reason: "boundary_unknown", candidates: [] });
    expect(err.candidates).toEqual([]);
    expect(err.candidatesTruncated).toBe(false);
  });

  it("a 404 without details: nothing set", async () => {
    const err = await notFound();
    expect(err.reason).toBeUndefined();
    expect(err.beforeTracking).toBe(false);
    expect(err.boundaryUnknown).toBe(false);
    expect(err.trackedSince).toBeUndefined();
    expect(err.inForceLookup).toBeUndefined();
    expect(err.candidates).toEqual([]);
    expect(err.candidatesTruncated).toBe(false);
  });

  it("reads only well-typed values from details", async () => {
    const err = await notFound({
      reason: 42,
      trackedSince: 1700000000,
      inForceLookup: ["POST", "/api/v1/legislation/as-of"],
      candidates: [{ version: 1, fetchedAt: "2026-01-10T08:00:00.000Z", observedFrom: null }, "v2", null, [3]],
      candidatesTruncated: "true",
    });
    expect(err.reason).toBeUndefined();
    expect(err.trackedSince).toBeUndefined();
    expect(err.inForceLookup).toBeUndefined();
    expect(err.candidates).toEqual([{ version: 1, fetchedAt: "2026-01-10T08:00:00.000Z", observedFrom: null }]);
    expect(err.candidatesTruncated).toBe(false);
  });


  it("unknown_endpoint keeps its flag and is the reason", async () => {
    const err = await notFound({ reason: "unknown_endpoint" });
    expect(err.unknownEndpoint).toBe(true);
    expect(err.reason).toBe("unknown_endpoint");
    expect(err.beforeTracking).toBe(false);
    expect(err.boundaryUnknown).toBe(false);
  });

  it("never reads the reason from the message", async () => {
    const fetchMock = stub(
      jsonResponse(404, { success: false, error: { code: "NOT_FOUND", message: "before_tracking boundary_unknown" } }),
    );
    const err = (await client(fetchMock)
      .getDocumentAtDate("32016R0679", "2019-06-01")
      .catch((e: unknown) => e)) as NotFoundError;
    expect(err.beforeTracking).toBe(false);
    expect(err.boundaryUnknown).toBe(false);
  });
});

describe("NotFoundError details: hostile input", () => {
  const defaults = (err: NotFoundError) => {
    expect(err.reason).toBeUndefined();
    expect(err.beforeTracking).toBe(false);
    expect(err.boundaryUnknown).toBe(false);
    expect(err.trackedSince).toBeUndefined();
    expect(err.inForceLookup).toBeUndefined();
    expect(err.candidates).toEqual([]);
    expect(err.candidatesTruncated).toBe(false);
  };

  it("details that are not a plain object give every default", () => {
    const shaped = { reason: "boundary_unknown", trackedSince: "t", candidates: [{ version: 1 }], candidatesTruncated: true };
    const tagged = { ...shaped, [Symbol.toStringTag]: "Details" };
    for (const details of [null, "boundary_unknown", 42, true, [shaped], tagged, new Map(Object.entries(shaped)), Object.create(shaped)]) {
      defaults(new NotFoundError("x", 404, details));
      expect(new NotFoundError("x", 404, details).unknownEndpoint).toBe(false);
    }
    // Own keys of an object tagged [object Object] are read (inherited ones never are).
    expect(new NotFoundError("x", 404, Object.create({ reason: "unknown_endpoint" })).unknownEndpoint).toBe(false);
  });

  it("reads details from another realm", () => {
    const details: unknown = runInNewContext(
      '({reason:"boundary_unknown",candidates:[{version:1,fetchedAt:"x",observedFrom:null}],inForceLookup:{method:"POST"}})',
    );
    const err = LexAPIError.fromResponse(404, { success: false, error: { code: "NOT_FOUND", message: "x", details } });
    expect(err).toBeInstanceOf(NotFoundError);
    const nf = err as NotFoundError;
    expect(nf.reason).toBe("boundary_unknown");
    expect(nf.boundaryUnknown).toBe(true);
    expect(nf.candidates).toEqual([{ version: 1, fetchedAt: "x", observedFrom: null }]);
    expect(nf.inForceLookup).toEqual({ method: "POST" });
    const endpoint = LexAPIError.fromResponse(404, {
      success: false,
      error: { code: "NOT_FOUND", message: "x", details: runInNewContext('({reason:"unknown_endpoint"})') as unknown },
    }) as NotFoundError;
    expect(endpoint.unknownEndpoint).toBe(true);
    expect(endpoint.reason).toBe("unknown_endpoint");
  });

  it("a version of -0 is returned as 0", () => {
    const [candidate] = new NotFoundError("x", 404, { candidates: [{ version: -0 }] }).candidates;
    expect(Object.is(candidate?.version, 0)).toBe(true);
  });

  it("reads own keys only: a __proto__ key never supplies a field", () => {
    const details = JSON.parse(
      '{"__proto__": {"reason": "before_tracking", "trackedSince": "t", "candidatesTruncated": true, "candidates": [{"version": 1}]}}',
    ) as unknown;
    defaults(new NotFoundError("x", 404, details));
    const item = JSON.parse('{"__proto__": {"version": 1}, "fetchedAt": "t"}') as unknown;
    expect(new NotFoundError("x", 404, { candidates: [item] }).candidates).toEqual([]);
    const lookup = JSON.parse('{"inForceLookup": {"__proto__": {"method": "POST"}}}') as unknown;
    expect(new NotFoundError("x", 404, lookup).inForceLookup).toEqual({});
  });

  it("ignores inherited keys, also ones added to Object.prototype", () => {
    const keys = ["reason", "trackedSince", "candidates", "candidatesTruncated", "version"];
    const values: Record<string, unknown> = {
      reason: "before_tracking",
      trackedSince: "t",
      candidates: [{ version: 1 }],
      candidatesTruncated: true,
      version: 1,
    };
    try {
      for (const key of keys) Object.defineProperty(Object.prototype, key, { value: values[key], configurable: true });
      defaults(new NotFoundError("x", 404, {}));
      expect(new NotFoundError("x", 404, { candidates: [{ fetchedAt: "t" }] }).candidates).toEqual([]);
    } finally {
      for (const key of keys) delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  it("candidates that are not an array give []", () => {
    for (const candidates of [null, "x", 1, { version: 1 }, true]) {
      expect(new NotFoundError("x", 404, { reason: "boundary_unknown", candidates }).candidates).toEqual([]);
    }
  });

  it("keeps only objects with an integer version; fetchedAt / observedFrom are strings or null", () => {
    const err = new NotFoundError("x", 404, {
      candidates: [
        { version: "x", fetchedAt: 7 },
        { version: 1 },
        { version: true },
        { version: Number.NaN },
        { version: Number.POSITIVE_INFINITY },
        { version: 2.9 },
        { version: null },
        { fetchedAt: "t" },
        { version: 3, fetchedAt: 7, observedFrom: { at: "t" } },
        { version: 4, fetchedAt: "2026-05-20T10:00:00.000Z", observedFrom: "2026-05-20T10:00:00.000Z", extra: 1 },
        [5],
        "6",
      ],
    });
    expect(err.candidates).toEqual([
      { version: 1, fetchedAt: null, observedFrom: null },
      { version: 3, fetchedAt: null, observedFrom: null },
      { version: 4, fetchedAt: "2026-05-20T10:00:00.000Z", observedFrom: "2026-05-20T10:00:00.000Z" },
    ]);
    expect(err.candidatesTruncated).toBe(false);
  });

  it("returns the first 10 kept items; more than 10 kept means truncated", () => {
    const item = (version: number) => ({ version, fetchedAt: "t", observedFrom: null });
    const ten = new NotFoundError("x", 404, { candidates: Array.from({ length: 10 }, (_, i) => item(i + 1)) });
    expect(ten.candidates.map((c) => c.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ten.candidatesTruncated).toBe(false);
    // Ten kept plus unusable items after them: not truncated.
    const tenAndJunk = new NotFoundError("x", 404, {
      candidates: [...Array.from({ length: 10 }, (_, i) => item(i + 1)), { version: "11" }, null],
    });
    expect(tenAndJunk.candidatesTruncated).toBe(false);
    const eleven = new NotFoundError("x", 404, {
      candidates: [{ version: "skip" }, ...Array.from({ length: 11 }, (_, i) => item(i + 1))],
    });
    expect(eleven.candidates.map((c) => c.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(eleven.candidatesTruncated).toBe(true);
    // The server's own flag counts too.
    expect(new NotFoundError("x", 404, { candidates: [item(1)], candidatesTruncated: true }).candidatesTruncated).toBe(true);
    expect(new NotFoundError("x", 404, { candidates: [item(1)], candidatesTruncated: 1 }).candidatesTruncated).toBe(false);
  });

  it("200,000 candidates: 10 returned, truncated", () => {
    const candidates = Array.from({ length: 200_000 }, (_, i) => ({ version: i + 1, fetchedAt: "t", observedFrom: null }));
    const err = new NotFoundError("x", 404, { reason: "boundary_unknown", candidates });
    expect(err.candidates).toHaveLength(10);
    expect(err.candidates[9]?.version).toBe(10);
    expect(err.candidatesTruncated).toBe(true);
  });

  it("returns fresh objects, not the items of details", () => {
    const original = { version: 1, fetchedAt: "t", observedFrom: null };
    const err = new NotFoundError("x", 404, { candidates: [original] });
    expect(err.candidates[0]).toEqual(original);
    expect(err.candidates[0]).not.toBe(original);
  });

  it("reason and trackedSince: strings only", () => {
    for (const value of [1, true, null, { reason: "x" }, ["before_tracking"]]) {
      const err = new NotFoundError("x", 404, { reason: value, trackedSince: value });
      expect(err.reason).toBeUndefined();
      expect(err.trackedSince).toBeUndefined();
      expect(err.beforeTracking).toBe(false);
    }
    expect(new NotFoundError("x", 404, { reason: "something_new" }).reason).toBe("something_new");
  });

  it("inForceLookup: only from a plain object; method / path kept only when strings", () => {
    expect(new NotFoundError("x", 404, { inForceLookup: { method: 1, path: null } }).inForceLookup).toEqual({});
    expect(new NotFoundError("x", 404, { inForceLookup: { method: "POST", path: ["/api"] } }).inForceLookup).toEqual({
      method: "POST",
    });
    expect(new NotFoundError("x", 404, { inForceLookup: { path: "/api/v1/legislation/as-of", extra: 1 } }).inForceLookup).toEqual({
      path: "/api/v1/legislation/as-of",
    });
    for (const inForceLookup of [null, "POST", 1, ["POST"]]) {
      expect(new NotFoundError("x", 404, { inForceLookup }).inForceLookup).toBeUndefined();
    }
  });
});

describe("legislation options never reach case-law search", () => {
  it("semanticSearch drops asOf and inForce set past the types", async () => {
    const fetchMock = stub(jsonResponse(200, { success: true, results: [] }));
    const bypassed = { query: "data transfers", asOf: "2020-06-01", inForce: true } as { query: string };
    await client(fetchMock).semanticSearch(bypassed);
    expect(sentBody(fetchMock)).toEqual({ query: "data transfers" });
  });

  it("nationalSemanticSearch drops asOf and inForce set past the types", async () => {
    const fetchMock = stub(jsonResponse(200, { success: true, results: [] }));
    const bypassed = { query: "Datenschutz", asOf: "2020-06-01", inForce: true } as { query: string };
    await client(fetchMock).nationalSemanticSearch("AT", bypassed);
    expect(sentBody(fetchMock)).toEqual({ query: "Datenschutz" });
  });
});
