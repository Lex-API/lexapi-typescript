// SDK contract §1.8 and §1.9: export lines and webhook bodies are strict
// UTF-8; webhook bodies are strict JSON; a string payload that is not
// well-formed Unicode fails verification. Loopback stubs only.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IncompleteExportError,
  LexAPI,
  WebhookSignatureError,
  computeSignature,
  verifySignature,
  verifyWebhook,
} from "../src/index.js";

const BASE = "http://127.0.0.1:9/api/v1";
const enc = new TextEncoder();

afterEach(() => {
  vi.restoreAllMocks();
});

/** An export answer whose body arrives as the given chunks. */
function exportClient(chunks: Uint8Array[], contentType = "application/x-ndjson") {
  const fetchFn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    expect(String(input).startsWith("http://127.0.0.1:9/")).toBe(true);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  });
  return new LexAPI({ apiKey: "lex_test_key", baseUrl: BASE, fetch: fetchFn, retry: { maxRetries: 0 } });
}

async function readAll(client: LexAPI) {
  const stream = await client.export();
  const rows: unknown[] = [];
  for await (const row of stream) rows.push(row);
  return { rows, invalidLines: stream.invalidLines, meta: stream.meta };
}

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? Array.from(enc.encode(p)) : p)));

const META = '{"_meta":{"total":2}}\n';
const DONE = '{"_done":{"complete":true}}\n';

describe("export lines are strict UTF-8", () => {
  it.each([
    ["0xFF", [0xff]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["an overlong slash", [0xc0, 0xaf]],
    ["a truncated three-byte sequence", [0xe2, 0x82]],
    ["latin-1 text", [0x63, 0x61, 0x66, 0xe9]],
  ])("a line with %s is an invalid line; the next line is read intact", async (_label, bad) => {
    const body = bytes(META, '{"celex":"', bad, '"}\n', '{"celex":"32016R0679","t":"Größe"}\n', DONE);
    const { rows, invalidLines } = await readAll(exportClient([body]));
    expect(rows).toEqual([{ celex: "32016R0679", t: "Größe" }]);
    expect(invalidLines).toBe(1);
  });

  it("a truncated sequence at the very end of the stream is an invalid line", async () => {
    const body = bytes(META, '{"celex":"A"}\n', '{"_done":{"complete":true}}', [0xe2]);
    const stream = await exportClient([body]).export();
    const rows: unknown[] = [];
    const error = await (async () => {
      for await (const row of stream) rows.push(row);
    })().catch((e: unknown) => e);
    // The trailer line is not UTF-8, so the stream has no _done trailer.
    expect(error).toBeInstanceOf(IncompleteExportError);
    expect(rows).toEqual([{ celex: "A" }]);
    expect(stream.invalidLines).toBe(1);
  });

  it.each([
    ["a two-byte", "é"],
    ["a three-byte", "€"],
    ["a four-byte", "𝄞"],
  ])("%s character split across chunks decodes", async (_label, ch) => {
    const all = bytes(META, `{"celex":"A","t":"x${ch}y"}\n`, DONE);
    const start = all.indexOf(enc.encode(ch)[0]!);
    const n = enc.encode(ch).length;
    for (let cut = start + 1; cut < start + n; cut++) {
      const { rows, invalidLines } = await readAll(exportClient([all.slice(0, cut), all.slice(cut)]));
      expect(rows).toEqual([{ celex: "A", t: `x${ch}y` }]);
      expect(invalidLines).toBe(0);
    }
    // One byte per chunk.
    const single = Array.from(all, (b) => new Uint8Array([b]));
    const { rows } = await readAll(exportClient(single));
    expect(rows).toEqual([{ celex: "A", t: `x${ch}y` }]);
  });

  it("one leading byte order mark is ignored, also when split across chunks", async () => {
    const all = bytes([0xef, 0xbb, 0xbf], META, '{"celex":"A"}\n', DONE);
    for (const chunks of [[all], [all.slice(0, 1), all.slice(1, 2), all.slice(2)]]) {
      const { rows, invalidLines, meta } = await readAll(exportClient(chunks));
      expect(meta?.total).toBe(2);
      expect(rows).toEqual([{ celex: "A" }]);
      expect(invalidLines).toBe(0);
    }
  });

  it("a declared charset other than UTF-8 is ignored: the bytes are read as UTF-8", async () => {
    const body = bytes(META, '{"celex":"A","t":"Größe"}\n', DONE);
    for (const type of ["application/x-ndjson; charset=utf-16", "application/x-ndjson; charset=iso-8859-1"]) {
      const { rows, invalidLines } = await readAll(exportClient([body], type));
      expect(rows).toEqual([{ celex: "A", t: "Größe" }]);
      expect(invalidLines).toBe(0);
    }
  });

  it("an invalid _meta line is counted and the next line is the envelope", async () => {
    const body = bytes([0xff], "\n", META, '{"celex":"A"}\n', DONE);
    const { rows, invalidLines, meta } = await readAll(exportClient([body]));
    expect(meta?.total).toBe(2);
    expect(rows).toEqual([{ celex: "A" }]);
    expect(invalidLines).toBe(1);
  });
});

describe("webhook bodies: strict JSON and well-formed strings", () => {
  const SECRET = "whsec_test";
  const NOW = Date.parse("2026-11-19T12:00:00.000Z");
  const sign = (body: Uint8Array | string) => createHmac("sha256", SECRET).update(body).digest("hex");

  it.each([
    ["NaN", '{"timestamp":"2026-11-19T12:00:00.000Z","x":NaN}'],
    ["Infinity", '{"timestamp":"2026-11-19T12:00:00.000Z","x":Infinity}'],
    ["-Infinity", '{"timestamp":"2026-11-19T12:00:00.000Z","x":-Infinity}'],
    ["text after the value", '{"timestamp":"2026-11-19T12:00:00.000Z"} {}'],
    ["a trailing comma", '{"timestamp":"2026-11-19T12:00:00.000Z",}'],
    ["only whitespace", "  \n"],
  ])("%s is malformed_body", async (_label, text) => {
    const body = enc.encode(text);
    const error = await verifyWebhook(body, sign(body), SECRET, { now: NOW }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect((error as WebhookSignatureError).reason).toBe("malformed_body");
  });

  it.each([
    ["a lone high surrogate", "\uD800"],
    ["a lone low surrogate", "\uDC00"],
    ["a reversed pair", "\uDC00\uD800"],
    ["a high surrogate at the end", "x\uD83D"],
  ])("a string body with %s fails verification", async (_label, bad) => {
    const text = `{"timestamp":"2026-11-19T12:00:00.000Z","x":"${bad}"}`;
    // The signature a server would send for the repaired (U+FFFD) bytes.
    const repaired = sign(enc.encode(text));
    expect(await verifySignature(text, repaired, SECRET)).toBe(false);
    const error = await verifyWebhook(text, repaired, SECRET, { now: NOW }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect((error as WebhookSignatureError).reason).toBe("invalid_signature");
    const computed = await computeSignature(text, SECRET).catch((e: unknown) => e);
    expect(computed).toBeInstanceOf(WebhookSignatureError);
    expect((computed as WebhookSignatureError).reason).toBe("malformed_body");
  });

  it("a well-formed surrogate pair verifies", async () => {
    const text = '{"timestamp":"2026-11-19T12:00:00.000Z","x":"𝄞"}';
    const event = await verifyWebhook(text, sign(text), SECRET, { now: NOW });
    expect((event as unknown as { x: string }).x).toBe("𝄞");
  });

  it("the check works without String.prototype.isWellFormed (Node 18)", async () => {
    const proto = String.prototype as unknown as { isWellFormed?: unknown };
    const original = proto.isWellFormed;
    proto.isWellFormed = undefined;
    try {
      const good = '{"timestamp":"2026-11-19T12:00:00.000Z","x":"𝄞"}';
      expect(await verifySignature(good, sign(good), SECRET)).toBe(true);
      for (const bad of ["\uD800", "\uDC00", "a\uDC00\uD800b", "\uD83D"]) {
        const text = `{"x":"${bad}"}`;
        expect(await verifySignature(text, sign(enc.encode(text)), SECRET), JSON.stringify(bad)).toBe(false);
      }
    } finally {
      proto.isWellFormed = original;
    }
  });

  it("an empty secret is still reported first", async () => {
    const error = await verifySignature("\uD800", "0".repeat(64), "").catch((e: unknown) => e);
    expect((error as WebhookSignatureError).reason).toBe("missing_secret");
  });
});
