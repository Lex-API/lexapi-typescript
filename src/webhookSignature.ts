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
 * Uses the Web Crypto API (`crypto.subtle`), available in Node ≥ 18, Deno
 * and Bun — no dependency.
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

const VERIFICATION_BRAND = Symbol.for("@lexapi/client.webhookSignatureError");

/**
 * Thrown by {@link verifyWebhook} when a delivery fails verification,
 * and by every helper when the `secret` is empty (`missing_secret`).
 * `instanceof` works across the ESM and CommonJS builds (shared brand).
 */
export class WebhookSignatureError extends Error {
  readonly reason:
    | "missing_secret"
    | "missing_signature"
    | "invalid_signature"
    | "malformed_body"
    | "stale_timestamp";

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return this === WebhookSignatureError && (value as Record<symbol, unknown>)[VERIFICATION_BRAND] === true;
  }

  constructor(reason: WebhookSignatureError["reason"], message: string) {
    super(message);
    this.name = "WebhookSignatureError";
    this.reason = reason;
    Object.defineProperty(this, VERIFICATION_BRAND, { value: true, enumerable: false });
  }
}

function assertSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new WebhookSignatureError(
      "missing_secret",
      "Webhook secret is empty — pass the secret returned when the webhook was created",
    );
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
export async function computeSignature(rawBody: WebhookBody, secret: string): Promise<string> {
  assertSecret(secret);
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
 * Signature only — use {@link verifyWebhook} to also check freshness.
 * Throws `WebhookSignatureError("missing_secret")` for an empty secret
 * (a configuration error, not a bad delivery).
 */
export async function verifySignature(
  rawBody: WebhookBody,
  signature: string | null | undefined,
  secret: string,
): Promise<boolean> {
  // §1.9: a missing, empty, non-ASCII or non-hex header is a plain failure.
  const candidate = typeof signature === "string" ? signature.trim().toLowerCase() : "";
  const expected = await computeSignature(rawBody, secret); // validates the secret first
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
  return timingSafeEqual(expected, candidate);
}

/**
 * Verify a delivery and parse it into a typed {@link WebhookPayload}
 * (switch on `event`). Throws {@link WebhookSignatureError} on a missing
 * or invalid signature, a non-JSON body, or a `timestamp` outside
 * `toleranceMs` (default 5 minutes).
 *
 * ```ts
 * app.post("/lexapi-webhook", express.raw({ type: "application/json" }), async (req, res) => {
 *   try {
 *     const event = await verifyWebhook(req.body, req.get("x-webhook-signature"), secret);
 *     if (event.event === "watchlist.changes") handle(event.data.changes);
 *     res.sendStatus(200);
 *   } catch {
 *     res.sendStatus(401);
 *   }
 * });
 * ```
 */
export async function verifyWebhook(
  rawBody: WebhookBody,
  signature: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookPayload> {
  assertSecret(secret);
  if (!signature) {
    throw new WebhookSignatureError("missing_signature", "Missing X-Webhook-Signature header");
  }
  if (!(await verifySignature(rawBody, signature, secret))) {
    throw new WebhookSignatureError("invalid_signature", "X-Webhook-Signature does not match the body");
  }
  let payload: WebhookPayload;
  try {
    const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(toBytes(rawBody));
    payload = JSON.parse(text) as WebhookPayload;
  } catch {
    throw new WebhookSignatureError("malformed_body", "Webhook body is not valid JSON");
  }
  const toleranceMs = options.toleranceMs ?? 300_000;
  if (toleranceMs > 0) {
    const sentAt = Date.parse(String((payload as { timestamp?: unknown }).timestamp));
    const now = options.now ?? Date.now();
    if (Number.isNaN(sentAt) || Math.abs(now - sentAt) > toleranceMs) {
      throw new WebhookSignatureError(
        "stale_timestamp",
        `Webhook timestamp is outside the ${toleranceMs} ms tolerance window`,
      );
    }
  }
  return payload;
}
