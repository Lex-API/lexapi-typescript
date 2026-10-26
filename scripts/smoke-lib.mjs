// Shared runtime smoke checks for the BUILT bundles (see smoke-dist.mjs /
// smoke-dist.cjs). Plain node:assert, no test framework — so it runs on
// every Node version the package claims to support (engines >= 18),
// including ones the dev toolchain (vitest) can't run on.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

export async function runSmoke(lib, label) {
  const { LexAPI, VERSION, CreditsExhaustedError, verifyWebhookSignature, AS_OF_REASONS } = lib;
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
    return new Response(
      JSON.stringify({ success: false, error: { code: "CREDITS_EXHAUSTED", message: "x", details: { weight: 5 } } }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  };

  const client = new LexAPI({ apiKey: "lex_smoke", fetch: fetchStub, retry: { maxRetries: 0 } });

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

  const body = JSON.stringify({ event: "webhook.test", timestamp: new Date().toISOString() });
  const sig = createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(await verifyWebhookSignature(body, sig, "secret"), true);
  assert.equal(AS_OF_REASONS.length, 19);

  console.log(`smoke:dist ${label} OK on Node ${process.version} (@lexapi/client ${VERSION})`);
}
