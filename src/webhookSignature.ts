import type { WebhookPayload } from "./types.js";

/**
 * Verifying incoming LexAPI webhook deliveries.
 *
 * LexAPI signs every delivery with `X-Webhook-Signature`: the hex-encoded
 * HMAC-SHA256 of the raw request body, keyed with the webhook's `secret`.
 * Verify against the raw body bytes exactly as received — never a
 * re-serialised parse (key order / whitespace changes break the digest).
 *
 * The signature covers only the body and there is no nonce, so also enforce
 * a freshness window on the signed `timestamp` and dedupe on `delivery.id`.
 *
 * Uses the Web Crypto API (`crypto.subtle`), available in Node ≥ 18, Deno,
 * Bun, and edge runtimes — no dependency.
 */

/** Header names LexAPI sends on deliveries (lower-case, as most frameworks expose them). */
export const WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";
export const WEBHOOK_DELIVERY_HEADER = "x-webhook-delivery";
export const WEBHOOK_ID_HEADER = "x-webhook-id";

export type WebhookBody = string | Uint8Array | ArrayBuffer;

export interface VerifyWebhookOptions {
  /**
   * Reject deliveries whose signed `timestamp` is further than this from
   * now (replay guard). Default 300 000 ms (5 minutes). `0` disables the check.
   */
  toleranceMs?: number;
  /** Clock override (testing). Default `Date.now()`. */
  now?: number;
}

/** Thrown by {@link constructWebhookEvent} when a delivery fails verification. */
export class WebhookVerificationError extends Error {
  readonly reason: "missing_signature" | "invalid_signature" | "malformed_body" | "stale_timestamp";

  constructor(reason: WebhookVerificationError["reason"], message: string) {
    super(message);
    this.name = "WebhookVerificationError";
    this.reason = reason;
  }
}

type SubtleCryptoLike = {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: boolean,
    usages: ["sign"],
  ): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
};

async function getSubtle(): Promise<SubtleCryptoLike> {
  const globalCrypto = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto;
  if (globalCrypto?.subtle) return globalCrypto.subtle;
  // Node 18 without --experimental-global-webcrypto: fall back to node:crypto.
  // The specifier is a variable so browser/edge bundlers don't try to resolve it.
  const specifier = "node:crypto";
  const nodeCrypto = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as {
    webcrypto?: { subtle?: SubtleCryptoLike };
  };
  if (nodeCrypto.webcrypto?.subtle) return nodeCrypto.webcrypto.subtle;
  throw new Error("Web Crypto (crypto.subtle) is not available in this runtime");
}

function toBytes(body: WebhookBody): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Constant-time comparison of two equal-purpose strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compute the expected `X-Webhook-Signature` (hex HMAC-SHA256) for a raw body. */
export async function computeWebhookSignature(rawBody: WebhookBody, secret: string): Promise<string> {
  const subtle = await getSubtle();
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await subtle.sign("HMAC", key, toBytes(rawBody)));
}

/**
 * `true` when `signature` (the `X-Webhook-Signature` header) is the
 * HMAC-SHA256 of `rawBody` under `secret`. Constant-time comparison.
 * Signature only — use {@link constructWebhookEvent} to also check freshness.
 */
export async function verifyWebhookSignature(
  rawBody: WebhookBody,
  signature: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;
  const expected = await computeWebhookSignature(rawBody, secret);
  return timingSafeEqual(expected, signature.trim().toLowerCase());
}

/**
 * Verify a delivery and parse it into a typed {@link WebhookPayload}
 * (switch on `event`). Throws {@link WebhookVerificationError} on a missing
 * or invalid signature, a non-JSON body, or a `timestamp` outside
 * `toleranceMs` (default 5 minutes).
 *
 * ```ts
 * app.post("/lexapi-webhook", express.raw({ type: "application/json" }), async (req, res) => {
 *   try {
 *     const event = await constructWebhookEvent(req.body, req.get("x-webhook-signature"), secret);
 *     if (event.event === "watchlist.changes") handle(event.data.changes);
 *     res.sendStatus(200);
 *   } catch {
 *     res.sendStatus(401);
 *   }
 * });
 * ```
 */
export async function constructWebhookEvent(
  rawBody: WebhookBody,
  signature: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookPayload> {
  if (!signature) {
    throw new WebhookVerificationError("missing_signature", "Missing X-Webhook-Signature header");
  }
  if (!(await verifyWebhookSignature(rawBody, signature, secret))) {
    throw new WebhookVerificationError("invalid_signature", "X-Webhook-Signature does not match the body");
  }
  let payload: WebhookPayload;
  try {
    const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(toBytes(rawBody));
    payload = JSON.parse(text) as WebhookPayload;
  } catch {
    throw new WebhookVerificationError("malformed_body", "Webhook body is not valid JSON");
  }
  const toleranceMs = options.toleranceMs ?? 300_000;
  if (toleranceMs > 0) {
    const sentAt = Date.parse(String((payload as { timestamp?: unknown }).timestamp));
    const now = options.now ?? Date.now();
    if (Number.isNaN(sentAt) || Math.abs(now - sentAt) > toleranceMs) {
      throw new WebhookVerificationError(
        "stale_timestamp",
        `Webhook timestamp is outside the ${toleranceMs} ms tolerance window`,
      );
    }
  }
  return payload;
}
