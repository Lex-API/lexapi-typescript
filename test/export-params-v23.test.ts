/**
 * Export parameters for API 2.3.0 (lex-api #303): `documentTypeCode`,
 * `changedSince`, and the one client-side check that mirrors the server's
 * 400 exactly (`limit` a positive integer).
 */
import { describe, expect, it } from "vitest";

import { LexAPI } from "../src/index.js";
import { FAST_RETRY, fetchSequence } from "./helpers.js";

const BODY = '{"_meta":{}}\n{"_done":{"written":0}}\n';
const ndjson = () => new Response(BODY, { status: 200, headers: { "content-type": "application/x-ndjson" } });

function requestUrl(fetchMock: ReturnType<typeof fetchSequence>): URL {
  const input = fetchMock.mock.calls[0] as unknown[];
  const first = input[0];
  return new URL(first instanceof Request ? first.url : String(first));
}

describe("export params (API 2.3.0)", () => {
  it("sends documentTypeCode, changedSince (Date → UTC ISO) and fetchedSince strings as given", async () => {
    const fetchMock = fetchSequence(ndjson());
    const client = new LexAPI({ apiKey: "k", fetch: fetchMock, retry: FAST_RETRY });
    const stream = await client.export({
      documentTypeCode: ["regulation", "directive"],
      changedSince: new Date("2026-05-11T10:30:00Z"),
      fetchedSince: "2026-05-11",
      dateFrom: "2020-01-01",
      limit: 10,
    });
    for await (const row of stream) void row;
    expect(Object.fromEntries(requestUrl(fetchMock).searchParams)).toEqual({
      documentTypeCode: "regulation,directive",
      changedSince: "2026-05-11T10:30:00.000Z",
      fetchedSince: "2026-05-11",
      dateFrom: "2020-01-01",
      limit: "10",
    });
  });

  it.each([0, -5, 2.5, Number.NaN])("limit %s throws RangeError before any request", async (bad) => {
    const fetchMock = fetchSequence(ndjson());
    const client = new LexAPI({ apiKey: "k", fetch: fetchMock, retry: FAST_RETRY });
    await expect(client.export({ limit: bad })).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a large limit is left for the server to clamp", async () => {
    const fetchMock = fetchSequence(ndjson());
    const client = new LexAPI({ apiKey: "k", fetch: fetchMock, retry: FAST_RETRY });
    await client.export({ limit: 999_999 });
    expect(requestUrl(fetchMock).searchParams.get("limit")).toBe("999999");
  });
});
