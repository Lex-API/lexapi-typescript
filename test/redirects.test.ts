import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LexAPI, NetworkError, TimeoutError } from "../src/index.js";
import { jsonResponse } from "./helpers.js";

const API_KEY = "lex_test_secret_key";

interface Seen {
  method: string;
  url: string;
  apiKey: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** A local server that records every request and answers with `respond`. */
class Stub {
  readonly seen: Seen[] = [];
  respond: (req: Seen) => { status: number; location?: string } = () => ({ status: 200 });
  private server: Server | undefined;
  origin = "";
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const seen: Seen = {
          method: req.method ?? "",
          url: req.url ?? "",
          apiKey: req.headers["x-api-key"] as string | undefined,
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        };
        this.seen.push(seen);
        const { status, location } = this.respond(seen);
        if (location !== undefined) {
          res.writeHead(status, { location });
          res.end();
          return;
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ service: "LexAPI", success: true, results: [] }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    this.origin = `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

const api = new Stub();
const other = new Stub();

beforeAll(async () => {
  await Promise.all([api.start(), other.start()]);
});
afterAll(async () => {
  await Promise.all([api.stop(), other.stop()]);
});
beforeEach(() => {
  api.seen.length = 0;
  other.seen.length = 0;
  other.respond = () => ({ status: 200 });
});

function client(): LexAPI {
  return new LexAPI({ apiKey: API_KEY, baseUrl: `${api.origin}/api/v1`, retry: { maxRetries: 0 } });
}

/** The API stub redirects its first request to `location`, then answers 200. */
function redirectOnce(status: number, location: string): void {
  api.respond = (req) => (req.url.startsWith("/api/v1/") ? { status, location } : { status: 200 });
}

async function refusal(run: () => Promise<unknown>): Promise<NetworkError> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(NetworkError);
  return error as NetworkError;
}

function expectNoSecret(error: NetworkError): void {
  const text = [error.message, String(error.stack), JSON.stringify(error)].join("\n");
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("token=");
}

describe("redirects on the API origin", () => {
  it("follows an absolute redirect and keeps the API key", async () => {
    redirectOnce(302, `${api.origin}/moved/info`);

    const info = await client().getInfo();

    expect(info.service).toBe("LexAPI");
    expect(api.seen.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/v1/info", "GET /moved/info"]);
    expect(api.seen[1]!.apiKey).toBe(API_KEY);
  });

  it("follows a relative redirect", async () => {
    redirectOnce(307, "/moved/info");

    await client().getInfo();

    expect(api.seen.map((r) => r.url)).toEqual(["/api/v1/info", "/moved/info"]);
    expect(api.seen[1]!.apiKey).toBe(API_KEY);
  });

  it.each([307, 308])("repeats a POST with its body on a %i", async (status) => {
    redirectOnce(status, "/moved/search");

    await client().search({ query: "gdpr" });

    const [first, second] = api.seen;
    expect(second!.method).toBe("POST");
    expect(second!.body).toBe(first!.body);
    expect(second!.contentType).toBe("application/json");
    expect(second!.apiKey).toBe(API_KEY);
  });

  it.each([301, 302, 303])("continues a POST as a body-less GET on a %i", async (status) => {
    redirectOnce(status, "/moved/search");

    await client().search({ query: "gdpr" });

    const second = api.seen[1]!;
    expect(second.method).toBe("GET");
    expect(second.body).toBe("");
    expect(second.contentType).toBeUndefined();
    expect(second.apiKey).toBe(API_KEY);
  });

  it("keeps the method of a DELETE on a 302 and turns it into a GET on a 303", async () => {
    redirectOnce(302, "/moved/webhook");
    await client().webhooks.delete("wh_1");
    expect(api.seen[1]!.method).toBe("DELETE");

    api.seen.length = 0;
    redirectOnce(303, "/moved/webhook");
    await client().webhooks.delete("wh_1");
    expect(api.seen[1]!.method).toBe("GET");
  });

  it("stops after five redirects", async () => {
    api.respond = (req) => ({ status: 307, location: req.url });

    const error = await refusal(() => client().getInfo());

    expect(error.message).toMatch(/too many redirects/i);
    expect(api.seen).toHaveLength(6);
    expectNoSecret(error);
  });

  it("returns a redirect without a Location header as an API error", async () => {
    api.respond = () => ({ status: 302 });

    await expect(client().getInfo()).rejects.toMatchObject({ status: 302 });
    expect(api.seen).toHaveLength(1);
  });
});

describe("redirects that leave the API origin", () => {
  it.each([301, 302, 303, 307, 308])("refuses a %i to another port (GET and POST)", async (status) => {
    redirectOnce(status, `${other.origin}/api/v1/info?token=abc`);

    const onGet = await refusal(() => client().getInfo());
    const onPost = await refusal(() => client().search({ query: "gdpr" }));

    expect(other.seen).toEqual([]);
    expect(api.seen).toHaveLength(2);
    for (const error of [onGet, onPost]) {
      expect(error.message).toContain(other.origin);
      expectNoSecret(error);
    }
  });

  it("refuses another host on the same port", async () => {
    redirectOnce(307, `http://localhost:${api.port}/api/v1/info`);

    const error = await refusal(() => client().getInfo());

    expect(error.message).toContain(`http://localhost:${api.port}`);
    expect(api.seen).toHaveLength(1);
    expect(other.seen).toEqual([]);
  });

  it("refuses a protocol-relative Location", async () => {
    redirectOnce(307, `//127.0.0.1:${other.port}/api/v1/info`);

    const error = await refusal(() => client().getInfo());

    expect(error.message).toContain(other.origin);
    expect(other.seen).toEqual([]);
  });

  it.each([
    ["another origin", () => `http://user:hunter2@127.0.0.1:${other.port}/api/v1/info`],
    ["the API origin", () => `http://user:hunter2@127.0.0.1:${api.port}/moved/info`],
  ])("refuses a Location with credentials for %s", async (_name, location) => {
    redirectOnce(307, location());

    const error = await refusal(() => client().getInfo());

    expect(error.message).toMatch(/credentials/);
    expect(api.seen).toHaveLength(1);
    expect(other.seen).toEqual([]);
    expectNoSecret(error);
  });

  it.each(["ftp://127.0.0.1/info", "file:///etc/hosts", "data:text/plain,x"])(
    "refuses the non-http(s) Location %s",
    async (location) => {
      redirectOnce(307, location);

      const error = await refusal(() => client().getInfo());

      expect(error.message).toMatch(/not http\(s\)/);
      expect(api.seen).toHaveLength(1);
      expect(other.seen).toEqual([]);
    },
  );

  it("refuses a second hop that leaves the origin", async () => {
    api.respond = (req) =>
      req.url.startsWith("/api/v1/")
        ? { status: 307, location: "/moved/info" }
        : { status: 307, location: `${other.origin}/info` };

    await refusal(() => client().getInfo());

    expect(api.seen).toHaveLength(2);
    expect(other.seen).toEqual([]);
  });

  it("refuses on the export stream too", async () => {
    redirectOnce(307, `${other.origin}/api/v1/export`);

    await refusal(() => client().export({ documentType: "regulation" }));

    expect(other.seen).toEqual([]);
  });

  it("does not retry a refused redirect", async () => {
    redirectOnce(307, `${other.origin}/api/v1/info`);
    const retrying = new LexAPI({
      apiKey: API_KEY,
      baseUrl: `${api.origin}/api/v1`,
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });

    await refusal(() => retrying.getInfo());

    expect(api.seen).toHaveLength(1);
    expect(other.seen).toEqual([]);
  });
});

describe("redirect chains and the timeout", () => {
  it("applies one timeout to the whole chain", async () => {
    const hopDelayMs = 120;
    const slowFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((resolve, reject) => {
          const hop = Number(new URL(String(url)).searchParams.get("hop") ?? "0");
          const timer = setTimeout(
            () => resolve(new Response(null, { status: 307, headers: { location: `/v1/info?hop=${hop + 1}` } })),
            hopDelayMs,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const sdk = new LexAPI({
      apiKey: API_KEY,
      baseUrl: "https://api.example/v1",
      fetch: slowFetch,
      timeoutMs: 200,
      retry: { maxRetries: 0 },
    });

    const started = Date.now();
    const error = await sdk.getInfo().then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(TimeoutError);
    expect(slowFetch).toHaveBeenCalledTimes(2);
    // Well short of the full chain (five hops), which would take 5 × hopDelayMs.
    expect(elapsed).toBeLessThan(4 * hopDelayMs);
  });
});

describe("redirect response bodies", () => {
  /** A fetch stub whose first answer is a redirect with a body that records `cancel()`. */
  function trackedRedirect(location: string) {
    const cancelled = vi.fn();
    let call = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => {
      if (call++ > 0) return jsonResponse(200, { service: "LexAPI" });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("moved"));
        },
        cancel: cancelled,
      });
      return new Response(body, { status: 307, headers: { location } });
    });
    return { fetchMock, cancelled };
  }

  it("cancels the body of a followed redirect", async () => {
    const { fetchMock, cancelled } = trackedRedirect("/v1/moved");
    await new LexAPI({ apiKey: API_KEY, baseUrl: "https://api.example/v1", fetch: fetchMock }).getInfo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("cancels the body of a refused redirect", async () => {
    const { fetchMock, cancelled } = trackedRedirect("https://other.example/v1/info");
    const sdk = new LexAPI({ apiKey: API_KEY, baseUrl: "https://api.example/v1", fetch: fetchMock });

    await refusal(() => sdk.getInfo());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe("redirects between http and https", () => {
  /** A fetch stub: the first call is redirected to `location`, later calls answer 200. */
  function redirectingFetch(location: string) {
    let call = 0;
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      call++ === 0
        ? new Response(null, { status: 307, headers: { location } })
        : jsonResponse(200, { service: "LexAPI" }),
    );
  }

  it("asks fetch not to follow redirects itself", async () => {
    const fetchMock = redirectingFetch("https://api.example/v1/moved");
    await new LexAPI({ apiKey: API_KEY, baseUrl: "https://api.example/v1", fetch: fetchMock }).getInfo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe("manual");
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://api.example/v1/moved");
  });

  it("refuses an https to http downgrade on the same host", async () => {
    const fetchMock = redirectingFetch("http://api.example/v1/info");
    const sdk = new LexAPI({ apiKey: API_KEY, baseUrl: "https://api.example/v1", fetch: fetchMock });

    const error = await refusal(() => sdk.getInfo());

    expect(error.message).toContain("http://api.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows an http to https upgrade on the same host and default ports", async () => {
    const fetchMock = redirectingFetch("https://api.example/v1/info");
    const sdk = new LexAPI({ apiKey: API_KEY, baseUrl: "http://api.example/v1", fetch: fetchMock });

    await sdk.getInfo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.example/v1/info");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe(API_KEY);
  });

  it.each([
    ["a non-default target port", "http://api.example/v1", "https://api.example:8443/v1/info"],
    ["a non-default source port", "http://api.example:8080/v1", "https://api.example/v1/info"],
    ["another host", "http://api.example/v1", "https://www.api.example/v1/info"],
  ])("refuses an upgrade with %s", async (_name, baseUrl, location) => {
    const fetchMock = redirectingFetch(location);
    const sdk = new LexAPI({ apiKey: API_KEY, baseUrl, fetch: fetchMock });

    await refusal(() => sdk.getInfo());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
