import { afterEach, describe, expect, it, vi } from "vitest";

import { LexAPI, LexAPIError, TimeoutError, VERSION } from "../src/index.js";
import { jsonResponse } from "./helpers.js";

const INFO_BODY = {
  service: "LexAPI",
  version: "2.0.0",
  subscription: { tier: "FREE", pricingMode: "credits" },
  usage: { current: 0, limit: 100, remaining: 100, unit: "credits" },
  credits: { operation_weight: 0, remaining: 100 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("LexAPI request construction", () => {
  it("sends x-api-key auth and user-agent on GET /info", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, INFO_BODY));
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock });

    const info = await client.getInfo();

    expect(info.service).toBe("LexAPI");
    expect(info.subscription?.tier).toBe("FREE");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://lex-api.com/api/v1/info");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("lex_test_key");
    expect(headers["user-agent"]).toBe(`lexapi-typescript/${VERSION}`);
  });

  it("appends the userAgentSuffix", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, INFO_BODY));
    const client = new LexAPI({
      apiKey: "lex_test_key",
      fetch: fetchMock,
      userAgentSuffix: "my-app/1.2.3",
    });

    await client.getInfo();

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(`lexapi-typescript/${VERSION} my-app/1.2.3`);
  });

  it("omits the user-agent header on browser-like runtimes (forbidden header)", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const fetchMock = vi.fn(async () => jsonResponse(200, INFO_BODY));
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock });

    await client.getInfo();

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBeUndefined();
    expect(headers["x-api-key"]).toBe("lex_test_key");
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, INFO_BODY));
    const client = new LexAPI({
      apiKey: "lex_test_key",
      baseUrl: "http://localhost:3000/api/v1/",
      fetch: fetchMock,
    });

    await client.getInfo();

    const [url] = fetchMock.mock.calls[0]! as unknown as [string];
    expect(url).toBe("http://localhost:3000/api/v1/info");
  });

  it("falls back to the LEXAPI_API_KEY environment variable", async () => {
    vi.stubEnv("LEXAPI_API_KEY", "lex_env_key");
    const fetchMock = vi.fn(async () => jsonResponse(200, INFO_BODY));
    const client = new LexAPI({ fetch: fetchMock });

    await client.getInfo();

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("lex_env_key");
  });

  it("requires an api key", () => {
    vi.stubEnv("LEXAPI_API_KEY", "");
    expect(() => new LexAPI({})).toThrow(/apiKey/);
  });

  it("throws a TimeoutError when the request exceeds timeoutMs (and does not retry)", async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        }),
    );
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, timeoutMs: 10 });

    const error = await client.getInfo().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).code).toBe("TIMEOUT");
    expect((error as TimeoutError).status).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honors a per-call timeout override", async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        }),
    );
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, timeoutMs: 60_000 });

    const error = await client.getInfo({ timeoutMs: 10 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as LexAPIError).message).toContain("10ms");
  });
});
