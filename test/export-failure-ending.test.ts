/**
 * Export failure endings (PLAN.md §1.8): a stream is complete only when it
 * ends with a `_done` trailer that does not say `complete: false`, and a line
 * whose only key is `_error` is a failure signal, never a row.
 *
 * lex-api PR #303 briefly emitted `{"_error": ...}` then
 * `{"_done": {"complete": false}}` on a mid-stream failure; the server no
 * longer does (it ends the body without a trailer), but a stream like that
 * must never look complete or yield the error object as a document.
 */
import { describe, expect, it } from "vitest";

import { IncompleteExportError, LexAPI, type ExportRow, type ExportStream } from "../src/index.js";
import { FAST_RETRY, fetchSequence } from "./helpers.js";

function ndjson(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

async function open(text: string): Promise<ExportStream> {
  const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchSequence(ndjson(text)), retry: FAST_RETRY });
  return client.export();
}

async function drain(stream: ExportStream): Promise<{ rows: ExportRow[]; error: unknown }> {
  const rows: ExportRow[] = [];
  try {
    for await (const row of stream) rows.push(row);
    return { rows, error: undefined };
  } catch (error) {
    return { rows, error };
  }
}

const FAILURE_STREAM =
  '{"_meta":{}}\n' +
  '{"celex":"A"}\n' +
  '{"celex":"B"}\n' +
  '{"_error":{"code":"INTERNAL","message":"x"}}\n' +
  '{"_done":{"written":2,"complete":false}}\n';

describe("export failure endings", () => {
  it("an _error line then a complete:false _done is incomplete; the error is never a row", async () => {
    const stream = await open(FAILURE_STREAM);
    const { rows, error } = await drain(stream);
    expect(rows).toEqual([{ celex: "A" }, { celex: "B" }]);
    expect(error).toBeInstanceOf(IncompleteExportError);
    expect((error as IncompleteExportError).details).toEqual({ code: "INTERNAL", message: "x" });
    expect((error as IncompleteExportError).rowsRead).toBe(2);
    expect(stream.complete).toBe(false);
    expect(stream.error).toEqual({ code: "INTERNAL", message: "x" });
  });

  it("a _done with complete:false alone is incomplete", async () => {
    const stream = await open('{"_meta":{}}\n{"celex":"A"}\n{"_done":{"written":1,"complete":false}}\n');
    const { rows, error } = await drain(stream);
    expect(rows).toEqual([{ celex: "A" }]);
    expect(error).toBeInstanceOf(IncompleteExportError);
    expect(String((error as Error).message)).toContain("complete: false");
    expect(stream.complete).toBe(false);
  });

  it("an _error line without a _done is incomplete and not yielded", async () => {
    const stream = await open('{"_meta":{}}\n{"celex":"A"}\n{"_error":{"code":"INTERNAL","message":"x"}}\n');
    const { rows, error } = await drain(stream);
    expect(rows).toEqual([{ celex: "A" }]);
    expect(error).toBeInstanceOf(IncompleteExportError);
  });

  it("an _error as the first line is not taken as a row", async () => {
    const stream = await open('{"_error":{"code":"INTERNAL","message":"x"}}\n{"_done":{"written":0,"complete":false}}\n');
    const { rows, error } = await drain(stream);
    expect(rows).toEqual([]);
    expect(error).toBeInstanceOf(IncompleteExportError);
  });

  it("a missing _done is still incomplete", async () => {
    const stream = await open('{"_meta":{}}\n{"celex":"A"}\n{"celex":"B"}\n');
    const { rows, error } = await drain(stream);
    expect(rows).toEqual([{ celex: "A" }, { celex: "B" }]);
    expect(error).toBeInstanceOf(IncompleteExportError);
    expect((error as IncompleteExportError).details).toBeUndefined();
  });

  it("re-iterating a failed stream still throws", async () => {
    const stream = await open(FAILURE_STREAM);
    await drain(stream);
    const again = await drain(stream);
    expect(again.error).toBeInstanceOf(IncompleteExportError);
  });

  it("a complete stream with the new _done fields stays complete", async () => {
    const done = {
      _done: {
        written: 2,
        complete: true,
        truncated: false,
        truncatedBy: null,
        skippedStubs: 1,
        credits: { reserved: 3, charged: 2, refunded: 1, remaining: 998 },
      },
    };
    const stream = await open('{"_meta":{}}\n{"celex":"A"}\n{"celex":"B"}\n' + JSON.stringify(done) + "\n");
    const { rows, error } = await drain(stream);
    expect(error).toBeUndefined();
    expect(rows).toEqual([{ celex: "A" }, { celex: "B" }]);
    expect(stream.complete).toBe(true);
    expect(stream.done?.written).toBe(2);
    expect((stream.done?.credits as { charged: number }).charged).toBe(2);
  });

  it("a _done without a complete field is complete", async () => {
    const stream = await open('{"_meta":{}}\n{"celex":"A"}\n{"_done":{"written":1,"truncated":false}}\n');
    const { error } = await drain(stream);
    expect(error).toBeUndefined();
    expect(stream.complete).toBe(true);
  });
});
