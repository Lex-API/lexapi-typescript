import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpClient } from "../src/http.js";
import {
  LexAPI,
  NetworkError,
  RateLimitedError,
  UpstreamError,
} from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

const OK = () => jsonResponse(200, { success: true, service: "LexAPI" });
const ERR = (status: number, code = "UPSTREAM_ERROR", headers?: Record<string, string>) =>
  jsonResponse(status, { success: false, error: { code, message: "transient" } }, headers);

function httpClient(fetchFn: typeof fetch, retry = FAST_RETRY) {
  return new HttpClient({
    apiKey: "lex_test_key",
    baseUrl: "https://lex-api.com/api/v1",
    timeoutMs: 60_000,
    fetchFn,
    retry,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("retry policy", () => {
  it("retries GET on 429 and succeeds", async () => {
    const fetchMock = fetchSequence(ERR(429, "RATE_LIMITED"), OK());
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });

    const info = await client.getInfo();

    expect(info.service).toBe("LexAPI");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504])("retries GET on %i", async (status) => {
    const fetchMock = fetchSequence(ERR(status), OK());
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });

    await client.getInfo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry GET on 400 or 500", async () => {
    for (const status of [400, 500]) {
      const fetchMock = fetchSequence(ERR(status, "INTERNAL"), OK());
      const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });
      await expect(client.getInfo()).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after maxRetries and throws the typed error", async () => {
    const fetchMock = fetchSequence(ERR(502));
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });

    const error = await client.getInfo().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpstreamError);
    expect(fetchMock).toHaveBeenCalledTimes(1 + FAST_RETRY.maxRetries);
  });

  it("retries GET on transport-level network errors", async () => {
    const fetchMock = fetchSequence(new TypeError("fetch failed"), OK());
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });

    await client.getInfo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wraps exhausted network errors in NetworkError", async () => {
    const cause = new TypeError("fetch failed");
    const fetchMock = fetchSequence(cause);
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });

    const error = await client.getInfo().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBe(cause);
    expect(fetchMock).toHaveBeenCalledTimes(1 + FAST_RETRY.maxRetries);
  });

  it("retries POST on 429", async () => {
    const fetchMock = fetchSequence(ERR(429, "RATE_LIMITED"), OK());

    const result = await httpClient(fetchMock).requestJson<{ success: boolean }>({
      method: "POST",
      path: "/search",
      body: { query: "GDPR" },
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries POST on 502/503/504 (non-idempotent)", async () => {
    for (const status of [502, 503, 504]) {
      const fetchMock = fetchSequence(ERR(status), OK());
      await expect(
        httpClient(fetchMock).requestJson({ method: "POST", path: "/search", body: {} }),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("never retries POST on network errors (may have been applied)", async () => {
    const fetchMock = fetchSequence(new TypeError("socket hang up"), OK());

    await expect(
      httpClient(fetchMock).requestJson({ method: "POST", path: "/search", body: {} }),
    ).rejects.toThrow(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors the Retry-After HEADER for the wait duration", async () => {
    vi.useFakeTimers();
    const fetchMock = fetchSequence(
      ERR(429, "RATE_LIMITED", { "retry-after": "7" }),
      OK(),
    );
    const client = new LexAPI({
      apiKey: "lex_test_key",
      fetch: fetchMock,
      retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30_000 },
    });

    const pending = client.getInfo();
    // Attach a no-op catch so an assertion failure doesn't become an unhandled rejection.
    pending.catch(() => undefined);

    // Flush microtasks first so the retry's sleep timer is REGISTERED at
    // fake-time 0 — otherwise (observed on CI) registration can land after
    // the first advance and the 7 s target drifts past the second advance.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6_900);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still waiting on the server-directed 7s
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toMatchObject({ service: "LexAPI" });
  });

  it("prefers the Retry-After header over a buggy JSON retryAfter body field", async () => {
    vi.useFakeTimers();
    const epochRetryAfter = Math.round(Date.now() / 1000) + 3600; // buggy epoch-seconds body value
    const fetchMock = fetchSequence(
      jsonResponse(
        429,
        { success: false, error: { code: "RATE_LIMITED", message: "slow down" }, retryAfter: epochRetryAfter },
        { "retry-after": "2" },
      ),
      OK(),
    );
    const client = new LexAPI({
      apiKey: "lex_test_key",
      fetch: fetchMock,
      retry: { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 30_000 },
    });

    const pending = client.getInfo();
    pending.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchMock).toHaveBeenCalledTimes(2); // waited 2s (header), not 3600s (body)
    await expect(pending).resolves.toMatchObject({ service: "LexAPI" });
  });

  it("caps server-directed waits at maxDelayMs", async () => {
    vi.useFakeTimers();
    const fetchMock = fetchSequence(ERR(429, "RATE_LIMITED", { "retry-after": "600" }), OK());
    const client = new LexAPI({
      apiKey: "lex_test_key",
      fetch: fetchMock,
      retry: { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 5_000 },
    });

    const pending = client.getInfo();
    pending.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(5_100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toMatchObject({ service: "LexAPI" });
  });

  it("disables retries when maxRetries is 0", async () => {
    const fetchMock = fetchSequence(ERR(429, "RATE_LIMITED"), OK());
    const client = new LexAPI({
      apiKey: "lex_test_key",
      fetch: fetchMock,
      retry: { maxRetries: 0 },
    });

    await expect(client.getInfo()).rejects.toThrow(RateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("read-only POST retries", () => {
  it("retries an idempotent POST on 502/503/504 (5xx is refunded in full)", async () => {
    for (const status of [502, 503, 504]) {
      const fetchMock = fetchSequence(ERR(status), OK());
      await expect(
        httpClient(fetchMock).requestJson({ method: "POST", path: "/search", body: {}, idempotent: true }),
      ).resolves.toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("does not retry an idempotent POST on 500 INTERNAL", async () => {
    const fetchMock = fetchSequence(ERR(500, "INTERNAL"), OK());
    await expect(
      httpClient(fetchMock).requestJson({ method: "POST", path: "/search", body: {}, idempotent: true }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries an idempotent POST on network errors (it may have been billed)", async () => {
    const fetchMock = fetchSequence(new TypeError("socket hang up"), OK());
    await expect(
      httpClient(fetchMock).requestJson({ method: "POST", path: "/search", body: {}, idempotent: true }),
    ).rejects.toThrow(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors retryReadOnlyPosts: false", async () => {
    const fetchMock = fetchSequence(ERR(503), OK());
    await expect(
      httpClient(fetchMock, { ...FAST_RETRY, retryReadOnlyPosts: false }).requestJson({
        method: "POST",
        path: "/search",
        body: {},
        idempotent: true,
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks every read-only client method idempotent, and webhook writes not", async () => {
    const client = (fetchMock: typeof fetch) =>
      new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });

    const reads: Array<(c: LexAPI) => Promise<unknown>> = [
      (c) => c.search({ query: "x" }),
      (c) => c.getDocument({ celexNumber: "32016R0679" }),
      (c) => c.getDocumentsBatch({ celexNumbers: ["32016R0679"] }),
      (c) => c.getDocumentByUrl({ url: "https://eur-lex.europa.eu/?uri=CELEX:32016R0679" }),
      (c) => c.getDocumentMetadata({ celexNumber: "32016R0679" }),
      (c) => c.resolve("32016R0679"),
      (c) => c.extractCitations("32016R0679"),
      (c) => c.semanticSearch({ query: "x" }),
      (c) => c.semanticLegislationSearch({ query: "x", asOf: "2020-01-01" }),
    ];
    for (const call of reads) {
      const fetchMock = fetchSequence(ERR(504, "TIMEOUT"), OK());
      await call(client(fetchMock));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }

    const writes: Array<(c: LexAPI) => Promise<unknown>> = [
      (c) => c.webhooks.create({ name: "n", url: "https://example.com", watchCelex: ["32008R1272"] }),
      (c) => c.webhooks.update("id", { status: "ACTIVE" }),
      (c) => c.webhooks.delete("id"),
      (c) => c.webhooks.test("id"),
    ];
    for (const call of writes) {
      const fetchMock = fetchSequence(ERR(502), OK());
      await expect(call(client(fetchMock))).rejects.toThrow(UpstreamError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});
