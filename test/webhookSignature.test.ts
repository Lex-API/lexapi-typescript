import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  WebhookSignatureError,
  computeSignature,
  verifyWebhook,
  verifySignature,
  type WebhookPayload,
} from "../src/index.js";

const SECRET = "7f9a0c5e1b2d3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2";
const NOW = Date.parse("2026-10-05T11:35:50.493Z");

const PAYLOAD = {
  event: "watchlist.changes",
  timestamp: "2026-10-05T11:35:50.493Z",
  webhook: { id: "a1b2", name: "Chemicals compliance watch" },
  delivery: { id: "d1e2", attempt: 1 },
  data: {
    count: 1,
    changes: [
      {
        watchedCelex: "32008R1272",
        relation: "consolidated_version",
        document: { celex: "02008R1272-20270101", consolidationDate: "2027-01-01", availableLanguages: ["BG", "CS"] },
      },
    ],
  },
};
// The server signs JSON.stringify(payload) and sends exactly those bytes.
const RAW = JSON.stringify(PAYLOAD);
const SIGNATURE = createHmac("sha256", SECRET).update(RAW).digest("hex");

describe("webhook signature verification", () => {
  it("computes the same hex HMAC-SHA256 as the server (node:crypto reference)", async () => {
    expect(await computeSignature(RAW, SECRET)).toBe(SIGNATURE);
  });

  it("verifies string, Uint8Array and ArrayBuffer bodies", async () => {
    const bytes = new TextEncoder().encode(RAW);
    expect(await verifySignature(RAW, SIGNATURE, SECRET)).toBe(true);
    expect(await verifySignature(bytes, SIGNATURE, SECRET)).toBe(true);
    expect(await verifySignature(bytes.buffer.slice(0), SIGNATURE, SECRET)).toBe(true);
    expect(await verifySignature(Buffer.from(RAW), SIGNATURE.toUpperCase(), SECRET)).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets and missing signatures", async () => {
    expect(await verifySignature(RAW.replace("32008R1272", "32006R1907"), SIGNATURE, SECRET)).toBe(false);
    expect(await verifySignature(RAW, SIGNATURE, "other-secret")).toBe(false);
    expect(await verifySignature(RAW, undefined, SECRET)).toBe(false);
    // a re-serialised (pretty-printed) body no longer matches the signed bytes
    expect(await verifySignature(JSON.stringify(PAYLOAD, null, 2), SIGNATURE, SECRET)).toBe(false);
  });

  it("verifyWebhook returns a typed, discriminated payload", async () => {
    const event: WebhookPayload = await verifyWebhook(RAW, SIGNATURE, SECRET, { now: NOW + 1_000 });
    expect(event.event).toBe("watchlist.changes");
    if (event.event === "watchlist.changes") {
      expect(event.data.changes[0]?.relation).toBe("consolidated_version");
      expect(event.delivery?.id).toBe("d1e2");
    }
  });

  it("verifyWebhook enforces the replay window", async () => {
    const error = await verifyWebhook(RAW, SIGNATURE, SECRET, { now: NOW + 10 * 60_000 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect((error as WebhookSignatureError).reason).toBe("stale_timestamp");

    // toleranceMs: 0 disables the window
    await expect(verifyWebhook(RAW, SIGNATURE, SECRET, { toleranceMs: 0 })).resolves.toBeTruthy();
  });

  it("verifyWebhook names the failure", async () => {
    const reasons = await Promise.all([
      verifyWebhook(RAW, null, SECRET).catch((e: WebhookSignatureError) => e.reason),
      verifyWebhook(RAW, "deadbeef", SECRET).catch((e: WebhookSignatureError) => e.reason),
      verifyWebhook("not json", createHmac("sha256", SECRET).update("not json").digest("hex"), SECRET).catch(
        (e: WebhookSignatureError) => e.reason,
      ),
    ]);
    expect(reasons).toEqual(["missing_signature", "invalid_signature", "malformed_body"]);
  });
});
