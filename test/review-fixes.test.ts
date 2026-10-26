/**
 * Regression tests for the adversarial review of PR #8 (S1–S12, N1–N12).
 * Network behaviour runs against a real local `node:http` server so body
 * stalls, mid-stream disconnects and socket closes are real, not mocked.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  InternalServerError,
  InvalidResponseError,
  LexAPI,
  LexAPIError,
  NetworkError,
  NotFoundError,
  RequestAbortedError,
  ServiceUnavailableError,
  IncompleteExportError,
  TimeoutError,
  UpstreamError,
  WebhookSignatureError,
  computeSignature,
  verifyWebhook,
  isLexAPIError,
  verifySignature,
} from "../src/index.js";
import { HttpClient } from "../src/http.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseUrl = "";
let handler: Handler = (_req, res) => res.end();
const sockets = new Set<import("node:net").Socket>();
let lastSocketClosedEarly: boolean | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.on("close", () => {
      lastSocketClosedEarly = !res.writableEnded;
    });
    handler(req, res);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function real(opts: { timeoutMs?: number; maxRetries?: number } = {}) {
  return new LexAPI({
    apiKey: "lex_secret_key_123",
    baseUrl,
    timeoutMs: opts.timeoutMs ?? 2_000,
    retry: { maxRetries: opts.maxRetries ?? 0, baseDelayMs: 1, maxDelayMs: 5 },
  });
}

const META = JSON.stringify({ _meta: { totalMatching: 3, streaming: 3, truncated: false } });
const ROW = JSON.stringify({ celex: "32016R0679", title: "GDPR" });
const DONE = JSON.stringify({ _done: { written: 1, truncated: false, skippedStubs: 0 } });

describe("S1 — export ending without _done", () => {
  it("throws IncompleteExportError (with rowsRead) instead of finishing quietly", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${META}\n${ROW}\n`);
    };
    const stream = await real().export();
    const rows: unknown[] = [];
    const error = await (async () => {
      for await (const row of stream) rows.push(row);
    })().catch((e: unknown) => e);
    expect(rows).toHaveLength(1);
    expect(error).toBeInstanceOf(IncompleteExportError);
    expect((error as IncompleteExportError).rowsRead).toBe(1);
    expect(stream.complete).toBe(false);
    expect(stream.rowsRead).toBe(1);
    expect((error as IncompleteExportError).code).toBe("INCOMPLETE_EXPORT");
    expect(stream.done).toBeUndefined();
  });

  it("still completes normally when the trailer arrives", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${META}\n${ROW}\n${DONE}\n`);
    };
    const stream = await real().export();
    for await (const _row of stream) void _row;
    expect(stream.done?.written).toBe(1);
  });
});

describe("S2 — mid-stream disconnect", () => {
  it("throws NetworkError (a LexAPIError) carrying the row count", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${META}\n${ROW}\n`);
      setTimeout(() => res.socket?.destroy(), 30);
    };
    const stream = await real().export();
    const error = await (async () => {
      for await (const _row of stream) void _row;
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toBeInstanceOf(LexAPIError);
    expect((error as NetworkError).message).toContain("after 1 rows");
  });
});

describe("S3 — the timeout covers the body", () => {
  it("times out a JSON call whose server sends headers and then stalls", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"a":');
    };
    const started = Date.now();
    const error = await real({ timeoutMs: 300 }).getInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("§1.6: the timeout is an inactivity limit — a slow body that keeps sending bytes completes", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const parts = ['{"service":', '"Lex', 'API"', ',"x":1', "}"];
      let i = 0;
      const tick = setInterval(() => {
        res.write(parts[i++]);
        if (i === parts.length) {
          clearInterval(tick);
          res.end();
        }
      }, 150);
    };
    // 5 chunks × 150 ms = ~750 ms total, well over the 300 ms timeout.
    const info = await real({ timeoutMs: 300 }).getCitationStats();
    expect((info as unknown as { service: string }).service).toBe("LexAPI");
  });

  it("times out a stalled error body too", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.write('{"error":');
    };
    const error = await real({ timeoutMs: 300 }).getInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
  });

  it("applies an idle timeout to export reads and closes the connection", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${META}\n${ROW}\n`);
    };
    lastSocketClosedEarly = undefined;
    const stream = await real({ timeoutMs: 300 }).export();
    const error = await (async () => {
      for await (const _row of stream) void _row;
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).message).toContain("after 1 rows");
    await vi.waitFor(() => expect(lastSocketClosedEarly).toBe(true));
  });
});

describe("S4 — read-only POST retries only app-generated 5xx", () => {
  const optIn = (fetchMock: typeof fetch) =>
    new LexAPI({ apiKey: "lex_k", fetch: fetchMock, retry: { ...FAST_RETRY, retryReadOnlyPosts: true } });
  const OK = () => jsonResponse(200, { success: true, results: [] });

  it("retries an app 502 identified by X-LexAPI-Version", async () => {
    const fetchMock = fetchSequence(new Response("x", { status: 502, headers: { "x-lexapi-version": "2.1.0" } }), OK());
    await optIn(fetchMock).search({ query: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries an app 504 identified by RateLimit-Limit (pre-#299 deploys)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(504, { success: false, error: { code: "TIMEOUT", message: "upstream" } }, { "ratelimit-limit": "120" }),
      OK(),
    );
    await optIn(fetchMock).search({ query: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a JSON error envelope without either app header (origin unknown)", async () => {
    const fetchMock = fetchSequence(jsonResponse(502, { error: "Upstream service error", message: "…" }), OK());
    await expect(optIn(fetchMock).semanticSearch({ query: "x" })).rejects.toThrow(LexAPIError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a proxy-generated 502/503/504 (unknown origin — may be billed)", async () => {
    for (const res of [
      () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
      () => new Response("Service Unavailable", { status: 503 }),
      () => new Response("", { status: 504 }),
    ]) {
      const fetchMock = fetchSequence(res(), OK());
      await expect(optIn(fetchMock).search({ query: "x" })).rejects.toThrow(LexAPIError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe("S9 — the API key never leaks through inspect / JSON", () => {
  it("redacts the key in util.inspect, console-style formatting and JSON.stringify", () => {
    const client = new LexAPI({ apiKey: "lex_secret_key_123", baseUrl });
    expect(inspect(client, { depth: 10, showHidden: true })).not.toContain("lex_secret_key_123");
    expect(JSON.stringify(client)).not.toContain("lex_secret_key_123");
    expect(JSON.stringify({ wrapped: client })).not.toContain("lex_secret_key_123");
    const http = new HttpClient({
      apiKey: "lex_secret_key_123",
      baseUrl,
      timeoutMs: 1,
      fetchFn: fetch,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, retryReadOnlyPosts: false },
    });
    expect(inspect(http, { depth: 10, showHidden: true })).not.toContain("lex_secret_key_123");
    expect(JSON.stringify(http)).not.toContain("lex_secret_key_123");
    expect(Object.values(http as unknown as Record<string, unknown>).join(" ")).not.toContain("lex_secret_key_123");
  });

  it("still sends the key", async () => {
    let seen: string | undefined;
    handler = (req, res) => {
      seen = req.headers["x-api-key"] as string;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    await real().getInfo();
    expect(seen).toBe("lex_secret_key_123");
  });
});

describe("S10 — instanceof across two copies of the package (dual-package hazard)", () => {
  it("errors from another module instance satisfy instanceof and isLexAPIError", async () => {
    const spec = "../src/errors.ts?second-copy";
    const other = (await import(/* @vite-ignore */ spec)) as typeof import("../src/errors.js");
    expect(other.NotFoundError).not.toBe(NotFoundError); // genuinely a second copy
    const foreign = new other.NotFoundError("missing");
    expect(foreign instanceof NotFoundError).toBe(true);
    expect(foreign instanceof LexAPIError).toBe(true);
    expect(foreign instanceof UpstreamError).toBe(false);
    expect(isLexAPIError(foreign)).toBe(true);
    expect(isLexAPIError(foreign, NotFoundError)).toBe(true);
    expect(isLexAPIError(foreign, UpstreamError)).toBe(false);
    expect(isLexAPIError(new Error("x"))).toBe(false);
  });

  it("a user subclass is matched by prototype only", () => {
    class MyNotFound extends NotFoundError {}
    expect(new NotFoundError("x") instanceof MyNotFound).toBe(false);
    expect(new MyNotFound("x") instanceof NotFoundError).toBe(true);
  });

  it("WebhookSignatureError is branded too", async () => {
    const spec = "../src/webhookSignature.ts?second-copy";
    const other = (await import(/* @vite-ignore */ spec)) as typeof import("../src/webhookSignature.js");
    const foreign = new other.WebhookSignatureError("invalid_signature", "x");
    expect(foreign instanceof WebhookSignatureError).toBe(true);
  });
});

describe("S11 — AbortSignal per call", () => {
  it("aborts an in-flight request", async () => {
    handler = () => {
      /* never answers */
    };
    const controller = new AbortController();
    const pending = real({ timeoutMs: 10_000 }).getInfo({ signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user navigated away")), 50);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect((error as RequestAbortedError).code).toBe("ABORTED");
    expect(((error as RequestAbortedError).cause as Error).message).toBe("user navigated away");
  });

  it("aborts during a retry wait and never retries after", async () => {
    const fetchMock = fetchSequence(new Response("busy", { status: 503, headers: { "retry-after": "20" } }));
    const client = new LexAPI({
      apiKey: "lex_k",
      fetch: fetchMock,
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 30_000 },
    });
    const controller = new AbortController();
    const pending = client.getInfo({ signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    await expect(pending).rejects.toBeInstanceOf(RequestAbortedError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects immediately for an already-aborted signal without sending", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, {}));
    const client = new LexAPI({ apiKey: "lex_k", fetch: fetchMock });
    await expect(client.getInfo({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an export stream mid-iteration and closes the socket", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${META}\n${ROW}\n`);
    };
    lastSocketClosedEarly = undefined;
    const controller = new AbortController();
    const stream = await real({ timeoutMs: 10_000 }).export({}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const error = await (async () => {
      for await (const _row of stream) void _row;
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestAbortedError);
    await vi.waitFor(() => expect(lastSocketClosedEarly).toBe(true));
  });
});

describe("N1 / N2 / N3 — status, body and Retry-After edge cases", () => {
  it("N1: unmapped 4xx are code INTERNAL per §1.3 but NOT an InternalServerError; status is kept", async () => {
    const e409 = await new LexAPI({ apiKey: "k", fetch: fetchSequence(new Response("", { status: 409 })) })
      .getInfo()
      .catch((e: unknown) => e as LexAPIError) as LexAPIError;
    expect(e409.code).toBe("INTERNAL");
    expect(e409.status).toBe(409);
    expect(e409).toBeInstanceOf(LexAPIError);
    expect(e409).not.toBeInstanceOf(InternalServerError);
    const e413 = await new LexAPI({ apiKey: "k", fetch: fetchSequence(new Response("too big", { status: 413 })) })
      .getInfo()
      .catch((e: unknown) => e as LexAPIError) as LexAPIError;
    expect(e413.status).toBe(413);
    expect(e413).not.toBeInstanceOf(InternalServerError);
    const e507 = await new LexAPI({ apiKey: "k", fetch: fetchSequence(new Response("", { status: 507 })) })
      .getInfo()
      .catch((e: unknown) => e as LexAPIError) as LexAPIError;
    expect(e507).toBeInstanceOf(InternalServerError);
  });

  it("N2: a 200 with a non-JSON body throws InvalidResponseError", async () => {
    const fetchMock = fetchSequence(new Response("<html>cf</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const error = await new LexAPI({ apiKey: "k", fetch: fetchMock }).getInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect((error as InvalidResponseError).code).toBe("INVALID_RESPONSE");
    expect((error as InvalidResponseError).body).toBe("<html>cf</html>");
  });

  it("N3: an empty Retry-After falls back to backoff instead of a 0 ms hammer", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = fetchSequence(new Response("", { status: 503, headers: { "retry-after": "" } }), jsonResponse(200, {}));
      const client = new LexAPI({ apiKey: "k", fetch: fetchMock, retry: { maxRetries: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 } });
      vi.spyOn(Math, "random").mockReturnValue(0.5); // backoff = 500 ms
      const pending = client.getInfo();
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(1); // a 0 ms wait would already have retried
      await vi.advanceTimersByTimeAsync(500);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("N12: an HTTP-date Retry-After drives the wait", async () => {
    vi.useFakeTimers();
    try {
      const date = new Date(Date.now() + 3_000).toUTCString();
      const fetchMock = fetchSequence(
        new Response("", { status: 503, headers: { "retry-after": date } }),
        jsonResponse(200, {}),
      );
      const client = new LexAPI({ apiKey: "k", fetch: fetchMock, retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 30_000 } });
      const pending = client.getInfo();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("503 maps to ServiceUnavailableError", async () => {
    const error = await new LexAPI({ apiKey: "k", fetch: fetchSequence(new Response("", { status: 503 })), retry: { maxRetries: 0 } })
      .getInfo()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
  });
});

describe("N4 — empty webhook secret", () => {
  it("throws a WebhookSignatureError('missing_secret') from every helper", async () => {
    for (const call of [
      () => computeSignature("{}", ""),
      () => verifySignature("{}", "abc", ""),
      () => verifyWebhook("{}", "abc", ""),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WebhookSignatureError);
      expect((error as WebhookSignatureError).reason).toBe("missing_secret");
    }
  });
});

describe("N5 / N6 — NDJSON scanning and cancel()", () => {
  it("N5: parses a multi-megabyte line delivered in small chunks in linear time", async () => {
    const big = JSON.stringify({ celex: "X", htmlContent: "a".repeat(8_000_000) });
    const text = `${META}\n${big}\n${DONE}\n`;
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 256) controller.enqueue(bytes.slice(i, i + 256));
        controller.close();
      },
    });
    const client = new LexAPI({ apiKey: "k", fetch: async () => new Response(body, { status: 200 }) });
    const started = Date.now();
    const stream = await client.export();
    const rows: Array<{ htmlContent?: string }> = [];
    for await (const row of stream) rows.push(row as { htmlContent?: string });
    expect(rows[0]?.htmlContent).toHaveLength(8_000_000);
    expect(Date.now() - started).toBeLessThan(3_000); // quadratic rescans take far longer
  });

  it("N6: cancel() during a pending read settles immediately and closes the socket", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${META}\n`);
    };
    lastSocketClosedEarly = undefined;
    const stream = await real({ timeoutMs: 30_000 }).export();
    const iterating = (async () => {
      for await (const _row of stream) void _row;
    })().catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 30));
    const started = Date.now();
    await stream.cancel();
    expect(Date.now() - started).toBeLessThan(500);
    await vi.waitFor(() => expect(lastSocketClosedEarly).toBe(true));
    await iterating;
  });
});

describe("S6 — batch errors as the server sends them", () => {
  it("types { celex, error }", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true, requested: 1, processed: 1, successful: 0, failed: 1,
        documents: [], errors: [{ celex: "39999X9999", error: "No document found with CELEX number: 39999X9999" }],
      }),
    );
    const result = await new LexAPI({ apiKey: "k", fetch: fetchMock }).getDocumentsBatch({ celexNumbers: ["39999X9999"] });
    expect(result.errors[0]?.celex).toBe("39999X9999");
    expect(result.errors[0]?.error).toContain("No document found");
  });
});

describe("round 2 — R2: abort releases the export connection even while nobody reads", () => {
  it("closes the socket on abort with no iteration in progress, then iteration throws ABORTED", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${META}\n${ROW}\n`);
    };
    lastSocketClosedEarly = undefined;
    const controller = new AbortController();
    const stream = await real({ timeoutMs: 30_000 }).export({}, { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await vi.waitFor(() => expect(lastSocketClosedEarly).toBe(true), { timeout: 1_000 });
    const error = await (async () => {
      for await (const _row of stream) void _row;
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestAbortedError);
  });
});
