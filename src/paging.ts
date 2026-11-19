import { InvalidResponseError } from "./errors.js";

/** A non-negative integer, else `undefined`. */
export function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Pages in a row, each repeating the one before (by content or, for
 * deliveries, bringing no unseen id), after which a walk the server gives no
 * position for throws (SDK contract §1.4).
 */
export const REPEATS_BEFORE_THROW = 3;

/** The error an iterator throws when its server stops advancing (SDK contract §1.4). */
export function stalled(reason: string, page: unknown): InvalidResponseError {
  return new InvalidResponseError(`Pagination stopped: ${reason}`, 200, page);
}

class Token {
  constructor(readonly text: string) {}
}

/**
 * A compact text form of a JSON value, for comparing one page with the next.
 * Iterative, so a deeply nested value cannot overflow the stack.
 */
export function compactForm(value: unknown): string {
  let out = "";
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item instanceof Token) out += item.text;
    else if (typeof item === "string") out += JSON.stringify(item);
    else if (Array.isArray(item)) {
      out += "[";
      stack.push(new Token("]"));
      for (let i = item.length - 1; i >= 0; i--) {
        stack.push(item[i]);
        if (i > 0) stack.push(new Token(","));
      }
    } else if (typeof item === "object" && item !== null) {
      out += "{";
      stack.push(new Token("}"));
      const keys = Object.keys(item);
      for (let i = keys.length - 1; i >= 0; i--) {
        stack.push((item as Record<string, unknown>)[keys[i]!]);
        stack.push(new Token(`${i > 0 ? "," : ""}${JSON.stringify(keys[i])}:`));
      }
    } else out += String(item);
  }
  return out;
}
