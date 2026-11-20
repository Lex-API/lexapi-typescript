import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every fenced `ts` block of README.md type-checks (strict) against the sources.
// `npm run check:readme` runs the same check against the built types.
describe("README examples", () => {
  it("type-check", () => {
    const script = fileURLToPath(new URL("../scripts/check-readme-types.mjs", import.meta.url));
    const out = execFileSync(process.execPath, [script, "--src"], { encoding: "utf8", stdio: "pipe" });
    expect(out).toMatch(/ts blocks type-check/);
  }, 120_000);
});
