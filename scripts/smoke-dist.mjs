// Smoke test of the BUILT ESM bundle (dist/index.js), plus the dual-package
// hazard: errors thrown by the CommonJS build must satisfy the ESM build's
// instanceof checks (and vice versa).
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import * as sdk from "../dist/index.js";
import { runSmoke } from "./smoke-lib.mjs";

await runSmoke(sdk, "esm");

const cjs = createRequire(import.meta.url)("../dist/index.cjs");
assert.notEqual(cjs.NotFoundError, sdk.NotFoundError);
assert.ok(new cjs.NotFoundError("x") instanceof sdk.NotFoundError);
assert.ok(new cjs.NotFoundError("x") instanceof sdk.LexAPIError);
assert.ok(new sdk.RateLimitedError("x") instanceof cjs.RateLimitedError);
assert.ok(!(new cjs.NotFoundError("x") instanceof sdk.UpstreamError));
assert.ok(sdk.isLexAPIError(new cjs.TimeoutError("x"), sdk.TimeoutError));
assert.ok(new cjs.WebhookSignatureError("invalid_signature", "x") instanceof sdk.WebhookSignatureError);
console.log("smoke:dist dual-package instanceof OK");
