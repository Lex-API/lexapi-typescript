// A 2xx answer that is not the documented shape throws InvalidResponseError,
// and no error exposes the response text by default (SDK contract §1.3).
// Every body below is synthetic; every call goes to a stubbed fetch on a
// loopback base URL, never to a real server.
import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  InvalidParamsError,
  InvalidResponseError,
  LexAPI,
  LexAPIError,
  NotFoundError,
  RateLimitedError,
  UpstreamError,
  InternalServerError,
} from "../src/index.js";

const LOOPBACK = "http://127.0.0.1:9/api/v1";
const SENTINEL = "SENTINEL-7f3a-unestablished-provision-text";

type Respond = () => Response;

function stubFetch(respond: Respond) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`Offline tests refuse ${url}`);
    return respond();
  });
}

function client(respond: Respond, maxRetries = 0): LexAPI {
  return new LexAPI({ apiKey: "lex_offline_test_key", baseUrl: LOOPBACK, fetch: stubFetch(respond), retry: { maxRetries, baseDelayMs: 1, maxDelayMs: 5 } });
}

function raw(status: number, content: string | Uint8Array, contentType?: string, extra: Record<string, string> = {}): Respond {
  return () => {
    const res = new Response(content as BodyInit, { status, headers: extra });
    // A string body gets a default `text/plain` type: set or drop it explicitly.
    if (contentType === undefined) res.headers.delete("content-type");
    else res.headers.set("content-type", contentType);
    return res;
  };
}

function asJson(body: unknown, status = 200): Respond {
  return raw(status, JSON.stringify(body), "application/json");
}

/** A 204 that still carries bytes (`new Response` refuses to build one). */
function noContentWith(content: string): Respond {
  return () => {
    const res = new Response(content, { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(res, "status", { value: 204 });
    return res;
  };
}

async function failure(call: Promise<unknown>): Promise<LexAPIError> {
  const error = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LexAPIError);
  return error as LexAPIError;
}

async function invalid(call: Promise<unknown>, status = 200): Promise<InvalidResponseError> {
  const error = await failure(call);
  expect(error).toBeInstanceOf(InvalidResponseError);
  expect(error.code).toBe("INVALID_RESPONSE");
  expect(error.status).toBe(status);
  return error as InvalidResponseError;
}

/** The message without the `[CODE] … (HTTP n)` wrapper. */
function bare(error: LexAPIError): string {
  return error.message.replace(/^\[[^\]]+\] /, "").replace(/ \(HTTP \d+\)$/, "");
}

/** The sentinel is in none of the default string or inspection forms. */
function expectNoSentinel(error: LexAPIError): void {
  expect(error.message).not.toContain(SENTINEL);
  expect(String(error)).not.toContain(SENTINEL);
  expect(error.stack ?? "").not.toContain(SENTINEL);
  expect(inspect(error)).not.toContain(SENTINEL);
  expect(inspect(error, { depth: null })).not.toContain(SENTINEL);
  expect(JSON.stringify(error)).not.toContain(SENTINEL);
  expect(JSON.stringify({ ...error })).not.toContain(SENTINEL);
  expect(Object.keys(error)).not.toContain("bodyExcerpt");
  expect(Object.values(error).map((v) => JSON.stringify(v) ?? "").join("")).not.toContain(SENTINEL);
}

// ── endpoint families ────────────────────────────────────────────────────

interface Family {
  call: (c: LexAPI) => Promise<unknown>;
  /** Minimal valid body. */
  body: Record<string, unknown>;
  /** The list field checked (dotted path), if any. */
  field?: string;
  required?: boolean;
}

const FAMILIES: Record<string, Family> = {
  semanticLegislation: { call: (c) => c.semanticLegislationSearch({ query: "own funds" }), body: { success: true, results: [] }, field: "results", required: true },
  semanticCaseLaw: { call: (c) => c.semanticSearch({ query: "own funds" }), body: { success: true, results: [] }, field: "results", required: true },
  keywordSearch: { call: (c) => c.search({ query: "own funds" }), body: { success: true, results: [] }, field: "results", required: true },
  nationalSemantic: { call: (c) => c.nationalSemanticSearch("at", { query: "own funds" }), body: { success: true, results: [] }, field: "results", required: true },
  nationalLegislationSemantic: { call: (c) => c.nationalLegislationSemanticSearch("at", { query: "own funds" }), body: { success: true, results: [] }, field: "results", required: true },
  batchDocuments: { call: (c) => c.getDocumentsBatch({ celexNumbers: ["32099R0001"] }), body: { success: true, documents: [] }, field: "documents" },
  batchErrors: { call: (c) => c.getDocumentsBatch({ celexNumbers: ["32099R0001"] }), body: { success: true, errors: [] }, field: "errors" },
  recent: { call: (c) => c.getRecentDocuments(), body: { success: true, results: [] }, field: "results" },
  versions: { call: (c) => c.listDocumentVersions("32099R0001"), body: { success: true, versions: [] }, field: "versions" },
  extract: { call: (c) => c.extractCitations("32099R0001"), body: { success: true, citations: [] }, field: "citations" },
  citedBy: { call: (c) => c.getCitedBy("32099R0001"), body: { success: true, citedBy: [] }, field: "citedBy" },
  cites: { call: (c) => c.getCites("32099R0001"), body: { success: true, cites: [] }, field: "cites" },
  citesUnresolved: { call: (c) => c.getCites("32099R0001"), body: { success: true, unresolved: [] }, field: "unresolved" },
  networkCites: { call: (c) => c.getCitationNetwork("32099R0001"), body: { success: true, network: { cites: [] } }, field: "network.cites" },
  networkCitedBy: { call: (c) => c.getCitationNetwork("32099R0001"), body: { success: true, network: { citedBy: [] } }, field: "network.citedBy" },
  networkUnresolved: { call: (c) => c.getCitationNetwork("32099R0001"), body: { success: true, unresolved: [] }, field: "unresolved" },
  statsMostCited: { call: (c) => c.getCitationStats(), body: { success: true, stats: { mostCited: [] } }, field: "stats.mostCited" },
  statsMostCiting: { call: (c) => c.getCitationStats(), body: { success: true, stats: { mostCiting: [] } }, field: "stats.mostCiting" },
  path: { call: (c) => c.getCitationPath("32099R0001", "32099R0002"), body: { success: true, found: false, path: [] }, field: "path" },
  related: { call: (c) => c.getRelatedDocuments("32099R0001"), body: { success: true, related: [] }, field: "related" },
  transposition: { call: (c) => c.getTransposition("32099L0001"), body: { success: true, jurisdictions: [] }, field: "jurisdictions" },
  counterparts: { call: (c) => c.getCounterparts("AT-NOR-1"), body: { success: true, via: [] }, field: "via" },
  coverage: { call: (c) => c.getNationalCoverage(), body: { jurisdictions: [] }, field: "jurisdictions" },
  nationalList: { call: (c) => c.listNationalDocuments("at"), body: { results: [] }, field: "results" },
  webhookList: { call: (c) => c.webhooks.list(), body: { success: true, webhooks: [] }, field: "webhooks" },
  webhookDeliveries: { call: (c) => c.webhooks.deliveries("w1"), body: { success: true, deliveries: [] }, field: "deliveries" },
  // Checks 1–4 only.
  info: { call: (c) => c.getInfo(), body: { service: "LexAPI" } },
  document: { call: (c) => c.getDocument({ celexNumber: "32099R0001" }), body: { success: true, document: { celex: "32099R0001" } } },
  documentVersion: { call: (c) => c.getDocumentVersion("32099R0001", 1), body: { success: true, version: 1 } },
  resolve: { call: (c) => c.resolve("32099R0001"), body: { success: true, celex: "32099R0001" } },
  asOf: { call: (c) => c.legislationAsOf({ document: "32099R0001", asOf: "2099-01-01" }), body: { success: true, asOfResolved: false, asOfReason: "no_version_listed" } },
  nationalDocument: { call: (c) => c.getNationalDocument("at", "AT-NOR-1"), body: { success: true, document: { id: "AT-NOR-1" } } },
  webhookGet: { call: (c) => c.webhooks.get("w1"), body: { success: true, webhook: { id: "w1" } } },
  webhookCreate: { call: (c) => c.webhooks.create({ name: "n", url: "https://example.com", watchCelex: ["32099R0001"] }), body: { success: true, webhook: { id: "w1" } } },
};

const ALL = Object.keys(FAMILIES);
const LISTED = ALL.filter((name) => FAMILIES[name]!.field !== undefined);
const REQUIRED = LISTED.filter((name) => FAMILIES[name]!.required === true);
const OPTIONAL = LISTED.filter((name) => FAMILIES[name]!.required !== true);

/** `body` with a (possibly nested) field set to `value`, or removed when `value` is `undefined`. */
function withField(body: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(body);
  const keys = path.split(".");
  let target = copy;
  for (const key of keys.slice(0, -1)) {
    target[key] = { ...(target[key] as Record<string, unknown> | undefined) };
    target = target[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (value === undefined) delete target[last];
  else target[last] = value;
  return copy;
}

describe("a malformed 2xx answer throws InvalidResponseError", () => {
  it.each(ALL)("%s: a valid body with unknown extra fields is accepted", async (name) => {
    const { call, body } = FAMILIES[name]!;
    const result = (await call(client(asJson({ ...body, someFutureField: { nested: [1, "x"] }, anotherOne: null })))) as Record<string, unknown>;
    expect(result["someFutureField"]).toEqual({ nested: [1, "x"] });
  });

  const kinds: Array<[unknown, string]> = [[[1, 2], "array"], ["x", "string"], [null, "null"], [3, "number"], [true, "boolean"]];
  it.each(ALL)("%s: JSON that is not an object", async (name) => {
    for (const [value, kind] of kinds) {
      const error = await invalid(FAMILIES[name]!.call(client(asJson(value))));
      expect(error.message).toBe(`[INVALID_RESPONSE] Expected a JSON object, got ${kind} (HTTP 200)`);
      expect(error.body).toEqual(value);
    }
  });

  it.each(ALL)("%s: success: false without an error", async (name) => {
    const { call, body } = FAMILIES[name]!;
    const error = await invalid(call(client(asJson({ ...body, success: false }))));
    expect(bare(error)).toBe("Response reported success: false without an error");
  });

  it.each(ALL)("%s: success: false with the error envelope throws the mapped error", async (name) => {
    const fetchMock = stubFetch(asJson({ success: false, error: { code: "NOT_FOUND", message: "No such act" } }));
    const c = new LexAPI({ apiKey: "k", baseUrl: LOOPBACK, fetch: fetchMock, retry: { maxRetries: 0 } });
    const error = await failure(FAMILIES[name]!.call(c));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe("[NOT_FOUND] No such act (HTTP 200)");
    expect(error.status).toBe(200);
  });

  it.each(ALL)("%s: a 204 or an empty 200", async (name) => {
    for (const respond of [() => new Response(null, { status: 204 }), raw(200, "")]) {
      const error = await invalid(FAMILIES[name]!.call(client(respond)), respond().status);
      expect(bare(error)).toBe("Expected JSON, got no body");
      expect(error.body).toBeUndefined();
      expect(error.bodyExcerpt).toBeUndefined();
    }
  });

  it.each(LISTED)("%s: a list field that is not a list", async (name) => {
    const { call, body, field } = FAMILIES[name]!;
    const cases: Array<[unknown, string]> = [[{ a: 1 }, "object"], ["x", "string"], [7, "number"], [false, "boolean"]];
    for (const [value, kind] of cases) {
      const sent = withField(body, field!, value);
      const error = await invalid(call(client(asJson(sent))));
      expect(bare(error)).toBe(`Expected "${field}" to be a list, got ${kind}`);
      expect(error.body).toEqual(sent);
    }
  });

  it.each(LISTED)("%s: list items that are not objects", async (name) => {
    const { call, body, field } = FAMILIES[name]!;
    const cases: Array<[unknown, string]> = [["x", "string"], [1, "number"], [[], "array"], [null, "null"], [true, "boolean"]];
    for (const [item, kind] of cases) {
      const error = await invalid(call(client(asJson(withField(body, field!, [{}, item, "later"])))));
      expect(bare(error)).toBe(`Expected every item of "${field}" to be an object, got ${kind} at index 1`);
    }
  });

  it.each(REQUIRED)("%s: a missing or null required list", async (name) => {
    const { call, body, field } = FAMILIES[name]!;
    for (const sent of [withField(body, field!, undefined), withField(body, field!, null)]) {
      const error = await invalid(call(client(asJson(sent))));
      expect(bare(error)).toBe(`Expected "${field}" in the response; it is missing`);
    }
  });

  it.each(OPTIONAL)("%s: an absent or null optional list is accepted", async (name) => {
    const { call, body, field } = FAMILIES[name]!;
    for (const sent of [withField(body, field!, undefined), withField(body, field!, null)]) {
      await expect(call(client(asJson(sent)))).resolves.toBeTypeOf("object");
    }
  });

  it("checks required fields first, then lists in declared order, items in index order", async () => {
    const c = (body: unknown) => client(asJson(body));
    let error = await invalid(c({ network: { cites: "x", citedBy: 1 }, unresolved: 2 }).getCitationNetwork("X"));
    expect(bare(error)).toBe('Expected "network.cites" to be a list, got string');
    error = await invalid(c({ network: { cites: [], citedBy: 1 }, unresolved: 2 }).getCitationNetwork("X"));
    expect(bare(error)).toBe('Expected "network.citedBy" to be a list, got number');
    error = await invalid(c({ cites: [{}, 1, "x"], unresolved: "x" }).getCites("X"));
    expect(bare(error)).toBe('Expected every item of "cites" to be an object, got number at index 1');
    error = await invalid(c({ documents: [], errors: [{}, {}, null] }).getDocumentsBatch({ celexNumbers: ["X"] }));
    expect(bare(error)).toBe('Expected every item of "errors" to be an object, got null at index 2');
  });

  it("a missing or non-object parent of a nested field counts as missing", async () => {
    for (const network of [undefined, null, [], "x", 3, {}]) {
      const body = network === undefined ? { success: true } : { success: true, network };
      await expect(client(asJson(body)).getCitationNetwork("X")).resolves.toBeTypeOf("object");
    }
    const stats = await client(asJson({ stats: [[1]] })).getCitationStats();
    expect(stats).toBeTypeOf("object");
  });

  it("checks no other field", async () => {
    const result = await client(asJson({ success: true, results: [{ score: "not a number" }], total: "x", hint: [] })).search({ query: "x" });
    expect(result.results).toHaveLength(1);
  });

  it("success is checked only when it is the boolean false", async () => {
    for (const success of ["false", 0, null, true]) {
      await expect(client(asJson({ success, results: [] })).search({ query: "x" })).resolves.toBeTypeOf("object");
    }
  });

  it("an error member that is an array, an empty string or a number is not the envelope", async () => {
    for (const err of [[], ["NOT_FOUND"], "", 3, null]) {
      const error = await invalid(client(asJson({ success: false, error: err })).getInfo());
      expect(bare(error)).toBe("Response reported success: false without an error");
    }
  });

  it("a mapped error from a 2xx keeps its status, is never retried and reads no Retry-After", async () => {
    const fetchMock = stubFetch(() =>
      new Response(JSON.stringify({ success: false, error: { code: "RATE_LIMITED", message: "Slow down" }, retryAfter: 9 }), {
        status: 200,
        headers: { "content-type": "application/json", "retry-after": "7" },
      }),
    );
    const c = new LexAPI({ apiKey: "k", baseUrl: LOOPBACK, fetch: fetchMock, retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 } });
    const error = await failure(c.getInfo());
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.status).toBe(200);
    expect(error.retryAfter).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const legacy = await failure(client(asJson({ success: false, error: "Broken" })).getInfo());
    expect(legacy.code).toBe("INTERNAL");
    expect(legacy.message).toBe("[INTERNAL] Broken (HTTP 200)");
    expect(legacy).not.toBeInstanceOf(InvalidResponseError);
    const empty = await failure(client(asJson({ success: false, error: {} })).getInfo());
    expect(empty.message).toBe("[INTERNAL] HTTP 200 (HTTP 200)");
  });

  it("webhooks.test: success: false is a result, with or without an error", async () => {
    for (const body of [
      { success: false, message: "upstream said 500", delivery: {} },
      { success: false, error: { code: "NOT_FOUND", message: "x" } },
    ]) {
      const result = await client(asJson(body)).webhooks.test("w1");
      expect(result.success).toBe(false);
    }
  });

  it("webhooks.delete: a 204 (with or without bytes) or an empty 200 is a result; checks 2–4 still apply", async () => {
    for (const respond of [() => new Response(null, { status: 204 }), raw(200, ""), noContentWith("{]")]) {
      await expect(client(respond).webhooks.delete("w1")).resolves.toBeTypeOf("object");
    }
    expect(await client(asJson({ success: true, message: "deleted" })).webhooks.delete("w1")).toMatchObject({ message: "deleted" });
    expect(bare(await invalid(client(asJson({ success: false })).webhooks.delete("w1")))).toBe(
      "Response reported success: false without an error",
    );
    expect(bare(await invalid(client(asJson([1])).webhooks.delete("w1")))).toBe("Expected a JSON object, got array");
    expect(bare(await invalid(client(raw(200, " ", "text/plain")).webhooks.delete("w1")))).toBe(
      "Expected JSON, got text/plain that does not parse as JSON (1 bytes)",
    );
  });

  it("a 204 is no body whatever it carries", async () => {
    const error = await invalid(client(noContentWith('{"success": true, "results": []}')).search({ query: "x" }), 204);
    expect(bare(error)).toBe("Expected JSON, got no body");
  });
});

describe("parsing: strict UTF-8, RFC 8259 JSON", () => {
  const bytes = (...parts: Array<string | number[]>): Uint8Array =>
    new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

  it("rejects what is not RFC 8259 JSON in UTF-8, counting bytes before decoding", async () => {
    const cases: Array<[Uint8Array, number]> = [
      [bytes('{"results": [], "x": NaN}'), 25],
      [bytes('{"results": [], "x": Infinity}'), 30],
      [bytes('{"results": ["', [0xed, 0xa0, 0x80], '"]}'), 20], // a UTF-8-encoded surrogate
      [bytes('{"x": "', [0xff, 0xfe], '"}'), 11],
      [new Uint8Array([0xff, 0xfe, ...[...'{"results":[]}'].flatMap((ch) => [ch.charCodeAt(0), 0])]), 30], // UTF-16LE
      [bytes(" \n\t"), 3],
      [bytes('{"results": []} trailing'), 24],
      [bytes("é"), 2],
    ];
    for (const [content, size] of cases) {
      expect(content.byteLength).toBe(size);
      const error = await invalid(client(raw(200, content, "application/json; charset=utf-8")).search({ query: "x" }));
      expect(bare(error)).toBe(`Expected JSON, got application/json that does not parse as JSON (${size} bytes)`);
      expect(error.body).toBeUndefined();
      expect(error.bodyExcerpt).toBeDefined();
    }
  });

  it("accepts a leading UTF-8 byte order mark", async () => {
    const result = await client(raw(200, bytes([0xef, 0xbb, 0xbf], '{"results": []}'), "application/json")).search({ query: "x" });
    expect(result.results).toEqual([]);
  });

  it("the media type is the Content-Type before ';', trimmed, case kept, at most 100 characters", async () => {
    const cases: Array<[string | undefined, string]> = [
      ["Text/HTML ; charset=UTF-8", "Text/HTML"],
      [" text/plain", "text/plain"],
      ["; charset=utf-8", "no content type"],
      [undefined, "no content type"],
      [`x/${"a".repeat(150)}`, `x/${"a".repeat(98)}`],
    ];
    for (const [header, media] of cases) {
      const error = await invalid(client(raw(200, "<p>", header)).search({ query: "x" }));
      expect(bare(error)).toBe(`Expected JSON, got ${media} that does not parse as JSON (3 bytes)`);
    }
  });
});

describe("no error exposes the response text by default", () => {
  const TRUNCATED_JSON = JSON.stringify({ success: true, results: [{ text: SENTINEL.repeat(3) }] }).slice(0, -5);
  const HTML = `<html><body><h1>Just a moment</h1><p>${SENTINEL}</p></body></html>`;

  it.each([
    [TRUNCATED_JSON, "application/json; charset=utf-8", "application/json"],
    [HTML, "text/html; charset=UTF-8", "text/html"],
    [SENTINEL, undefined, "no content type"],
  ])("a 200 that does not parse never shows the body (%#)", async (content, contentType, media) => {
    const error = await invalid(client(raw(200, content, contentType)).semanticLegislationSearch({ query: "x" }));
    expectNoSentinel(error);
    const size = new TextEncoder().encode(content).byteLength;
    expect(error.message).toBe(`[INVALID_RESPONSE] Expected JSON, got ${media} that does not parse as JSON (${size} bytes) (HTTP 200)`);
    expect(error.bodyExcerpt).toContain(SENTINEL);
    expect([...error.bodyExcerpt!].length).toBeLessThanOrEqual(200);
    expect(error.body).toBeUndefined();
    expect("cause" in error).toBe(false);
  });

  it("wrong-shape JSON keeps the parsed value on a non-enumerable body", async () => {
    const bodies: unknown[] = [
      { success: true, results: { text: SENTINEL } },
      { success: true, results: [SENTINEL] },
      { success: false, message: SENTINEL },
      [SENTINEL],
      SENTINEL,
    ];
    for (const body of bodies) {
      const error = await invalid(client(asJson(body)).semanticLegislationSearch({ query: "x" }));
      expectNoSentinel(error);
      expect(Object.keys(error)).not.toContain("body");
      expect(error.body).toEqual(body);
      expect(error.bodyExcerpt).toBeUndefined();
    }
  });

  it.each([
    [502, HTML, "text/html", UpstreamError],
    [500, `Internal error: ${SENTINEL}`, "text/plain", InternalServerError],
  ] as const)("a non-JSON %i never shows the body", async (status, content, contentType, errorClass) => {
    const error = await failure(client(raw(status, content, contentType)).getInfo());
    expect(error).toBeInstanceOf(errorClass);
    expectNoSentinel(error);
    expect(bare(error)).toBe(`HTTP ${status}`);
    expect(error.body).toBeUndefined();
    expect(error.bodyExcerpt).toContain(SENTINEL);
    expect("cause" in error).toBe(false);
  });

  it("the excerpt is the first 200 code points, decoded as UTF-8 with replacement", async () => {
    const content = `<html>${"x".repeat(194)}${SENTINEL}${"y".repeat(500)}`;
    let error = await invalid(client(raw(200, content, "text/html")).search({ query: "x" }));
    expect(error.bodyExcerpt).toBe(content.slice(0, 200));

    const astral = "\u{1F600}".repeat(300);
    error = await invalid(client(raw(200, astral, "text/plain")).search({ query: "x" }));
    expect(error.bodyExcerpt).toBe("\u{1F600}".repeat(200));

    const latin1 = new Uint8Array([0xe9, 0x74, 0xe9]);
    error = await invalid(client(raw(200, latin1, "text/plain; charset=iso-8859-1")).search({ query: "x" }));
    expect(error.bodyExcerpt).toBe("�t�");

    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x70, 0x3e]);
    error = await invalid(client(raw(200, bom, "text/html")).search({ query: "x" }));
    expect(error.bodyExcerpt).toBe("﻿<p>");
  });

  it("a non-2xx body: excerpt only when it is not JSON and not empty", async () => {
    let error = await failure(client(raw(502, "  ", "text/plain")).getInfo());
    expect(error.bodyExcerpt).toBe("  ");
    expect(error.body).toBeUndefined();
    error = await failure(client(raw(502, "")).getInfo());
    expect(error.bodyExcerpt).toBeUndefined();
    error = await failure(client(raw(502, "null", "application/json")).getInfo());
    expect(error.bodyExcerpt).toBeUndefined();
    expect(error.body).toBeNull();
    error = await failure(client(raw(502, new Uint8Array([0x7b, 0x7d, 0xff]), "application/json")).getInfo());
    expect(error.body).toBeUndefined();
    expect(error.bodyExcerpt).toBe("{}�");
  });

  it("a JSON error envelope shows its own message only", async () => {
    const body = {
      success: false,
      error: { code: "INVALID_PARAMS", message: "asOf is invalid", details: SENTINEL },
      echo: SENTINEL,
    };
    const error = await failure(client(asJson(body, 400)).semanticLegislationSearch({ query: "x", asOf: "2099-01-01" }));
    expect(error).toBeInstanceOf(InvalidParamsError);
    expect(error.message).toBe("[INVALID_PARAMS] asOf is invalid (HTTP 400)");
    expect(error.bodyExcerpt).toBeUndefined();
    expect(error.details).toBe(SENTINEL);
    expect(error.body).toEqual(body);
  });

  it("bodyExcerpt is a non-enumerable own property on every error", () => {
    const error = LexAPIError.fromResponse(502, undefined, undefined, undefined, `<p>${SENTINEL}</p>`);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.bodyExcerpt).toBe(`<p>${SENTINEL}</p>`);
    expect(Object.getOwnPropertyDescriptor(error, "bodyExcerpt")?.enumerable).toBe(false);
    expectNoSentinel(error);
    expect(Object.prototype.hasOwnProperty.call(new NotFoundError("x"), "bodyExcerpt")).toBe(true);
    expect(new NotFoundError("x").bodyExcerpt).toBeUndefined();
  });
});

describe("well-formed API errors are unchanged", () => {
  it.each([
    [404, { success: false, error: { code: "NOT_FOUND", message: "Document not found" } }],
    [429, { error: "Too many requests", message: "Retry later", code: "RATE_LIMITED" }],
    [400, { error: "Invalid criteria", details: ["documentType: unknown"] }],
    [418, { success: false, error: { code: "TEAPOT", message: "Short" } }],
  ] as const)("%i", async (status, body) => {
    const error = await failure(client(asJson(body, status)).getInfo());
    expect({ name: error.name, code: error.code, message: error.message, keys: Object.keys(error) }).toMatchSnapshot();
    expect(error.body).toEqual(body);
    expect(error.bodyExcerpt).toBeUndefined();
  });
});

describe("only non-empty string codes and messages are read", () => {
  const ODD: Array<Record<string, unknown>> = [
    { success: false, error: { code: { x: 1 }, message: { text: SENTINEL } } },
    { success: false, error: { code: ["NOT_FOUND"], message: [SENTINEL] } },
    { success: false, error: { code: "", message: "" } },
    { success: false, error: "x", code: { x: 1 }, message: { text: SENTINEL } },
    { success: false, error: {}, code: [1], message: { text: SENTINEL } },
  ];

  it.each([200, 404])("status %i", async (status) => {
    for (const body of ODD) {
      const error = await failure(client(asJson(body, status)).getInfo());
      expect(error.message).not.toContain(SENTINEL);
      expect(error.code).toBe(status === 404 ? "NOT_FOUND" : "INTERNAL");
      expect(bare(error)).toBe(body["error"] === "x" ? "x" : `HTTP ${status}`);
    }
  });

  it("legacy fields that are not strings count as absent", async () => {
    const error = await failure(client(asJson({ error: ["x"], code: { a: 1 }, message: { text: SENTINEL } }, 429)).getInfo());
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.message).toBe("[RATE_LIMITED] HTTP 429 (HTTP 429)");
  });

  it("an empty legacy error string is not the envelope", async () => {
    const body = { error: "", message: "Readable reason" };
    const error = await failure(client(asJson(body, 400)).getInfo());
    expect(error).toBeInstanceOf(InvalidParamsError);
    expect(bare(error)).toBe("Readable reason");
    const shaped = await invalid(client(asJson({ ...body, success: false })).search({ query: "x" }));
    expect(bare(shaped)).toBe("Response reported success: false without an error");
  });

  it("an array error member is not the typed envelope", () => {
    const error = LexAPIError.fromResponse(400, { error: [{ code: "NOT_FOUND" }], code: "INVALID_CELEX", message: "Bad" });
    expect(error.code).toBe("INVALID_CELEX");
    expect(bare(error)).toBe("Bad");
  });
});
