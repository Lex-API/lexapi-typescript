import { afterEach, describe, expect, it, vi } from "vitest";

import { LexAPI } from "../src/index.js";
import { jsonResponse } from "./helpers.js";

const INFO_BODY = { service: "LexAPI", version: "2.0.0" };
const BASE_URL = "http://127.0.0.1:9/api/v1";
const OPTIONS = { apiKey: "lex_test_key", baseUrl: BASE_URL, retry: { maxRetries: 0 } };

/** A `fetch` that, like Cloudflare Workers and browsers, refuses any receiver but the global object. */
function strictGlobalFetch() {
  const calls: Array<[unknown, unknown]> = [];
  const strict = function (this: unknown, input: unknown, init: unknown): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    calls.push([input, init]);
    return Promise.resolve(jsonResponse(200, INFO_BODY));
  };
  return { strict: strict as unknown as typeof fetch, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("default fetch", () => {
  it("is called on the global object", async () => {
    const { strict, calls } = strictGlobalFetch();
    vi.stubGlobal("fetch", strict);
    const client = new LexAPI(OPTIONS);

    const info = await client.getInfo();

    expect(info.service).toBe("LexAPI");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(`${BASE_URL}/info`);
  });

  it("is looked up at call time", async () => {
    const client = new LexAPI(OPTIONS);
    const { strict, calls } = strictGlobalFetch();
    vi.stubGlobal("fetch", strict);

    await client.getInfo();

    expect(calls).toHaveLength(1);
  });

  it("fails at construction when the runtime has no fetch", () => {
    vi.stubGlobal("fetch", undefined);

    expect(() => new LexAPI(OPTIONS)).toThrow(/fetch/);
    expect(() => new LexAPI({ ...OPTIONS, fetch: vi.fn() })).not.toThrow();
  });
});

describe("custom fetch", () => {
  it("is called directly, with the same arguments and receiver", async () => {
    const seen: Array<{ receiver: unknown; args: unknown[] }> = [];
    const custom = function (this: unknown, ...args: unknown[]): Promise<Response> {
      seen.push({ receiver: this, args });
      return Promise.resolve(jsonResponse(200, INFO_BODY));
    } as unknown as typeof fetch;
    const { strict, calls } = strictGlobalFetch();
    vi.stubGlobal("fetch", strict);
    const client = new LexAPI({ ...OPTIONS, fetch: custom });

    await client.getInfo();

    expect(calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    const { receiver, args } = seen[0]!;
    expect(args).toHaveLength(2);
    expect(args[0]).toBe(`${BASE_URL}/info`);
    const init = args[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("lex_test_key");
    expect("body" in init).toBe(false);
    // Called as a method of the client's internal options, as before.
    expect((receiver as { fetchFn?: unknown }).fetchFn).toBe(custom);
  });
});
