import type { CreditedResponse } from "./types.js";

/**
 * Normalized credit visibility for one response (SDK contract §1.5).
 * All fields tolerate the `usage`/`credits` blocks being absent
 * (legacy daily-call accounts omit `credits`).
 */
export interface CreditUsage {
  /**
   * Credits this specific request cost, mapped from
   * `credits.operation_weight`. `0` for free operations such as `/info`;
   * `undefined` when the account has no credit pool (legacy accounts).
   */
  unitsCharged: number | undefined;
  /** `credits.remaining`, falling back to `usage.remaining`. */
  creditsRemaining: number | undefined;
  /** When the quota window resets — `credits.resetsAt` falling back to `usage.resetsAt`. */
  resetsAt: string | null | undefined;
}

/**
 * Read the credit state off any LexAPI response. The raw `usage`/`credits`
 * blocks stay accessible on the response itself, loss-free.
 *
 * ```ts
 * const info = await client.getInfo();
 * const { unitsCharged, creditsRemaining, resetsAt } = getCreditUsage(info);
 * ```
 */
export function getCreditUsage(response: CreditedResponse): CreditUsage {
  return {
    unitsCharged: response.credits?.operation_weight,
    creditsRemaining: response.credits?.remaining ?? response.usage?.remaining,
    resetsAt: response.credits?.resetsAt ?? response.usage?.resetsAt,
  };
}
