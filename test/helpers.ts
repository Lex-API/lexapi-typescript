import { vi } from "vitest";

export function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch stub that returns the given responses in order (last one repeats). */
export function fetchSequence(...responses: Array<Response | Error>) {
  let call = 0;
  return vi.fn(async (): Promise<Response> => {
    const item = responses[Math.min(call++, responses.length - 1)]!;
    if (item instanceof Error) throw item;
    return item.clone();
  });
}

/** Retry options that keep unit tests fast. */
export const FAST_RETRY = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 };
