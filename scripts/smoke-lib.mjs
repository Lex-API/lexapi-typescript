// Shared runtime smoke checks for the BUILT bundles (see smoke-dist.mjs /
// smoke-dist.cjs). Plain node:assert, no test framework — so it runs on
// every Node version the package claims to support (engines >= 18),
// including ones the dev toolchain (vitest) can't run on.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { format, inspect } from "node:util";

export async function runSmoke(lib, label) {
  const { LexAPI, VERSION, CreditsExhaustedError, verifySignature, AS_OF_REASONS, CITATION_TYPES } = lib;
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify({ service: "LexAPI", credits: { operation_weight: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json", "ratelimit-remaining": "59" },
      });
    }
    if (url.endsWith("/legislation/semantic")) {
      return new Response(
        JSON.stringify({ success: true, results: [{ law_id: "32016R0679", asOfResolved: true }], asOf: "2020-01-01" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/resolve")) {
      return new Response(new TextEncoder().encode("<html>proxy page</html>"), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(
      JSON.stringify({ success: false, error: { code: "CREDITS_EXHAUSTED", message: "x", details: { weight: 5 } } }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  };

  const client = new LexAPI({ apiKey: "lex_smoke", fetch: fetchStub, retry: { maxRetries: 0 } });

  assert.ok(!JSON.stringify(client).includes("lex_smoke"), "API key leaked via JSON.stringify");
  const info = await client.getInfo();
  assert.equal(info.service, "LexAPI");
  assert.equal(info.headers.rateLimit.remaining, 59);
  assert.equal(calls[0].init.headers["x-api-key"], "lex_smoke");
  assert.equal(calls[0].init.headers["user-agent"], `lexapi-typescript/${VERSION}`);

  const asOf = await client.semanticLegislationSearch({ query: "gdpr", asOf: "2020-01-01" });
  assert.equal(JSON.parse(calls[1].init.body).asOf, "2020-01-01");
  assert.equal(asOf.results[0].asOfResolved, true);

  await assert.rejects(() => client.getDocument({ celexNumber: "32016R0679" }), (err) => {
    assert.ok(err instanceof CreditsExhaustedError);
    assert.equal(err.weight, 5);
    return true;
  });

  await assert.rejects(() => client.resolve("32016R0679"), (err) => {
    assert.ok(err instanceof lib.InvalidResponseError);
    assert.equal(err.message, "[INVALID_RESPONSE] Expected JSON, got text/html that does not parse as JSON (23 bytes) (HTTP 200)");
    assert.equal(err.bodyExcerpt, "<html>proxy page</html>");
    assert.ok(!JSON.stringify(err).includes("proxy page"), "response text leaked via JSON.stringify");
    assert.ok(!Object.getOwnPropertyNames(err).includes("bodyExcerpt"));
    for (const shown of [format("%o", err), inspect(err, { showHidden: true }), inspect(err, { getters: true })]) {
      assert.ok(!shown.includes("proxy page"), "response text leaked via util.inspect / %o");
    }
    return true;
  });

  const pastDue = lib.LexAPIError.fromResponse(403, {
    success: false,
    code: "PAYMENT_PAST_DUE",
    error: "Payment past due",
    billingUrl: "https://example.test/billing",
  });
  assert.ok(pastDue instanceof lib.PaymentPastDueError);
  assert.ok(pastDue instanceof lib.TierForbiddenError);
  assert.equal(pastDue.code, "PAYMENT_PAST_DUE");
  assert.equal(pastDue.billingUrl, "https://example.test/billing");
  assert.equal(pastDue.accessEndedAt, undefined);
  const unknown = lib.LexAPIError.fromResponse(404, {
    success: false,
    error: { code: "NOT_FOUND", message: "Unknown API endpoint", details: { reason: "unknown_endpoint" } },
  });
  assert.ok(unknown instanceof lib.NotFoundError);
  assert.equal(unknown.unknownEndpoint, true);
  assert.equal(new lib.NotFoundError("x").unknownEndpoint, false);
  const boundary = lib.LexAPIError.fromResponse(404, {
    success: false,
    error: { code: "NOT_FOUND", message: "x", details: { reason: "boundary_unknown", candidates: [{ version: 1 }, "x"] } },
  });
  assert.equal(boundary.boundaryUnknown, true);
  assert.deepEqual(boundary.candidates, [{ version: 1, fetchedAt: null, observedFrom: null }]);
  assert.deepEqual(new lib.NotFoundError("x").candidates, []);

  await client.nationalLegislationSemanticSearch("AT", { query: "Auskunft", asOf: "2020-06-01" });
  assert.equal(JSON.parse(calls.at(-1).init.body).asOf, "2020-06-01");
  assert.deepEqual(lib.NATIONAL_AS_OF_REASONS, ["provision_amended_since", "no_longer_in_force", "provision_dates_unknown", "asof_not_available"]);
  assert.equal(lib.isNationalAsOfVersion({ kind: "current_unit" }), true);
  assert.equal(lib.isNationalAsOfVersion(null), false);

  // Timeout and cancellation work on this runtime.
  const stalled = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const slow = new LexAPI({ apiKey: "lex_smoke", fetch: stalled, timeoutMs: 50, retry: { maxRetries: 0 } });
  await assert.rejects(() => slow.getInfo(), (err) => err instanceof lib.TimeoutError);
  const controller = new AbortController();
  const pending = slow.getInfo({ signal: controller.signal, timeoutMs: 10_000 });
  controller.abort();
  await assert.rejects(() => pending, (err) => err instanceof lib.RequestAbortedError);

  const body = JSON.stringify({ event: "webhook.test", timestamp: new Date().toISOString() });
  const sig = createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(await verifySignature(body, sig, "secret"), true);

  // Webhook bodies are strict UTF-8 on this runtime: one byte order mark is
  // ignored; invalid bytes under a valid signature are a malformed body.
  const signed = (bytes) => createHmac("sha256", "secret").update(bytes).digest("hex");
  const utf8 = new TextEncoder().encode(body);
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  assert.equal((await lib.verifyWebhook(withBom, signed(withBom), "secret")).event, "webhook.test");
  for (const bad of [[0xff], [0xed, 0xa0, 0x80], [0xc0, 0xaf], [0xe2, 0x82]]) {
    const bytes = new Uint8Array([...utf8.subarray(0, 10), ...bad, ...utf8.subarray(10)]);
    await assert.rejects(
      () => lib.verifyWebhook(bytes, signed(bytes), "secret"),
      (err) => err instanceof lib.WebhookSignatureError && err.reason === "malformed_body",
    );
  }
  const deep = new TextEncoder().encode(`{"timestamp":"${new Date().toISOString()}","x":${"[".repeat(100_000)}${"]".repeat(100_000)}}`);
  await lib.verifyWebhook(deep, signed(deep), "secret").catch((err) => {
    assert.ok(err instanceof lib.WebhookSignatureError && err.reason === "malformed_body", String(err));
  });
  assert.equal(AS_OF_REASONS.length, 20);
  assert.ok(CITATION_TYPES.includes("transposition"));

  console.log(`smoke:dist ${label} OK on ${runtime()} (@lexapi/client ${VERSION})`);
}

function runtime() {
  if (typeof globalThis.Bun !== "undefined") return `Bun ${globalThis.Bun.version}`;
  if (typeof globalThis.Deno !== "undefined") return `Deno ${globalThis.Deno.version.deno}`;
  return `Node ${process.version}`;
}
