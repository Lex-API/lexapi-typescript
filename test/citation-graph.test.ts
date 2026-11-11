import { describe, expect, it, vi } from "vitest";

import {
  CITATION_PROVENANCES,
  CITATION_RESOLUTIONS,
  CITATION_TYPES,
  InvalidParamsError,
  LexAPI,
  NotFoundError,
  TierForbiddenError,
  TimeoutError,
} from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

function client(fetchMock: typeof fetch, retry: object = FAST_RETRY) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry });
}

function lastUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
  return new URL((fetchMock.mock.calls.at(-1) as unknown as [string])[0]);
}

const NOTE =
  "Measures are those the member state notified to the Commission for this act. A notification is not a finding that the measure transposes the act, or transposes it completely.";

describe("edge filters (API 2.11.0)", () => {
  it("getCites comma-joins list filters and sends unresolved", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, { success: true, sourceDocument: "AT-NOR-10001597", cites: [] }));

    await client(fetchMock).getCites("AT-NOR-10001597", {
      citationType: ["reference", "transposition"],
      provenance: ["source", "resolver"],
      jurisdictions: ["eu", "at"],
      resolution: ["id", "key"],
      unresolved: true,
      limit: 50,
    });

    const url = lastUrl(fetchMock);
    expect(url.pathname).toBe("/api/v1/citations/cites/AT-NOR-10001597");
    expect(url.searchParams.get("citationType")).toBe("reference,transposition");
    expect(url.searchParams.get("provenance")).toBe("source,resolver");
    expect(url.searchParams.get("jurisdictions")).toBe("eu,at");
    expect(url.searchParams.get("resolution")).toBe("id,key");
    expect(url.searchParams.get("unresolved")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("50");
    // The comma is sent as a literal separator the server splits on.
    expect(url.search).toContain("citationType=reference%2Ctransposition");
  });

  it("a single value is sent as-is, and unset filters are omitted", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, { success: true, targetDocument: "32016R0679", citedBy: [] }));

    await client(fetchMock).getCitedBy("32016R0679", { citationType: "amendment", provenance: "cellar" });

    const url = lastUrl(fetchMock);
    expect(url.searchParams.get("citationType")).toBe("amendment");
    expect(url.searchParams.get("provenance")).toBe("cellar");
    for (const key of ["jurisdictions", "resolution", "unresolved", "includeNational"]) {
      expect(url.searchParams.has(key)).toBe(false);
    }
  });

  it("getCitationNetwork sends the filters and unresolved", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        document: "32016L0680",
        network: { celexNumber: "32016L0680", citesCount: 0, citedByCount: 0, cites: [], citedBy: [] },
        paging: { limit: 100, offset: 0, citesTotal: 0, citedByTotal: 0 },
      }),
    );

    await client(fetchMock).getCitationNetwork("32016L0680", {
      citationType: ["transposition"],
      provenance: ["cellar-nim"],
      jurisdictions: "eu,de",
      unresolved: true,
    });

    const url = lastUrl(fetchMock);
    expect(url.searchParams.get("citationType")).toBe("transposition");
    expect(url.searchParams.get("provenance")).toBe("cellar-nim");
    expect(url.searchParams.get("jurisdictions")).toBe("eu,de");
    expect(url.searchParams.get("unresolved")).toBe("true");
  });

  it("getCitationPath and getRelatedDocuments send the filters", async () => {
    const pathMock = fetchSequence(
      jsonResponse(200, { success: true, from: "32016R0679", to: "31995L0046", found: false, path: [] }),
    );
    await client(pathMock).getCitationPath("32016R0679", "31995L0046", {
      maxDepth: 4,
      citationType: ["amendment", "repeal"],
      provenance: ["notice", "notice+cellar"],
      jurisdictions: ["eu"],
      resolution: "id",
    });
    const pathUrl = lastUrl(pathMock);
    expect(pathUrl.searchParams.get("citationType")).toBe("amendment,repeal");
    expect(pathUrl.searchParams.get("provenance")).toBe("notice,notice+cellar");
    expect(pathUrl.searchParams.get("jurisdictions")).toBe("eu");
    expect(pathUrl.searchParams.get("resolution")).toBe("id");
    expect(pathUrl.searchParams.get("maxDepth")).toBe("4");

    const relatedMock = fetchSequence(
      jsonResponse(200, { success: true, celexNumber: "32016R0679", method: "bibliographic-coupling", count: 0, related: [] }),
    );
    await client(relatedMock).getRelatedDocuments("32016R0679", { limit: 5, citationType: "reference", provenance: "notice" });
    const relatedUrl = lastUrl(relatedMock);
    expect(relatedUrl.searchParams.get("citationType")).toBe("reference");
    expect(relatedUrl.searchParams.get("provenance")).toBe("notice");
    expect(relatedUrl.searchParams.get("limit")).toBe("5");
  });

  it("paginateCites keeps filters and unresolved on every page", async () => {
    const group = (n: number) => ({ celexNumber: "32016L0680", citationCount: n, citations: [] });
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, sourceDocument: "AT-NOR-1", limit: 2, offset: 0, cites: [group(2)] }),
      jsonResponse(200, { success: true, sourceDocument: "AT-NOR-1", limit: 2, offset: 2, cites: [group(1)] }),
    );

    const pages = [];
    for await (const page of client(fetchMock).paginateCites("AT-NOR-1", {
      limit: 2,
      provenance: ["source"],
      unresolved: true,
    })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(2);
    for (const call of fetchMock.mock.calls as unknown as Array<[string]>) {
      const url = new URL(call[0]);
      expect(url.searchParams.get("provenance")).toBe("source");
      expect(url.searchParams.get("unresolved")).toBe("true");
    }
    expect(lastUrl(fetchMock).searchParams.get("offset")).toBe("2");
  });

  it("an unknown filter value is an InvalidParamsError naming the param and its allowed values", async () => {
    // Legacy shape (cites / cited-by / network): top-level param / allowed.
    const legacy = fetchSequence(
      jsonResponse(400, {
        success: false,
        code: "INVALID_PARAMS",
        error: "Invalid provenance",
        param: "provenance",
        value: "source",
        allowed: ["notice", "cellar", "notice+cellar"],
      }),
    );
    const err1 = await client(legacy)
      .getCites("32016R0679", { provenance: "source" })
      .catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(InvalidParamsError);
    expect((err1 as InvalidParamsError).param).toBe("provenance");
    expect((err1 as InvalidParamsError).value).toBe("source");
    expect((err1 as InvalidParamsError).allowed).toEqual(["notice", "cellar", "notice+cellar"]);
    expect(legacy).toHaveBeenCalledTimes(1);

    // Typed envelope (path / related): details.param / details.allowed — an empty list is kept.
    const typed = fetchSequence(
      jsonResponse(400, {
        success: false,
        error: { code: "INVALID_PARAMS", message: "Invalid resolution", details: { param: "resolution", value: "id", allowed: [] } },
      }),
    );
    const err2 = await client(typed)
      .getRelatedDocuments("32016R0679", { resolution: "id" })
      .catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(InvalidParamsError);
    expect((err2 as InvalidParamsError).param).toBe("resolution");
    expect((err2 as InvalidParamsError).value).toBe("id");
    expect((err2 as InvalidParamsError).allowed).toEqual([]);
  });

  it("exports the runtime value lists", () => {
    expect(CITATION_TYPES).toContain("transposition");
    expect(CITATION_TYPES).toHaveLength(8);
    expect(CITATION_PROVENANCES).toEqual(["notice", "cellar", "notice+cellar", "cellar-nim", "source", "resolver"]);
    expect(CITATION_RESOLUTIONS).toEqual(["id", "key", "abbreviation", "text-pattern"]);
  });
});

describe("edge provenance, node identity and totals", () => {
  it("cited-by carries totalEdges, countsSource, node identity and per-edge provenance/resolution", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        targetDocument: "32016R0679",
        totalCitations: 456,
        totalEdges: 458,
        countsSource: "stats",
        uniqueDocuments: 1,
        limit: 100,
        offset: 0,
        citedBy: [
          {
            id: "52020DC0790",
            jurisdiction: "EU",
            documentKind: null,
            celexNumber: "52020DC0790",
            title: "Communication",
            titleSource: "edge",
            citationCount: 1,
            citations: [
              { citationType: "reference", contextSnippet: null, extractedAt: "2025-04-01T00:00:00.000Z", provenance: "notice", resolution: null },
            ],
          },
        ],
      }),
    );

    const result = await client(fetchMock).getCitedBy("32016R0679");

    expect(result.totalEdges).toBe(458);
    expect(result.countsSource).toBe("stats");
    const group = result.citedBy[0]!;
    expect(group.id).toBe("52020DC0790");
    expect(group.jurisdiction).toBe("EU");
    expect(group.documentKind).toBeNull();
    expect(group.citations?.[0]?.provenance).toBe("notice");
    expect(group.citations?.[0]?.resolution).toBeNull();
  });

  it("cites on a national id returns unresolved references", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        includeNational: true,
        sourceDocument: "DE-JUD-BFH-KBRE202550123",
        totalCitations: 1,
        totalEdges: 1,
        countsSource: "counted",
        cites: [
          {
            id: "AT-NOR-10001597",
            jurisdiction: "AT",
            documentKind: "act",
            celexNumber: "AT-NOR-10001597",
            citationCount: 1,
            citations: [{ citationType: "reference", provenance: "resolver", resolution: "abbreviation" }],
          },
        ],
        unresolved: [
          { kind: "norm", text: "StGB §302", parsedKey: { code: "StGB", section: "302" }, status: "not-held", targetId: null },
        ],
        unresolvedTruncated: false,
      }),
    );

    const result = await client(fetchMock).getCites("DE-JUD-BFH-KBRE202550123", { unresolved: true });

    expect(result.countsSource).toBe("counted");
    expect(result.cites[0]?.citations?.[0]?.resolution).toBe("abbreviation");
    expect(result.unresolved?.[0]).toEqual({
      kind: "norm",
      text: "StGB §302",
      parsedKey: { code: "StGB", section: "302" },
      status: "not-held",
      targetId: null,
    });
    expect(result.unresolvedTruncated).toBe(false);
  });

  it("network neighbours carry edgeDetails; paging carries edge totals and countsSource (null when partial)", async () => {
    const full = fetchSequence(
      jsonResponse(200, {
        success: true,
        document: "32016R0679",
        network: {
          celexNumber: "32016R0679",
          citesCount: 1,
          citedByCount: 0,
          cites: [
            {
              id: "31995L0046",
              jurisdiction: "EU",
              documentKind: "act",
              celexNumber: "31995L0046",
              count: 2,
              types: ["reference"],
              edgeDetails: [{ citationType: "reference", provenance: "notice", resolution: null }],
            },
          ],
          citedBy: [],
        },
        paging: { limit: 100, offset: 0, citesTotal: 35, citedByTotal: 456, citesEdgeTotal: 35, citedByEdgeTotal: 458, countsSource: "stats" },
      }),
    );
    const result = await client(full).getCitationNetwork("32016R0679");
    expect(result.network.cites[0]?.edgeDetails).toEqual([{ citationType: "reference", provenance: "notice", resolution: null }]);
    expect(result.network.cites[0]?.documentKind).toBe("act");
    expect(result.paging.citedByEdgeTotal).toBe(458);
    expect(result.paging.countsSource).toBe("stats");

    const partial = fetchSequence(
      jsonResponse(200, {
        success: true,
        document: "32016R0679",
        network: { celexNumber: "32016R0679", citesCount: 0, citedByCount: 0, cites: [], citedBy: [] },
        paging: { limit: 100, offset: 0, citesTotal: null, citedByTotal: null, citesEdgeTotal: null, citedByEdgeTotal: null, countsSource: null },
        partial: true,
        partialReason: "TIMEOUT",
        timeoutMs: 30000,
      }),
    );
    const partialResult = await client(partial).getCitationNetwork("32016R0679");
    expect(partialResult.partial).toBe(true);
    expect(partialResult.paging.countsSource).toBeNull();
    expect(partialResult.paging.citesEdgeTotal).toBeNull();
  });

  it("path nodes and related documents carry node identity", async () => {
    const pathMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        from: "AT-NOR-10001597",
        to: "32016L0680",
        found: true,
        pathLength: 1,
        path: [
          { id: "AT-NOR-10001597", jurisdiction: "AT", documentKind: "act", celexNumber: "AT-NOR-10001597", title: "Datenschutzgesetz" },
          { id: "32016L0680", jurisdiction: "EU", documentKind: "act", celexNumber: "32016L0680", title: "Directive (EU) 2016/680" },
        ],
      }),
    );
    const path = await client(pathMock).getCitationPath("AT-NOR-10001597", "32016L0680");
    expect(path.path.map((n) => n.jurisdiction)).toEqual(["AT", "EU"]);

    const relatedMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        celexNumber: "62018CJ0311",
        method: "bibliographic-coupling",
        count: 1,
        related: [{ id: "62014CJ0362", jurisdiction: "EU", documentKind: "decision", celexNumber: "62014CJ0362", sharedCount: 4 }],
      }),
    );
    const related = await client(relatedMock).getRelatedDocuments("62018CJ0311");
    expect(related.related[0]?.documentKind).toBe("decision");
  });

  it("stats with includeNational carries byJurisdiction, byProvenance and transposition", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        includeNational: true,
        stats: {
          totalCitations: 10,
          uniqueSourceDocuments: 5,
          uniqueTargetDocuments: 6,
          mostCited: [],
          mostCiting: [],
          byJurisdiction: { EU: { asSource: 8, asTarget: 10 }, AT: { asSource: 2, asTarget: 0 } },
          byProvenance: { notice: 6, cellar: 2, source: 2 },
          transposition: { measures: 40, resolved: 12, byCountry: { AT: { measures: 20, resolved: 12 } } },
        },
      }),
    );

    const result = await client(fetchMock).getCitationStats({ includeNational: true });

    expect(lastUrl(fetchMock).searchParams.get("includeNational")).toBe("true");
    expect(result.stats.byJurisdiction?.["AT"]?.asSource).toBe(2);
    expect(result.stats.byProvenance?.["source"]).toBe(2);
    expect(result.stats.transposition?.byCountry?.["AT"]?.resolved).toBe(12);
  });
});

describe("getTransposition", () => {
  const measure = {
    id: null,
    resolved: null,
    resolution: null,
    resolutionBasis: null,
    provenance: "cellar-nim",
    citationType: "transposition",
    title: "Ley Orgánica 7/2021",
    typeAct: "Ley Orgánica",
    officialJournal: { name: "Boletín Oficial del Estado", number: "126/2021", date: "2021-05-27" },
    reference: "BOE-A-2021-8806",
    eli: null,
    link: "https://www.boe.es/boe/dias/2021/05/27/pdfs/BOE-A-2021-8806.pdf",
    cellar: {
      id: "x",
      celex: "72016L0680ESP_202101234",
      commissionReference: null,
      dateDocument: "2021-05-27",
      dateNotification: "2021-06-02",
      entryIntoForce: "2021-06-16",
    },
  };
  const body = (extra: object = {}) => ({
    success: true,
    document: { id: "32016L0680", celexNumber: "32016L0680", jurisdiction: "EU", documentKind: "act", title: "Directive (EU) 2016/680" },
    source: { cellar: { syncedAt: "2026-12-01T03:10:00.000Z", measures: 333, attribution: "Source: Publications Office of the European Union" }, lanes: null },
    note: NOTE,
    jurisdictions: [{ jurisdiction: "ES", live: false, counts: { measures: 1, resolved: null }, measures: [measure] }],
    truncated: false,
    credits: { operation_weight: 5 },
    ...extra,
  });

  it("GETs /citations/transposition/{celex} with jurisdictions, resolvedOnly and language", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, body()));

    const result = await client(fetchMock).getTransposition("32016L0680", {
      jurisdictions: ["es", "cz"],
      resolvedOnly: true,
      language: "de",
    });

    const url = lastUrl(fetchMock);
    expect(url.pathname).toBe("/api/v1/citations/transposition/32016L0680");
    expect(url.searchParams.get("jurisdictions")).toBe("es,cz");
    expect(url.searchParams.get("resolvedOnly")).toBe("true");
    expect(url.searchParams.get("language")).toBe("de");
    expect(result.note).toBe(NOTE);
    expect(result.source.cellar?.measures).toBe(333);
    expect(result.jurisdictions[0]?.measures[0]?.cellar?.celex).toBe("72016L0680ESP_202101234");
    expect(result.jurisdictions[0]?.counts.resolved).toBeNull();
    expect(result.credits?.operation_weight).toBe(5);
  });

  it("sends no query when called without params, and passes termsRequired through", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, body({ includeNational: false, termsRequired: true })));

    const result = await client(fetchMock).getTransposition("32016L0680");

    expect(lastUrl(fetchMock).search).toBe("");
    expect(result.termsRequired).toBe(true);
    expect(result.includeNational).toBe(false);
  });

  it("holdings joined: resolved measures, resolution basis and lanes", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        body({
          includeNational: true,
          source: { cellar: { syncedAt: null, measures: 1, attribution: "x" }, lanes: ["AT", "SI"] },
          jurisdictions: [
            {
              jurisdiction: "ES",
              live: true,
              counts: { measures: 1, resolved: 1 },
              measures: [{ ...measure, id: "ES-LEG-BOE-A-2021-8806", resolved: true, resolution: "id", resolutionBasis: { keyKind: "boe", key: "BOE-A-2021-8806" } }],
            },
          ],
        }),
      ),
    );

    const result = await client(fetchMock).getTransposition("32016L0680");

    expect(result.source.lanes).toEqual(["AT", "SI"]);
    expect(result.jurisdictions[0]?.measures[0]).toMatchObject({ id: "ES-LEG-BOE-A-2021-8806", resolved: true, resolution: "id" });
  });

  it("a CELEX that is not an EU act is a NotFoundError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(404, { success: false, code: "NOT_FOUND", error: "Not an EU act: 62018CJ0311" }),
    );

    await expect(client(fetchMock).getTransposition("62018CJ0311")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getCounterparts", () => {
  const body = {
    success: true,
    includeNational: true,
    document: { id: "AT-NOR-10001597", jurisdiction: "AT", documentKind: "act", title: "Datenschutzgesetz" },
    via: [
      {
        euAct: { id: "32016L0680", jurisdiction: "EU", documentKind: "act", title: "Directive (EU) 2016/680", notifiedMeasures: 333 },
        edge: { citationType: "transposition", provenance: "source", resolution: "id" },
        counterparts: [
          { jurisdiction: "SI", id: "SI-PRED-ZAKO7959", resolved: true, title: "Zakon", citationType: "transposition", provenance: "source", rank: 1 },
          { jurisdiction: "DE", id: null, resolved: false, title: "Gesetz", citationType: "transposition", provenance: "cellar-nim", rank: 3 },
        ],
        truncated: false,
      },
    ],
    truncated: false,
  };

  it("GETs /citations/counterparts/{id} with jurisdictions and language", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, body));

    const result = await client(fetchMock).getCounterparts("AT-NOR-10001597", { jurisdictions: ["si", "de"], language: "en" });

    const url = lastUrl(fetchMock);
    expect(url.pathname).toBe("/api/v1/citations/counterparts/AT-NOR-10001597");
    expect(url.searchParams.get("jurisdictions")).toBe("si,de");
    expect(url.searchParams.get("language")).toBe("en");
    expect(result.via[0]?.euAct.notifiedMeasures).toBe(333);
    expect(result.via[0]?.counterparts.map((c) => c.rank)).toEqual([1, 3]);
    expect(result.via[0]?.counterparts[1]?.id).toBeNull();
  });

  it("encodes the id path segment", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, body));
    await client(fetchMock).getCounterparts("../stats?x=");
    expect(lastUrl(fetchMock).pathname).toBe("/api/v1/citations/counterparts/..%2Fstats%3Fx%3D");
  });

  it("below BUSINESS is a TierForbiddenError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(403, { success: false, code: "TIER_FORBIDDEN", error: "Upgrade required", upgradeUrl: "https://lex-api.com/pricing" }),
    );
    await expect(client(fetchMock).getCounterparts("32016L0680")).rejects.toBeInstanceOf(TierForbiddenError);
  });

  it("a 503 TIMEOUT is a TimeoutError with partial and the server budget", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(503, {
        success: false,
        code: "TIMEOUT",
        error: "Counterparts lookup timed out",
        partial: true,
        partialReason: "TIMEOUT",
        timeoutMs: 20000,
      }),
    );

    const err = await client(fetchMock, { maxRetries: 0 })
      .getCounterparts("AT-NOR-10001597")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    const timeout = err as TimeoutError;
    expect(timeout.code).toBe("TIMEOUT");
    expect(timeout.status).toBe(503);
    expect(timeout.partial).toBe(true);
    expect(timeout.serverTimeoutMs).toBe(20000);
  });

  it("an app-origin 503 budget TIMEOUT (partialReason) is not retried", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        503,
        { success: false, code: "TIMEOUT", error: "timed out", partial: true, partialReason: "TIMEOUT", timeoutMs: 20000 },
        { "x-lexapi-version": "2.13.0" },
      ),
      jsonResponse(200, body),
    );

    await expect(client(fetchMock).getCounterparts("AT-NOR-10001597")).rejects.toBeInstanceOf(TimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("other app-origin 503s keep the GET retry policy", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(503, { success: false, error: "Service unavailable" }, { "x-lexapi-version": "2.13.0" }),
      jsonResponse(200, body),
    );

    const result = await client(fetchMock).getCounterparts("AT-NOR-10001597");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.via).toHaveLength(1);
  });
});

describe("national coverage citationGraph (API 2.11.0–2.13.0)", () => {
  it("passes the measured graph block through, including floors and unmeasured rates", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        updatedAt: "2026-11-03T08:00:00.000Z",
        jurisdictions: [
          {
            code: "NL",
            name: "Netherlands",
            live: true,
            legislation: { available: true },
            caseLaw: { available: true },
            semanticSearch: { legislation: true, caseLaw: true },
            sources: [],
            citationGraph: {
              methods: { decisions: "id", acts: ["key"], eu: ["text-pattern"], unmeasured: { decisionsToActs: "not-collected" } },
              edges: 10,
              decisionResolutionRate: null,
              actEuRate: null,
              textPatternRate: 0.91,
              transposition: { measures: 50, resolved: 20 },
              precision: { resolver: "key", resolverVersion: 1, provenance: "resolver", labelled: 200, errorUpperBound: 0.015 },
              measuredAt: "2026-11-03T06:00:00.000Z",
              nimResolvedRate: 0.4,
              nimMeasuredAt: "2026-11-03T05:00:00.000Z",
              floors: {
                decisionsToActs: null,
                actsToEu: null,
                textPattern: 0.81,
                nimResolved: 0.3,
                derivedAt: "2026-11-04T00:00:00.000Z",
                measuredAt: { rebuild: "2026-11-03T06:00:00.000Z", nim: "2026-11-03T05:00:00.000Z" },
              },
            },
          },
          { code: "HU", name: "Hungary", live: false, legislation: { available: false }, caseLaw: { available: false }, semanticSearch: { legislation: false, caseLaw: false }, sources: [], citationGraph: null },
        ],
      }),
    );

    const result = await client(fetchMock).getNationalCoverage();

    const nl = result.jurisdictions[0]!.citationGraph!;
    expect(nl.methods?.unmeasured).toEqual({ decisionsToActs: "not-collected" });
    expect(nl.decisionResolutionRate).toBeNull();
    expect(nl.floors?.textPattern).toBe(0.81);
    expect(nl.precision?.provenance).toBe("resolver");
    expect(result.jurisdictions[1]?.citationGraph).toBeNull();
  });
});
