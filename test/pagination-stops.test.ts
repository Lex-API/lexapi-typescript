// SDK contract §1.4: an iterator never ends a walk silently because of what a
// page contains. It ends by the documented stop conditions, or throws
// InvalidResponseError when the server stops advancing.
import { describe, expect, it, vi } from "vitest";

import { InvalidResponseError, LexAPI } from "../src/index.js";
import { compactForm } from "../src/paging.js";

const BASE = "http://127.0.0.1:9/api/v1";

type Handler = (url: URL, call: number) => unknown;

/** A loopback server stub; `handler` answers each request from its query. */
function server(handler: Handler) {
  let call = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    expect(url.origin).toBe("http://127.0.0.1:9");
    return new Response(JSON.stringify(handler(url, call++)), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = new LexAPI({ apiKey: "lex_test_key", baseUrl: BASE, fetch: fetchFn, retry: { maxRetries: 0 } });
  return { client, fetchFn, requests: () => fetchFn.mock.calls.length };
}

const qp = (url: URL, name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback);

/** Drain, with a hard page bound so a looping iterator fails the test instead of hanging. */
async function walk<T>(it: AsyncIterable<T>, bound = 10_000): Promise<{ pages: T[]; error?: unknown }> {
  const pages: T[] = [];
  try {
    for await (const page of it) {
      pages.push(page);
      if (pages.length > bound) throw new Error("iterator did not end");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "iterator did not end") throw error;
    return { pages, error };
  }
  return { pages };
}

const strip = <T extends object>(page: T) => {
  const { headers: _h, ...rest } = page as T & { headers?: unknown };
  return rest;
};

// ── deliveries ──────────────────────────────────────────────────────────

/** A delivery history, newest first, that grows by `burst(call)` items before each request. */
function deliveryServer(initial: number, burst: (call: number) => number, opts: { total?: boolean } = {}) {
  let next = 0;
  const items: Array<{ id: string }> = [];
  const add = (n: number) => {
    for (let i = 0; i < n; i++) items.unshift({ id: `d${next++}` });
  };
  add(initial);
  return server((url, call) => {
    if (call > 0) add(burst(call));
    const limit = qp(url, "limit", 50);
    const offset = qp(url, "offset", 0);
    return {
      success: true,
      limit,
      offset,
      ...(opts.total === false ? {} : { total: items.length }),
      deliveries: items.slice(offset, offset + limit),
    };
  });
}

/** What the walk yields as ids, flattened. */
const ids = (pages: Array<{ deliveries: Array<{ id?: string }> }>) => pages.flatMap((p) => p.deliveries.map((d) => d.id));

describe("paginateDeliveries", () => {
  it("a well-formed walk of 10,000 deliveries yields every page as served", async () => {
    const { client, fetchFn } = deliveryServer(10_000, () => 0);
    const { pages, error } = await walk(client.webhooks.paginateDeliveries("w"));
    expect(error).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(200);
    expect(ids(pages)).toEqual(Array.from({ length: 10_000 }, (_, i) => `d${9_999 - i}`));
    expect(pages.map(strip)[0]).toEqual({ success: true, limit: 50, offset: 0, total: 10_000, deliveries: pages[0]!.deliveries });
  });

  it.each([2, 10, 50, 100])("bursts of limit (%i) and more, then quiet: the walk returns every delivery once", async (limit) => {
    const bursts = [limit, limit + 3, limit * 2];
    const { client } = deliveryServer(limit * 10, (call) => bursts[call - 1] ?? 0);
    const { pages, error } = await walk(client.webhooks.paginateDeliveries("w", { limit }));
    expect(error).toBeUndefined();
    const total = limit * 10 + bursts.reduce((a, b) => a + b, 0);
    const seen = ids(pages);
    expect(new Set(seen).size).toBe(seen.length);
    // Every delivery that existed before the walk started is reached.
    for (let i = 0; i < limit * 10; i++) expect(seen).toContain(`d${i}`);
    expect(seen.length).toBeLessThanOrEqual(total);
  });

  it("a server that ignores offset ends by total", async () => {
    const page = { success: true, total: 7, limit: 2, deliveries: [{ id: "a" }, { id: "b" }] };
    const { client, requests } = server(() => page);
    const { pages, error } = await walk(client.webhooks.paginateDeliveries("w", { limit: 2 }));
    expect(error).toBeUndefined();
    expect(requests()).toBe(4); // offsets 0, 2, 4, 6 → 8 ≥ 7
    expect(ids(pages)).toEqual(["a", "b"]);
  });

  it.each([undefined, -1, 2.5, "9", 1e400])("without a usable total (%s), repeated pages throw after three", async (total) => {
    const page = { success: true, ...(total === undefined ? {} : { total }), deliveries: [{ id: "a" }, { id: "b" }] };
    const { client, requests } = server(() => page);
    const { pages, error } = await walk(client.webhooks.paginateDeliveries("w", { limit: 2 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect((error as Error).message).toContain("the server repeated the same deliveries");
    expect(requests()).toBe(4); // one new page, then the third repeat throws
    expect(pages.map((p) => p.deliveries.length)).toEqual([2, 0, 0]);
  });

  it("a repeated page that brings an unseen id resets the count", async () => {
    const pages = [["a"], ["a"], ["a"], ["a", "b"], ["b"], ["b"], ["b"]];
    const { client, requests } = server((_, call) => ({ success: true, deliveries: (pages[call] ?? []).map((id) => ({ id })) }));
    const { error } = await walk(client.webhooks.paginateDeliveries("w", { limit: 2 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(requests()).toBe(7);
  });

  it("a page without readable ids never counts as a repeat", async () => {
    const { client, requests } = server((_, call) => ({ success: true, deliveries: call < 6 ? [{ status: "SUCCESS" }] : [] }));
    const { pages, error } = await walk(client.webhooks.paginateDeliveries("w", { limit: 1 }));
    expect(error).toBeUndefined();
    expect(requests()).toBe(7);
    expect(pages).toHaveLength(7);
  });

  it("an empty page ends the walk; a page without its list ends it too", async () => {
    const empty = server(() => ({ success: true, deliveries: [] }));
    expect((await walk(empty.client.webhooks.paginateDeliveries("w"))).pages).toHaveLength(1);
    const missing = server(() => ({ success: true, total: 9 }));
    const { pages, error } = await walk(missing.client.webhooks.paginateDeliveries("w"));
    expect(error).toBeUndefined();
    expect(pages[0]!.deliveries).toEqual([]);
  });
});

// ── cites / cited-by ────────────────────────────────────────────────────

interface EdgeRow {
  celex: string;
  extractedAt: string;
}

/** Group a page of edge rows by consecutive celex, as the API does. */
function groups(rows: EdgeRow[]) {
  const out: Array<{ celexNumber: string; citationCount: number; citations: Array<{ citationType: string; extractedAt: string }> }> = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    const edge = { citationType: "reference", extractedAt: row.extractedAt };
    if (last && last.celexNumber === row.celex) {
      last.citationCount++;
      last.citations.push(edge);
    } else out.push({ celexNumber: row.celex, citationCount: 1, citations: [edge] });
  }
  return out;
}

function edgeServer(rows: EdgeRow[], opts: { offset?: boolean; totalEdges?: boolean; ignoreOffset?: boolean } = {}) {
  return server((url) => {
    const limit = qp(url, "limit", 100);
    const offset = opts.ignoreOffset ? 0 : qp(url, "offset", 0);
    return {
      success: true,
      targetDocument: "X",
      limit,
      ...(opts.offset === false ? {} : { offset }),
      ...(opts.totalEdges === false ? {} : { totalEdges: rows.length }),
      citedBy: groups(rows.slice(offset, offset + limit)),
    };
  });
}

const rowsOf = (n: number, celex: (i: number) => string, at: (i: number) => string = (i) => `t${i}`) =>
  Array.from({ length: n }, (_, i) => ({ celex: celex(i), extractedAt: at(i) }));
const edgeCount = (pages: Array<{ citedBy: Array<{ citationCount?: number }> }>) =>
  pages.reduce((n, p) => n + p.citedBy.reduce((m, g) => m + (g.citationCount ?? 0), 0), 0);

describe("paginateCites / paginateCitedBy", () => {
  it("a well-formed walk of 10,000 edges yields every page as served, with every signal combination", async () => {
    const rows = rowsOf(10_000, (i) => `D${Math.floor(i / 7)}`);
    for (const opts of [{}, { offset: false }, { totalEdges: false }, { offset: false, totalEdges: false }]) {
      const { client, fetchFn } = edgeServer(rows, opts);
      const { pages, error } = await walk(client.paginateCitedBy("X", { limit: 100 }));
      expect(error, JSON.stringify(opts)).toBeUndefined();
      expect(edgeCount(pages)).toBe(10_000);
      // A walk that ends by a short page needs one request past the last full page.
      expect(fetchFn.mock.calls.length).toBe(opts.totalEdges === false ? 101 : 100);
      const offsets = fetchFn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("offset"));
      expect(offsets.slice(0, 3)).toEqual(["0", "100", "200"]);
    }
  });

  it.each([150, 350])("a run of %i wire-identical edges (limit 100) is walked to the end", async (n) => {
    const rows = rowsOf(n, () => "A", () => "same");
    for (const opts of [{}, { offset: false }, { totalEdges: false }, { offset: false, totalEdges: false }]) {
      const { client } = edgeServer(rows, opts);
      const { pages, error } = await walk(client.paginateCitedBy("X", { limit: 100 }));
      expect(error, JSON.stringify(opts)).toBeUndefined();
      expect(edgeCount(pages)).toBe(n);
    }
  });

  it("one source spanning several full pages is walked to the end", async () => {
    const { client } = edgeServer(rowsOf(1_000, () => "A"));
    expect(edgeCount((await walk(client.paginateCitedBy("X", { limit: 100 }))).pages)).toBe(1_000);
  });

  it("a server that ignores offset but echoes it throws at the second request", async () => {
    const { client, requests } = edgeServer(rowsOf(1_000, (i) => `D${i}`), { ignoreOffset: true });
    const { pages, error } = await walk(client.paginateCitedBy("X", { limit: 100 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect((error as Error).message).toContain("the server did not advance");
    expect(requests()).toBe(2);
    expect(pages).toHaveLength(1);
  });

  it("a server that ignores offset and echoes none ends by totalEdges", async () => {
    const { client, requests } = edgeServer(rowsOf(1_000, (i) => `D${i}`), { ignoreOffset: true, offset: false });
    const { error } = await walk(client.paginateCitedBy("X", { limit: 100 }));
    expect(error).toBeUndefined();
    expect(requests()).toBe(10);
  });

  it("a server that ignores offset with neither signal throws after three repeated pages", async () => {
    const { client, requests } = edgeServer(rowsOf(1_000, (i) => `D${i}`), { ignoreOffset: true, offset: false, totalEdges: false });
    const { pages, error } = await walk(client.paginateCitedBy("X", { limit: 100 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect((error as Error).message).toContain("the server repeated the same page");
    expect(requests()).toBe(4);
    expect(pages).toHaveLength(3);
  });

  it("paginateCites applies the same rules", async () => {
    const body = { success: true, sourceDocument: "X", limit: 2, offset: 0, cites: [{ celexNumber: "A", citationCount: 2 }] };
    const { client, requests } = server(() => body);
    const { error } = await walk(client.paginateCites("X", { limit: 2 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(requests()).toBe(2);
  });

  it.each([
    ["-1", -1],
    ["2.5", 2.5],
    ['"9"', "9"],
  ])("a totalEdges of %s is not used", async (_label, totalEdges) => {
    const { client, requests } = server((url) => ({
      success: true, targetDocument: "X", limit: 2, offset: qp(url, "offset", 0), totalEdges,
      citedBy: [{ celexNumber: `D${url.searchParams.get("offset")}`, citationCount: url.searchParams.get("offset") === "4" ? 1 : 2 }],
    }));
    await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(requests()).toBe(3); // ends by the short page, not by totalEdges
  });

  it("the walk ends once the offset reaches totalEdges", async () => {
    const { client, requests } = server((url) => ({
      success: true, targetDocument: "X", limit: 2, offset: qp(url, "offset", 0), totalEdges: 4,
      citedBy: [{ celexNumber: "A", citationCount: 2 }],
    }));
    await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(requests()).toBe(2);
  });

  it("a page without its list ends the walk", async () => {
    for (const body of [{ success: true, sourceDocument: "X" }, { success: true, sourceDocument: "X", cites: null }]) {
      const { client } = server(() => body);
      const { pages, error } = await walk(client.paginateCites("X"));
      expect(error).toBeUndefined();
      expect(pages).toHaveLength(1);
    }
  });

  it.each([
    ['"2"', "2"],
    ["Infinity", 1e400],
    ["-4", -4],
    ["2.5", 2.5],
    ["null", null],
  ])("a citationCount of %s counts the edge list instead", async (_label, citationCount) => {
    const { client, requests } = server(() => ({
      success: true, targetDocument: "X", limit: 2, offset: 0,
      citedBy: [{ celexNumber: "A", citationCount, citations: [{ extractedAt: "t1" }] }],
    }));
    await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(requests()).toBe(1); // one edge < limit 2: a short page
  });

  it("a citationCount of 0 is a count when the group has no edges", async () => {
    const { client, requests } = server(() => ({
      success: true, targetDocument: "X", limit: 2, offset: 0,
      citedBy: [{ celexNumber: "A", citationCount: 0, citations: [] }],
    }));
    await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(requests()).toBe(1); // 0 rows: the walk ends
  });

  it("a citationCount of 0 next to a non-empty edge list counts the list", async () => {
    const { client, requests } = server((url) => ({
      success: true, targetDocument: "X", limit: 2, offset: qp(url, "offset", 0),
      citedBy: url.searchParams.get("offset") === "0"
        ? [{ celexNumber: "A", citationCount: 0, citations: [{ extractedAt: "t1" }, { extractedAt: "t2" }] }]
        : [],
    }));
    await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(requests()).toBe(2); // 2 rows: a full page, then an empty one
  });

  it("an edge nested 100,000 levels deep is compared without a RangeError", async () => {
    const deep = "[".repeat(100_000) + "1" + "]".repeat(100_000);
    const body = `{"success":true,"targetDocument":"X","limit":1,"citedBy":[{"celexNumber":"A","citations":[${deep}]}]}`;
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      return new Response(body, { status: 200 });
    });
    const client = new LexAPI({ apiKey: "k", baseUrl: BASE, fetch: fetchFn, retry: { maxRetries: 0 } });
    const { error } = await walk(client.paginateCitedBy("X", { limit: 1 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(calls).toBe(4);
  });
});

describe("compactForm", () => {
  it("tells apart what JSON tells apart", () => {
    const values = [[], {}, [","], ["", ""], { a: 1 }, { a: "1" }, { "a,": 1 }, [1, [2]], [[1], 2], null, "null", [null], true, "x"];
    const forms = values.map(compactForm);
    expect(new Set(forms).size).toBe(values.length);
    for (const v of values) expect(compactForm(v)).toBe(JSON.stringify(v));
  });
});

// ── national documents ──────────────────────────────────────────────────

function nationalServer(n: number, limit: number) {
  return server((url) => {
    const start = url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")!.slice(1)) : 0;
    const results = Array.from({ length: Math.min(limit, n - start) }, (_, i) => ({ id: `AT-${start + i}` }));
    const more = start + limit < n;
    return { jurisdiction: "AT", total: n, totalExact: true, limit, includeRepealed: false, hasMore: more, nextCursor: more ? `c${start + limit}` : null, results };
  });
}

describe("paginateNationalDocuments", () => {
  it("a well-formed walk of 10,000 documents yields every page as served", async () => {
    const { client, fetchFn } = nationalServer(10_000, 100);
    const { pages, error } = await walk(client.paginateNationalDocuments("AT", { limit: 100 }));
    expect(error).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(100);
    expect(pages.flatMap((p) => p.results.map((r) => r.id))).toEqual(Array.from({ length: 10_000 }, (_, i) => `AT-${i}`));
  });

  it("a cursor already sent throws; the page that returned it is not yielded and is on err.body", async () => {
    const { client, requests } = server(() => ({ jurisdiction: "AT", hasMore: true, nextCursor: "c1", results: [{ id: "AT-1" }] }));
    const { pages, error } = await walk(client.paginateNationalDocuments("AT"));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect((error as InvalidResponseError).message).toContain("the server repeated a page cursor");
    expect((error as InvalidResponseError).status).toBe(200);
    expect((error as InvalidResponseError).code).toBe("INVALID_RESPONSE");
    expect(((error as InvalidResponseError).body as { nextCursor: string }).nextCursor).toBe("c1");
    expect(requests()).toBe(2);
    expect(pages).toHaveLength(1);
  });

  it.each([["a number", 5], ["an object", { c: 1 }], ["true", true], ["false", false]])(
    "a nextCursor that is %s throws while hasMore is true",
    async (_label, nextCursor) => {
      const { client, requests } = server(() => ({ jurisdiction: "AT", hasMore: true, nextCursor, results: [{ id: "AT-1" }] }));
      const { pages, error } = await walk(client.paginateNationalDocuments("AT"));
      expect(error).toBeInstanceOf(InvalidResponseError);
      expect((error as Error).message).toContain("not a string");
      expect(requests()).toBe(1);
      expect(pages).toHaveLength(0);
    },
  );

  it.each([["false", false], ["absent", undefined], ["1", 1], ['"true"', "true"], ["null", null]])(
    "hasMore %s (not true) ends the walk",
    async (_label, hasMore) => {
      const { client, requests } = server(() => ({ jurisdiction: "AT", hasMore, nextCursor: "c1", results: [{ id: "AT-1" }] }));
      const { pages, error } = await walk(client.paginateNationalDocuments("AT"));
      expect(error).toBeUndefined();
      expect(requests()).toBe(1);
      expect(pages).toHaveLength(1);
    },
  );

  it("the resumed cursor counts as sent", async () => {
    const { client, requests } = server(() => ({ jurisdiction: "AT", hasMore: true, nextCursor: "start", results: [{ id: "AT-1" }] }));
    const { error } = await walk(client.paginateNationalDocuments("AT", { cursor: "start" }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(requests()).toBe(1);
  });

  it("the same documents under a new cursor are not a stall", async () => {
    const { client, requests } = server((_, call) => ({
      jurisdiction: "AT", hasMore: call < 4, nextCursor: `c${call + 1}`, results: [{ id: "AT-1" }],
    }));
    const { pages, error } = await walk(client.paginateNationalDocuments("AT"));
    expect(error).toBeUndefined();
    expect(requests()).toBe(5);
    expect(pages).toHaveLength(5);
  });

  it.each([["an empty string", ""], ["null", null], ["absent", undefined]])("a nextCursor that is %s ends the walk", async (_label, nextCursor) => {
    const { client, requests } = server(() => ({ jurisdiction: "AT", hasMore: true, nextCursor, results: [{ id: "AT-1" }] }));
    const { pages, error } = await walk(client.paginateNationalDocuments("AT"));
    expect(error).toBeUndefined();
    expect(requests()).toBe(1);
    expect(pages).toHaveLength(1);
  });

  it("a page without results ends the walk", async () => {
    const { client } = server(() => ({ jurisdiction: "AT", hasMore: true, nextCursor: "c1" }));
    const { pages, error } = await walk(client.paginateNationalDocuments("AT"));
    expect(error).toBeUndefined();
    expect(pages).toHaveLength(1);
  });
});

describe("stall checks, finer points", () => {
  it("every stall error is INVALID_RESPONSE with status 200 and the stalled page on body", async () => {
    const page = { success: true, targetDocument: "X", limit: 2, offset: 0, citedBy: [{ celexNumber: "A", citationCount: 2 }] };
    const { client } = server(() => page);
    const { pages, error } = await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(pages).toHaveLength(1);
    const e = error as InvalidResponseError;
    expect(e.code).toBe("INVALID_RESPONSE");
    expect(e.status).toBe(200);
    expect((e.body as { offset: number }).offset).toBe(0);
    const d = server(() => ({ success: true, deliveries: [{ id: "a" }] }));
    const de = (await walk(d.client.webhooks.paginateDeliveries("w", { limit: 1 }))).error as InvalidResponseError;
    expect([de.code, de.status]).toEqual(["INVALID_RESPONSE", 200]);
    expect(de.body).toEqual({ success: true, deliveries: [{ id: "a" }], headers: expect.anything() });
  });

  it("a page with a position signal resets a run of repeated pages (cited-by)", async () => {
    const group = [{ celexNumber: "A", citationCount: 2 }];
    // Two repeats, then a page with totalEdges (not counted), then two repeats:
    // never three counted in a row.
    const signal = [false, false, false, true, false, false];
    const { client, requests } = server((_, call) => ({
      success: true, targetDocument: "X", limit: 2, ...(signal[call] ? { totalEdges: 1000 } : {}),
      citedBy: call < 6 ? group : [{ celexNumber: "A", citationCount: 1 }],
    }));
    const { pages, error } = await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(error).toBeUndefined();
    expect(requests()).toBe(7);
    expect(pages).toHaveLength(7);
  });

  it("a page with a usable total resets a run of repeated deliveries", async () => {
    const withTotal = [false, false, false, true, false, false];
    const { client, requests } = server((_, call) => ({
      success: true, ...(withTotal[call] ? { total: 1e6 } : {}), deliveries: call < 6 ? [{ id: "a" }] : [],
    }));
    const { error } = await walk(client.webhooks.paginateDeliveries("w", { limit: 1 }));
    expect(error).toBeUndefined();
    expect(requests()).toBe(7);
  });

  it("repeats compare the list only, whatever the key order", async () => {
    const { client, requests } = server((_, call) => ({
      success: true, targetDocument: "X", limit: 2, requestId: `r${call}`,
      citedBy: call % 2 ? [{ citationCount: 2, celexNumber: "A" }] : [{ celexNumber: "A", citationCount: 2 }],
    }));
    const { error } = await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(requests()).toBe(4);
  });

  it("an echoed offset or limit that is not a non-negative integer is not a signal", async () => {
    const { client, requests } = server((url) => ({
      success: true, targetDocument: "X", offset: "0", limit: 2.5,
      citedBy: url.searchParams.get("offset") === "4" ? [{ celexNumber: "C", citationCount: 1 }] : [{ celexNumber: `B${url.searchParams.get("offset")}`, citationCount: 2 }],
    }));
    const { error } = await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(error).toBeUndefined();
    expect(requests()).toBe(3);
  });

  it.each([2.5, -1, 1e400])("an echoed numeric offset of %s is not a signal (no throw)", async (echoed) => {
    const { client, requests } = server((url) => ({
      success: true, targetDocument: "X", limit: 2, offset: echoed, totalEdges: 3,
      citedBy: [{ celexNumber: `B${url.searchParams.get("offset")}`, citationCount: 2 }],
    }));
    const { error } = await walk(client.paginateCitedBy("X", { limit: 2 }));
    expect(error).toBeUndefined();
    expect(requests()).toBe(2); // ends by totalEdges
  });

  it("an echoed offset of 3e1 or 30.0 is the integer 30", async () => {
    const body = '{"success":true,"targetDocument":"X","limit":2,"offset":3e1,"citedBy":[{"celexNumber":"A","citationCount":1}]}';
    const fetchFn = vi.fn(async () => new Response(body, { status: 200 }));
    const client = new LexAPI({ apiKey: "k", baseUrl: BASE, fetch: fetchFn, retry: { maxRetries: 0 } });
    const { error } = await walk(client.paginateCitedBy("X", { limit: 2, offset: 30 }));
    expect(error).toBeUndefined();
  });
});

describe("starting offset and limit", () => {
  const never = () => {
    throw new Error("no request expected");
  };
  it.each([
    ["offset", { offset: "250" }],
    ["offset", { offset: 2.5 }],
    ["offset", { offset: -1 }],
    ["limit", { limit: 0 }],
    ["limit", { limit: "100" }],
    ["limit", { limit: 1.5 }],
  ])("a %s of %j is a RangeError before any request", async (_name, params) => {
    const { client, fetchFn } = server(never);
    const walks: AsyncIterable<unknown>[] = [client.paginateCites("X", params as never), client.paginateCitedBy("X", params as never), client.webhooks.paginateDeliveries("w", params as never)];
    for (const it of walks) {
      const { error } = await walk(it);
      expect(error).toBeInstanceOf(RangeError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
