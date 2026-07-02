import { describe, expect, it, vi } from "vitest";

import { LexAPI, LexAPIError } from "../src/index.js";

const INFO_BODY = {
  service: "LexAPI",
  version: "2.0.0",
  subscription: { tier: "FREE", pricingMode: "credits" },
  usage: { current: 0, limit: 100, remaining: 100, unit: "credits" },
  credits: { operation_weight: 0, remaining: 100 },
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("LexAPI", () => {
  it("sends x-api-key auth and user-agent on GET /info", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, INFO_BODY));
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock });

    const info = await client.getInfo();

    expect(info["service"]).toBe("LexAPI");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://lex-api.com/api/v1/info");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("lex_test_key");
    expect(headers["user-agent"]).toMatch(/^lexapi-typescript\//);
  });

  it("parses the typed error envelope", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(404, {
        success: false,
        error: { code: "NOT_FOUND", message: "Document missing" },
      }),
    );
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock });

    const error = await client.getInfo().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexAPIError);
    expect((error as LexAPIError).code).toBe("NOT_FOUND");
    expect((error as LexAPIError).status).toBe(404);
  });

  it("tolerates the legacy bare {error} envelope and reads Retry-After", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(429, { error: "Rate limit hit" }, { "retry-after": "7" }),
    );
    const client = new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock });

    const error = await client.getInfo().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexAPIError);
    expect((error as LexAPIError).code).toBe("RATE_LIMITED");
    expect((error as LexAPIError).message).toContain("Rate limit hit");
    expect((error as LexAPIError).retryAfter).toBe(7);
  });

  it("requires an api key", () => {
    vi.stubEnv("LEXAPI_API_KEY", "");
    expect(() => new LexAPI({})).toThrow(/apiKey/);
    vi.unstubAllEnvs();
  });
});
