import { describe, expect, it } from "vitest";

import { getCreditUsage } from "../src/index.js";

describe("getCreditUsage", () => {
  it("maps the credits block (v2 accounts)", () => {
    const usage = getCreditUsage({
      usage: { current: 10, limit: 1000, remaining: 990, unit: "credits", resetsAt: "2026-08-01T00:00:00.000Z" },
      credits: {
        operation_weight: 5,
        current: 10,
        limit: 1200,
        remaining: 1190,
        included: 1000,
        topup: 200,
        resetsAt: "2026-08-01T00:00:00.000Z",
      },
    });

    expect(usage).toEqual({
      unitsCharged: 5,
      creditsRemaining: 1190,
      resetsAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("reports 0 unitsCharged for free operations", () => {
    const usage = getCreditUsage({ credits: { operation_weight: 0, remaining: 100 } });
    expect(usage.unitsCharged).toBe(0);
  });

  it("falls back to usage.remaining/resetsAt when credits is absent (legacy accounts)", () => {
    const usage = getCreditUsage({
      usage: { current: 3, limit: 100, remaining: 97, unit: "calls", resetsAt: "2026-07-03T00:00:00.000Z" },
    });

    expect(usage).toEqual({
      unitsCharged: undefined,
      creditsRemaining: 97,
      resetsAt: "2026-07-03T00:00:00.000Z",
    });
  });

  it("tolerates both blocks being absent", () => {
    expect(getCreditUsage({})).toEqual({
      unitsCharged: undefined,
      creditsRemaining: undefined,
      resetsAt: undefined,
    });
  });
});
