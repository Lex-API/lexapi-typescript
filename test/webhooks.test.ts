import { describe, expect, it, vi } from "vitest";

import { LexAPI, NotFoundError } from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

function client(fetchMock: typeof fetch) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
}

const WEBHOOK = {
  id: "cm5abc123",
  name: "New CJEU judgments",
  url: "https://example.com/webhooks/lexapi",
  status: "ACTIVE",
  searchCriteria: { documentType: "judgment", author: ["court-of-justice"] },
  lastChecked: null,
  lastTriggered: null,
  consecutiveFailures: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
};

describe("webhooks CRUD", () => {
  it("lists webhooks", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { success: true, count: 1, webhooks: [{ ...WEBHOOK, deliveryCount: 12 }] }),
    );

    const result = await client(fetchMock).webhooks.list();

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/webhooks");
    expect(init.method).toBe("GET");
    expect(result.webhooks[0]?.deliveryCount).toBe(12);
    expect(result.webhooks[0]).not.toHaveProperty("secret");
  });

  it("creates a webhook and returns the one-time secret", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(201, {
        success: true,
        message: "Webhook created",
        webhook: { ...WEBHOOK, secret: "a".repeat(64) },
      }),
    );

    const result = await client(fetchMock).webhooks.create({
      name: "New CJEU judgments",
      url: "https://example.com/webhooks/lexapi",
      searchCriteria: { documentType: "judgment", author: ["court-of-justice"] },
    });

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/webhooks");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).searchCriteria.documentType).toBe("judgment");
    expect(result.webhook.secret).toHaveLength(64);
  });

  it("gets a webhook with recent deliveries", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        webhook: {
          ...WEBHOOK,
          maxRetries: 3,
          updatedAt: "2026-07-01T00:00:00.000Z",
          recentDeliveries: [
            { id: "d1", status: "SUCCESS", responseStatus: 200, responseBody: "ok", attemptCount: 1, createdAt: "2026-07-01T01:00:00.000Z" },
          ],
        },
      }),
    );

    const result = await client(fetchMock).webhooks.get("cm5abc123");

    expect(lastCall(fetchMock)[0]).toBe("https://lex-api.com/api/v1/webhooks/cm5abc123");
    expect(result.webhook.recentDeliveries?.[0]?.status).toBe("SUCCESS");
  });

  it("updates a webhook with PUT (resume via status ACTIVE)", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        webhook: { id: "cm5abc123", status: "ACTIVE", updatedAt: "2026-07-02T00:00:00.000Z" },
      }),
    );

    const result = await client(fetchMock).webhooks.update("cm5abc123", { status: "ACTIVE" });

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/webhooks/cm5abc123");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ status: "ACTIVE" });
    expect(result.webhook.status).toBe("ACTIVE");
  });

  it("deletes a webhook (204 resolves to void) and maps re-delete 404", async () => {
    const fetchMock = fetchSequence(
      new Response(null, { status: 204 }),
      jsonResponse(404, { success: false, error: { code: "NOT_FOUND", message: "Webhook not found" } }),
    );
    const c = client(fetchMock);

    await expect(c.webhooks.delete("cm5abc123")).resolves.toBeUndefined();
    const [, init] = lastCall(fetchMock);
    expect(init.method).toBe("DELETE");

    await expect(c.webhooks.delete("cm5abc123")).rejects.toThrow(NotFoundError);
  });

  it("sends a test delivery and reports the upstream outcome", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: false,
        message: "Test delivery failed",
        delivery: { status: "FAILED", responseStatus: 500, responseBody: "oops", errorMessage: "upstream returned 500" },
      }),
    );

    const result = await client(fetchMock).webhooks.test("cm5abc123");

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/webhooks/cm5abc123/test");
    expect(init.method).toBe("POST");
    expect(result.success).toBe(false);
    expect(result.delivery.errorMessage).toContain("500");
  });

  it("lists deliveries with limit/offset", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        success: true,
        total: 120,
        limit: 10,
        offset: 20,
        deliveries: [
          { id: "d9", status: "RETRYING", responseStatus: 503, attemptCount: 2, nextRetryAt: "2026-07-02T12:00:00.000Z", deliveredAt: null, createdAt: "2026-07-02T11:00:00.000Z" },
        ],
      }),
    );

    const result = await client(fetchMock).webhooks.deliveries("cm5abc123", { limit: 10, offset: 20 });

    const parsed = new URL(lastCall(fetchMock)[0]);
    expect(parsed.pathname).toBe("/api/v1/webhooks/cm5abc123/deliveries");
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(parsed.searchParams.get("offset")).toBe("20");
    expect(result.deliveries[0]?.status).toBe("RETRYING");
    expect(result.total).toBe(120);
  });

  it("encodes the webhook id path segment", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, { success: true, webhook: WEBHOOK }));

    await client(fetchMock).webhooks.get("weird/id");

    expect(lastCall(fetchMock)[0]).toBe("https://lex-api.com/api/v1/webhooks/weird%2Fid");
  });
});
