import { describe, expect, it, vi } from "vitest";

import { LexAPI, LexAPIError, TierForbiddenError, type ExportRow } from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

function client(fetchMock: typeof fetch) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });
}

const META_LINE = JSON.stringify({ _meta: true, filters: { documentType: "regulation" }, total: 2 });
const ROW_1 = JSON.stringify({
  celex: "32016R0679",
  language: "en",
  title: "GDPR",
  documentType: "Regulation",
  documentTypeCode: "regulation",
  version: 3,
  contentHash: "abc123",
  parsedContent: { articles: [] },
});
const ROW_2 = JSON.stringify({
  celex: "62018CJ0311",
  language: "en",
  title: "Schrems II",
  documentTypeCode: "judgment",
  ecli: "ECLI:EU:C:2020:559",
  caseNumber: "C-311/18",
});
const DONE_LINE = JSON.stringify({ _done: true, truncated: false, streamed: 2 });

/** NDJSON body chunked mid-line to exercise the stream buffer. */
function ndjsonResponse(text: string, headers?: Record<string, string>): Response {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < text.length; i += 7) chunks.push(encoder.encode(text.slice(i, i + 7)));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson", ...headers },
  });
}

describe("export", () => {
  it("streams rows, exposing _meta before iteration and _done after", async () => {
    const text = [META_LINE, ROW_1, ROW_2, DONE_LINE].join("\n") + "\n";
    const fetchMock = fetchSequence(
      ndjsonResponse(text, {
        "x-export-total": "2",
        "x-export-streaming": "2",
        "x-export-truncated": "0",
      }),
    );

    const stream = await client(fetchMock).export({ documentType: "regulation", limit: 100 });

    // _meta parsed eagerly, before any row is consumed
    expect(stream.meta).toMatchObject({ _meta: true, total: 2 });
    expect(stream.done).toBeUndefined();
    expect(stream.headers).toEqual({ total: 2, streaming: 2, truncated: false });

    const rows: ExportRow[] = [];
    for await (const row of stream) rows.push(row);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.celex).toBe("32016R0679");
    expect(rows[1]?.ecli).toBe("ECLI:EU:C:2020:559");
    // envelope lines are never yielded as rows
    expect(rows.some((r) => "_meta" in r || "_done" in r)).toBe(false);
    expect(stream.done).toMatchObject({ _done: true, truncated: false, streamed: 2 });

    const parsed = new URL((fetchMock.mock.calls[0]! as unknown as [string])[0]);
    expect(parsed.pathname).toBe("/api/v1/export");
    expect(parsed.searchParams.get("documentType")).toBe("regulation");
    expect(parsed.searchParams.get("limit")).toBe("100");
  });

  it("serializes boolean params and omits undefined ones", async () => {
    const text = [META_LINE, DONE_LINE].join("\n");
    const fetchMock = fetchSequence(ndjsonResponse(text));

    await client(fetchMock).export({ includeHtml: true, includeContent: false, subdomain: "case-law" });

    const parsed = new URL((fetchMock.mock.calls[0]! as unknown as [string])[0]);
    expect(parsed.searchParams.get("includeHtml")).toBe("true");
    expect(parsed.searchParams.get("includeContent")).toBe("false");
    expect(parsed.searchParams.get("subdomain")).toBe("case-law");
    expect(parsed.searchParams.has("dateFrom")).toBe(false);
  });

  it("reports truncation via _done and the X-Export-Truncated header", async () => {
    const text = [META_LINE, ROW_1, JSON.stringify({ _done: true, truncated: true })].join("\n");
    const fetchMock = fetchSequence(ndjsonResponse(text, { "x-export-truncated": "1" }));

    const stream = await client(fetchMock).export();
    expect(stream.headers.truncated).toBe(true);

    const rows: ExportRow[] = [];
    for await (const row of stream) rows.push(row);

    expect(rows).toHaveLength(1);
    expect(stream.done?.truncated).toBe(true);
  });

  it("handles an empty export (meta + done only)", async () => {
    const text = [META_LINE, JSON.stringify({ _done: true, truncated: false, streamed: 0 })].join("\n");
    const fetchMock = fetchSequence(ndjsonResponse(text));

    const stream = await client(fetchMock).export();
    const rows: ExportRow[] = [];
    for await (const row of stream) rows.push(row);

    expect(rows).toHaveLength(0);
    expect(stream.done?.["streamed"]).toBe(0);
  });

  it("is single-pass: a second iteration throws", async () => {
    const text = [META_LINE, ROW_1, DONE_LINE].join("\n");
    const fetchMock = fetchSequence(ndjsonResponse(text));

    const stream = await client(fetchMock).export();
    for await (const _row of stream) void _row;

    await expect(async () => {
      for await (const _row of stream) void _row;
    }).rejects.toThrow(/single-pass/);
  });

  it("throws a typed error on malformed NDJSON lines", async () => {
    const text = [META_LINE, "{not json", DONE_LINE].join("\n");
    const fetchMock = fetchSequence(ndjsonResponse(text));

    const stream = await client(fetchMock).export();

    await expect(async () => {
      for await (const _row of stream) void _row;
    }).rejects.toThrow(LexAPIError);
  });

  it("maps the tier gate (legacy-shape 403, as the server sends it) to TierForbiddenError", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(403, {
        error: "Bulk export is a BUSINESS-tier feature",
        message: "Upgrade your plan to export the LexAPI corpus in bulk.",
        upgradeUrl: "/pricing",
      }),
    );

    const error = await client(fetchMock).export().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TierForbiddenError);
    expect((error as TierForbiddenError).body).toMatchObject({ upgradeUrl: "/pricing" });
  });

  it("still maps a typed TIER_FORBIDDEN envelope on any status", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(402, {
        success: false,
        error: { code: "TIER_FORBIDDEN", message: "Subscription does not include corpus export" },
      }),
    );

    await expect(client(fetchMock).export()).rejects.toThrow(TierForbiddenError);
  });

  it("retries the GET on 503 before the stream starts", async () => {
    const text = [META_LINE, DONE_LINE].join("\n");
    const fetchMock = fetchSequence(
      jsonResponse(503, { success: false, error: { code: "UPSTREAM_ERROR", message: "busy" } }),
      ndjsonResponse(text),
    );

    const stream = await client(fetchMock).export();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stream.meta).toBeDefined();
  });
});

describe("export — server envelope shape (exportController @ 633eb67)", () => {
  // The real server nests the envelope fields: {"_meta": {...}} / {"_done": {...}}.
  const REAL_META = JSON.stringify({
    _meta: {
      filters: { documentType: ["Regulation"], author: null, subdomain: null, language: "en", dateFrom: null, dateTo: null, fetchedSince: null },
      totalMatching: 3,
      streaming: 3,
      truncated: false,
      includeHtml: false,
      includeContent: true,
      exportedAt: "2026-10-26T08:00:00.000Z",
    },
  });
  const REAL_DONE = JSON.stringify({ _done: { written: 2, truncated: false, skippedStubs: 1 } });

  it("lifts the nested _meta / _done fields so stream.done.truncated works", async () => {
    const fetchMock = fetchSequence(
      ndjsonResponse([REAL_META, ROW_1, ROW_2, REAL_DONE].join("\n") + "\n", {
        "x-export-total": "3",
        "x-export-streaming": "3",
        "x-export-truncated": "0",
      }),
    );

    const stream = await client(fetchMock).export({ includeStubs: false });

    expect(stream.meta?.totalMatching).toBe(3);
    expect(stream.meta?.filters?.documentType).toEqual(["Regulation"]);
    expect(stream.meta?._meta).toBeDefined(); // raw envelope still available

    const rows: ExportRow[] = [];
    for await (const row of stream) rows.push(row);

    expect(rows).toHaveLength(2);
    expect(stream.done?.written).toBe(2);
    expect(stream.done?.truncated).toBe(false);
    expect(stream.done?.skippedStubs).toBe(1);
  });

  it("reports the row cap from the nested _done", async () => {
    const done = JSON.stringify({ _done: { written: 1, truncated: true, skippedStubs: 0 } });
    const fetchMock = fetchSequence(ndjsonResponse([REAL_META, ROW_1, done].join("\n"), { "x-export-truncated": "1" }));

    const stream = await client(fetchMock).export({ limit: 1 });
    for await (const _row of stream) void _row;

    expect(stream.done?.truncated).toBe(true);
    expect(stream.headers.truncated).toBe(true);
  });

  it("sends includeStubs and comma-joins array filters", async () => {
    const fetchMock = fetchSequence(ndjsonResponse([REAL_META, REAL_DONE].join("\n")));

    await client(fetchMock).export({
      documentType: ["Regulation", "Directive"],
      author: "European Commission",
      subdomain: ["legislation", "case-law"],
      includeStubs: true,
      fetchedSince: "2026-10-01T00:00:00Z",
    });

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("documentType")).toBe("Regulation,Directive");
    expect(parsed.searchParams.get("author")).toBe("European Commission");
    expect(parsed.searchParams.get("subdomain")).toBe("legislation,case-law");
    expect(parsed.searchParams.get("includeStubs")).toBe("true");
    expect(parsed.searchParams.get("fetchedSince")).toBe("2026-10-01T00:00:00Z");
    expect((init.headers as Record<string, string>)["accept"]).toContain("application/x-ndjson");
  });

  it("cancels the body when the consumer stops early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([REAL_META, ROW_1, ROW_2].join("\n") + "\n"));
        // never closes: simulates a long export still streaming
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));

    const stream = await client(fetchMock as unknown as typeof fetch).export();
    for await (const row of stream) {
      expect(row.celex).toBe("32016R0679");
      break;
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });

  it("cancel() releases the connection without iterating", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(REAL_META + "\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));

    const stream = await client(fetchMock as unknown as typeof fetch).export();
    expect(stream.meta?.totalMatching).toBe(3);
    await stream.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });
});
