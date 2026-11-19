import type { CreditedResponse } from "./types.js";

/**
 * Normalized credit visibility for one response (SDK contract §1.5).
 * All fields tolerate the `usage`/`credits` blocks being absent
 * (legacy daily-call accounts omit `credits`); a figure that is not a finite
 * number, or a `resetsAt` that is not a string, counts as absent.
 */
export interface CreditUsage {
  /**
   * Credits this specific request cost, mapped from
   * `credits.operation_weight`. `0` for free operations such as `/info`
   * and for legacy accounts without a credit pool (SDK contract §1.5).
   */
  unitsCharged: number;
  /** `credits.remaining`, falling back to `usage.remaining`. */
  creditsRemaining: number | undefined;
  /** When the quota window resets — `credits.resetsAt` falling back to `usage.resetsAt`. */
  resetsAt: string | null | undefined;
}

/** A finite number, else absent. */
function figure(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `credits.resetsAt`, else `usage.resetsAt`, each only when a string; `null` as sent when neither is one. */
function resetsAt(fromCredits: unknown, fromUsage: unknown): string | null | undefined {
  if (typeof fromCredits === "string") return fromCredits;
  if (typeof fromUsage === "string") return fromUsage;
  return (fromCredits === null || fromCredits === undefined) && fromUsage === null ? null : undefined;
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
  if (typeof response !== "object" || response === null) response = {};
  return {
    unitsCharged: figure(response.credits?.operation_weight) ?? 0,
    creditsRemaining: figure(response.credits?.remaining) ?? figure(response.usage?.remaining),
    resetsAt: resetsAt(response.credits?.resetsAt, response.usage?.resetsAt),
  };
}
