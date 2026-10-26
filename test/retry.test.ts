import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpClient } from "../src/http.js";
import {
  LexAPI,
  NetworkError,
  RateLimitedError,
  TimeoutError,
  UpstreamError,
} from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

const OK = () => jsonResponse(200, { success: true, service: "LexAPI" });
/** An app-generated error: the API's rate limiter stamps `RateLimit-*` on every app response (§1.2). */
const ERR = (status: number, code = "UPSTREAM_ERROR", headers?: Record<string, string>) =>
  jsonResponse(status, { success: false, error: { code, message: "transient" } }, { "ratelimit-limit": "60", ...headers });

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

  it("retries a connect-phase network error (nothing reached the API) — any method", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    for (const method of ["GET", "POST"] as const) {
      const fetchMock = fetchSequence(refused, OK());
      await httpClient(fetchMock).requestJson({ method, path: "/search", ...(method === "POST" ? { body: {} } : {}) });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("a closed connection (fetch can't tell before- from mid-response) is not retried on a billed call, only on a free one (§1.2)", async () => {
    const closed = () =>
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      });
    for (const call of [
      { method: "POST" as const, path: "/webhooks", body: {} },
      { method: "GET" as const, path: "/citations/stats" },
    ]) {
      const billed = fetchSequence(closed(), OK());
      await expect(httpClient(billed).requestJson(call)).rejects.toThrow(NetworkError);
      expect(billed).toHaveBeenCalledTimes(1);
    }
    const free = fetchSequence(closed(), OK());
    await httpClient(free).requestJson({ method: "GET", path: "/info", free: true });
    expect(free).toHaveBeenCalledTimes(2);
  });

  it("does not retry a billed call whose connection drops after the response head (§1.2)", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"a":'));
            controller.error(Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } }));
          },
        }),
        { status: 200 },
      );
    const fetchMock = vi.fn(async () => broken());
    const error = await httpClient(fetchMock as unknown as typeof fetch)
      .requestJson({ method: "GET", path: "/citations/stats" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).code).toBe("CONNECTION_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // …but a free call is retried (it cannot charge).
    const free = vi.fn().mockImplementationOnce(async () => broken()).mockImplementation(async () => OK());
    await httpClient(free as unknown as typeof fetch).requestJson({ method: "GET", path: "/info", free: true });
    expect(free).toHaveBeenCalledTimes(2);
  });

  it("wraps exhausted connect-phase errors in NetworkError", async () => {
    const cause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
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

const OPT_IN = { ...FAST_RETRY, retryReadOnlyPosts: true };

describe("read-only POST retries (opt-in)", () => {
  it("does not retry an idempotent POST on 5xx by default", async () => {
    const fetchMock = fetchSequence(ERR(503), OK());
    await expect(
      httpClient(fetchMock).requestJson({ method: "POST", path: "/search", body: {}, idempotent: true }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries an idempotent POST on 502/503/504 when opted in (5xx is refunded in full)", async () => {
    for (const status of [502, 503, 504]) {
      const fetchMock = fetchSequence(ERR(status), OK());
      await expect(
        httpClient(fetchMock, OPT_IN).requestJson({ method: "POST", path: "/search", body: {}, idempotent: true }),
      ).resolves.toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("never retries a POST on Cloudflare 520/524 (may be billed), even when opted in", async () => {
    for (const status of [520, 524]) {
      const fetchMock = fetchSequence(new Response("cf", { status }), OK());
      await expect(
        httpClient(fetchMock, OPT_IN).requestJson({ method: "POST", path: "/search", body: {}, idempotent: true }),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("retries Cloudflare 521/522/523 (never reached the app) for every method, opt-in or not", async () => {
    for (const status of [521, 522, 523]) {
      const fetchMock = fetchSequence(new Response("cf", { status }), OK());
      await httpClient(fetchMock).requestJson({ method: "POST", path: "/webhooks", body: {} });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("does not retry an idempotent POST on 500 INTERNAL", async () => {
    const fetchMock = fetchSequence(ERR(500, "INTERNAL"), OK());
    await expect(
      httpClient(fetchMock, OPT_IN).requestJson({ method: "POST", path: "/search", body: {}, idempotent: true }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries an idempotent POST on network errors (it may have been billed)", async () => {
    const fetchMock = fetchSequence(new TypeError("socket hang up"), OK());
    await expect(
      httpClient(fetchMock, OPT_IN).requestJson({ method: "POST", path: "/search", body: {}, idempotent: true }),
    ).rejects.toThrow(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks every read-only client method idempotent, and webhook writes not", async () => {
    const client = (fetchMock: typeof fetch) =>
      new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: OPT_IN });

    const reads: Array<(c: LexAPI) => Promise<unknown>> = [
      (c) => c.search({ query: "x" }),
      (c) => c.getDocument({ celexNumber: "32016R0679" }),
      (c) => c.getDocumentsBatch({ celexNumbers: ["32016R0679"] }),
      (c) => c.getDocumentByUrl({ url: "https://eur-lex.europa.eu/?uri=CELEX:32016R0679" }),
      (c) => c.getDocumentMetadata({ celexNumber: "32016R0679" }),
      (c) => c.resolve("32016R0679"),
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
      (c) => c.extractCitations("32016R0679"), // persists edges — mutating per §1.2
    ];
    for (const call of writes) {
      const fetchMock = fetchSequence(ERR(502), OK());
      await expect(call(client(fetchMock))).rejects.toThrow(UpstreamError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe("retry wait sources and non-retryable 429s", () => {
  it("ignores RateLimit-Reset on a retried 5xx GET (it is sent on every response)", async () => {
    vi.useFakeTimers();
    const fetchMock = fetchSequence(ERR(502, "UPSTREAM_ERROR", { "ratelimit-reset": "55" }), OK());
    const pending = httpClient(fetchMock, { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 30_000, retryReadOnlyPosts: false })
      .requestJson({ method: "GET", path: "/info" });
    // computed backoff for attempt 0 is < baseDelayMs (10 ms), not 55 s
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not put RateLimit-Reset / JSON retryAfter on a 5xx error's retryAfter", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(502, { error: "Upstream service error", retryAfter: 42 }, { "ratelimit-reset": "55" }),
    );
    const error = await httpClient(fetchMock, { ...FAST_RETRY, maxRetries: 0 })
      .requestJson({ method: "GET", path: "/info" })
      .catch((e: unknown) => e as UpstreamError);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).retryAfter).toBeUndefined();
  });

  it("still honors Retry-After on a 503 GET", async () => {
    vi.useFakeTimers();
    const fetchMock = fetchSequence(ERR(503, "UPSTREAM_ERROR", { "retry-after": "2" }), OK());
    const pending = httpClient(fetchMock, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 30_000, retryReadOnlyPosts: false })
      .requestJson({ method: "GET", path: "/info" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a legacy daily-quota 429 (cannot succeed before resetsAt)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(
        429,
        {
          error: "Daily quota exceeded",
          message: "You've reached your daily limit of 1000 API calls. Resets at midnight UTC.",
          usage: { current: 1000, limit: 1000, resetsAt: "2026-10-27T00:00:00.000Z" },
        },
        { "ratelimit-reset": "30" },
      ),
      OK(),
    );
    const error = await httpClient(fetchMock)
      .requestJson({ method: "GET", path: "/info" })
      .catch((e: unknown) => e as RateLimitedError);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).quotaExhausted).toBe(true);
    expect((error as RateLimitedError).resetsAt).toBe("2026-10-27T00:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a legacy monthly semantic-quota 429", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(429, {
        error: "Monthly semantic search quota exceeded",
        message: "You've reached your monthly limit of 100 semantic searches.",
        usage: { current: 100, limit: 100, resetsAt: "2026-11-01T00:00:00.000Z" },
      }),
      OK(),
    );
    await expect(
      httpClient(fetchMock).requestJson({ method: "POST", path: "/search/semantic", body: {} }),
    ).rejects.toThrow(RateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a per-minute 429 (Retry-After) and reports quotaExhausted: false", async () => {
    const limited = jsonResponse(
      429,
      { error: "Rate limit exceeded", message: "…", retryAfter: 0 },
      { "retry-after": "0" },
    );
    const fetchMock = fetchSequence(limited, OK());
    await expect(httpClient(fetchMock).requestJson({ method: "GET", path: "/info" })).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const error = await httpClient(fetchSequence(limited), { ...FAST_RETRY, maxRetries: 0 })
      .requestJson({ method: "GET", path: "/info" })
      .catch((e: unknown) => e as RateLimitedError);
    expect((error as RateLimitedError).quotaExhausted).toBe(false);
  });

  it("types Cloudflare 520–524; a billed GET retries only 521–523, a free GET all of them", async () => {
    for (const [status, ctor] of [
      [520, UpstreamError],
      [521, UpstreamError],
      [522, UpstreamError],
      [523, UpstreamError],
      [524, TimeoutError],
    ] as const) {
      const billed = fetchSequence(new Response("<html>cloudflare</html>", { status }), OK());
      const neverReached = status >= 521 && status <= 523;
      const outcome = await httpClient(billed).requestJson({ method: "GET", path: "/citations/stats" }).then(
        () => "ok",
        () => "error",
      );
      expect(outcome).toBe(neverReached ? "ok" : "error");
      expect(billed).toHaveBeenCalledTimes(neverReached ? 2 : 1);

      const free = fetchSequence(new Response("<html>cloudflare</html>", { status }), OK());
      await httpClient(free).requestJson({ method: "GET", path: "/info", free: true });
      expect(free).toHaveBeenCalledTimes(2);

      const error = await httpClient(fetchSequence(new Response("cf", { status })), { ...FAST_RETRY, maxRetries: 0 })
        .requestJson({ method: "GET", path: "/info" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ctor);
    }
  });
});
