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

/** A lone surrogate: a high one not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** `true` when a string has no lone surrogate, so it has a UTF-8 encoding. */
function isWellFormed(text: string): boolean {
  const native = (String.prototype as { isWellFormed?: (this: string) => boolean }).isWellFormed;
  return typeof native === "function" ? native.call(text) : !LONE_SURROGATE.test(text);
}

/**
 * The bytes a body stands for: a string's UTF-8 encoding. A string with a
 * lone surrogate has none (`TextEncoder` would write U+FFFD in its place, a
 * different text), so it is refused rather than repaired.
 */
function toBytes(body: WebhookBody): Uint8Array {
  if (typeof body === "string") {
    if (!isWellFormed(body)) {
      throw new WebhookSignatureError("malformed_body", "Webhook body string is not well-formed Unicode (lone surrogate)");
    }
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Remove leading and trailing spaces, tabs, carriage returns and line feeds, and nothing else. */
function trimHeader(value: string): string {
  const space = (code: number) => code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;
  let start = 0;
  let end = value.length;
  while (start < end && space(value.charCodeAt(start))) start++;
  while (end > start && space(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

const TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/;

/**
 * A signed `timestamp` as epoch milliseconds: a string
 * `YYYY-MM-DDTHH:MM:SS[.fraction]` followed by `Z` or a `±HH:MM` offset, a
 * real calendar date and time (SDK contract §1.9). Anything else is
 * `undefined`.
 */
function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = TIMESTAMP.exec(value);
  if (!match) return undefined;
  const [y, mo, d, h, mi, sec] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const fraction = match[7];
  const sign = match[8];
  const offH = sign === undefined ? 0 : Number(match[9]);
  const offM = sign === undefined ? 0 : Number(match[10]);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (days === undefined || d < 1 || d > days || h > 23 || mi > 59 || sec > 59 || offH > 23 || offM > 59) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, sec, 0);
  const offset = (sign === "-" ? -1 : 1) * (offH * 60 + offM) * 60_000;
  return date.getTime() + (fraction === undefined ? 0 : Number(`0.${fraction}`) * 1000) - offset;
}

/** Constant-time comparison of two equal-purpose strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Compute the expected `X-Webhook-Signature` (hex HMAC-SHA256) for a raw
 * body. A string body is signed as its UTF-8 encoding; a string with a lone
 * surrogate has none and throws `WebhookSignatureError("malformed_body")`.
 */
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
 * (a configuration error, not a bad delivery). A string body with a lone
 * surrogate is `false`.
 */
export async function verifySignature(
  rawBody: WebhookBody,
  signature: string | null | undefined,
  secret: string,
): Promise<boolean> {
  // §1.9: spaces, tabs, CR and LF around the header are removed, nothing
  // else; a missing, empty, non-ASCII or non-hex header is a plain failure.
  const candidate = typeof signature === "string" ? trimHeader(signature) : "";
  assertSecret(secret);
  // A string with a lone surrogate has no UTF-8 bytes to verify: a plain failure.
  if (typeof rawBody === "string" && !isWellFormed(rawBody)) return false;
  const expected = await computeSignature(rawBody, secret);
  if (!/^[0-9a-fA-F]{64}$/.test(candidate)) return false;
  return timingSafeEqual(expected, candidate.toLowerCase());
}

/**
 * Verify a delivery and parse it into a typed {@link WebhookPayload}
 * (switch on `event`). Throws {@link WebhookSignatureError}; its `reason`
 * is the first check that fails, in this order: an empty secret
 * (`missing_secret`), an absent or empty header (`missing_signature`), the
 * signature (`invalid_signature`), a body that is not one UTF-8 JSON object
 * (`malformed_body`), a `timestamp` that is not
 * `YYYY-MM-DDTHH:MM:SS[.fraction]` with `Z` or a `±HH:MM` offset, or is
 * further than `toleranceMs` (default 5 minutes) from now (`stale_timestamp`).
 *
 * The body is decoded as strict UTF-8 (one leading byte order mark is
 * ignored) and parsed from the same bytes the signature covers, as one
 * strict JSON text (no `NaN` or `Infinity`). A string body stands for its
 * UTF-8 encoding; a string with a lone surrogate has none and fails
 * verification (`invalid_signature`).
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
  if (typeof rawBody === "string" && !isWellFormed(rawBody)) {
    throw new WebhookSignatureError("invalid_signature", "Webhook body string is not well-formed Unicode (lone surrogate)");
  }
  const bytes = toBytes(rawBody);
  if (!(await verifySignature(bytes, signature, secret))) {
    throw new WebhookSignatureError("invalid_signature", "X-Webhook-Signature does not match the body");
  }
  let payload: unknown;
  try {
    // The bytes the signature covers, decoded as strict UTF-8: any invalid
    // sequence throws; one leading byte order mark is dropped.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    payload = JSON.parse(text);
  } catch {
    throw new WebhookSignatureError("malformed_body", "Webhook body is not valid JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new WebhookSignatureError("malformed_body", "Webhook body is not a JSON object");
  }
  const toleranceMs = options.toleranceMs ?? 300_000;
  if (toleranceMs > 0) {
    const sentAt = timestampMs((payload as { timestamp?: unknown }).timestamp);
    const now = options.now ?? Date.now();
    if (sentAt === undefined || Math.abs(now - sentAt) > toleranceMs) {
      throw new WebhookSignatureError(
        "stale_timestamp",
        `Webhook timestamp is outside the ${toleranceMs} ms tolerance window`,
      );
    }
  }
  return payload as WebhookPayload;
}
