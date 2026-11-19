import type { CallOptions } from "./client.js";
import { parseResponseHeaders } from "./headers.js";
import type { HttpClient, RequestOptions } from "./http.js";
import { REPEATS_BEFORE_THROW, count, startingPosition, stalled } from "./paging.js";
import type {
  WebhookCreateRequest,
  WebhookCreateResponse,
  WebhookDeleteResponse,
  WebhookDeliveriesParams,
  WebhookDeliveriesResponse,
  WebhookDelivery,
  WebhookListResponse,
  WebhookResponse,
  WebhookTestResponse,
  WebhookUpdateRequest,
  WebhookUpdateResponse,
} from "./types.js";

/**
 * Webhook subscriptions — notify a URL when newly-published documents match
 * saved criteria (`documents.new`) and/or watched acts change
 * (`watchlist.changes`). Accessed as `client.webhooks.*`. Webhook management
 * and deliveries cost no credits.
 *
 * Write calls (create / update / delete / test) are never retried on 5xx or
 * on network errors after the connection was made — only on 429 and on
 * connect-phase failures (nothing reached the API).
 */
export class WebhooksAPI {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  private async call<T extends object>(options: RequestOptions): Promise<T> {
    const { data, response } = await this.http.requestJsonWithResponse<T>(options);
    if (typeof data !== "object" || data === null) return data;
    return { ...data, headers: parseResponseHeaders(response) };
  }

  /**
   * `GET /webhooks` — every webhook owned by the caller, newest first.
   * The `secret` is never returned here (only once, on creation).
   */
  async list(options?: CallOptions): Promise<WebhookListResponse> {
    return this.call<WebhookListResponse>({
      method: "GET",
      path: "/webhooks",
      shape: { lists: ["webhooks"] },
      free: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /webhooks` — needs `searchCriteria`, `watchCelex`, or both. If
   * `secret` is omitted the server generates one and returns it in this
   * response ONLY — store it. Rejected with 400 (`InvalidParamsError`):
   * unsupported criteria or a watch list above the plan limit carry a
   * `details` list; the tier webhook ceiling (FREE=0, STARTER=2,
   * PROFESSIONAL=10, BUSINESS=50, SCALE=100, ENTERPRISE=100) has no
   * `details` — read `current` / `limit` from `error.body`.
   */
  async create(request: WebhookCreateRequest, options?: CallOptions): Promise<WebhookCreateResponse> {
    return this.call<WebhookCreateResponse>({
      method: "POST",
      path: "/webhooks",
      body: request,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /** `GET /webhooks/{id}` — full details incl. `retryPolicy` and the 20 most recent deliveries. */
  async get(id: string, options?: CallOptions): Promise<WebhookResponse> {
    return this.call<WebhookResponse>({
      method: "GET",
      path: `/webhooks/${encodeURIComponent(id)}`,
      free: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `PUT /webhooks/{id}` — partial update; only supplied fields change.
   * `watchCelex` replaces the whole list; `searchCriteria: null` removes the
   * criteria (one of the two must remain). Setting `status: "ACTIVE"`
   * resets `consecutiveFailures`; moving a `FAILED` or `PAUSED` webhook to
   * `ACTIVE` also re-queues its deliveries from the last 7 days that ran out
   * of retries (count in `requeuedDeliveries`, 0 otherwise).
   */
  async update(
    id: string,
    request: WebhookUpdateRequest,
    options?: CallOptions,
  ): Promise<WebhookUpdateResponse> {
    return this.call<WebhookUpdateResponse>({
      method: "PUT",
      path: `/webhooks/${encodeURIComponent(id)}`,
      body: request,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `DELETE /webhooks/{id}` — permanently deletes the webhook and its
   * delivery history. Resolves with the server's `{ success, message }`
   * (an empty object plus `headers` on a bodiless 204); a repeat delete
   * throws `NotFoundError`.
   */
  async delete(id: string, options?: CallOptions): Promise<WebhookDeleteResponse | undefined> {
    return this.call<WebhookDeleteResponse>({
      method: "DELETE",
      path: `/webhooks/${encodeURIComponent(id)}`,
      shape: { allowEmpty: true },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * `POST /webhooks/{id}/test` — synchronously POSTs a `webhook.test`
   * payload (HMAC-SHA256 signed via `X-Webhook-Signature`) to the webhook
   * URL and returns the upstream result. 10 s timeout; redirects are not
   * followed; not recorded in the delivery history.
   */
  async test(id: string, options?: CallOptions): Promise<WebhookTestResponse> {
    return this.call<WebhookTestResponse>({
      method: "POST",
      path: `/webhooks/${encodeURIComponent(id)}/test`,
      shape: { successFalseOk: true },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /** `GET /webhooks/{id}/deliveries` — delivery history, most recent first. */
  async deliveries(
    id: string,
    params: WebhookDeliveriesParams = {},
    options?: CallOptions,
  ): Promise<WebhookDeliveriesResponse> {
    return this.call<WebhookDeliveriesResponse>({
      method: "GET",
      path: `/webhooks/${encodeURIComponent(id)}/deliveries`,
      shape: { lists: ["deliveries"] },
      free: true,
      query: { limit: params.limit, offset: params.offset },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  /**
   * Walk the whole delivery history page by page (`limit` per page, default
   * 50), starting at `offset`, newest first (SDK contract §1.4). Each
   * delivery is yielded at most once (deduplicated on `id`): a delivery
   * created during the walk shifts later pages by one. Stops on an empty page
   * or when the offset reaches `total`. Without a usable `total`, three pages
   * in a row that bring no unseen `id` throw `InvalidResponseError` (a page
   * with a usable `total` ends a run). When a walk throws, the pages already
   * yielded stay valid; the page that showed the stall is not yielded and is
   * on the error's `body`. A starting `offset` or `limit` that is not a
   * non-negative (positive) integer is a `RangeError` before any request.
   * Pages are free (0 credits).
   *
   * ```ts
   * for await (const page of client.webhooks.paginateDeliveries(id)) {
   *   for (const d of page.deliveries) console.log(d.status, d.responseStatus);
   * }
   * ```
   */
  async *paginateDeliveries(
    id: string,
    params: WebhookDeliveriesParams = {},
    options?: CallOptions,
  ): AsyncGenerator<WebhookDeliveriesResponse, void> {
    const start = startingPosition(params.offset, params.limit, 50);
    const limit = start.limit;
    let offset = start.offset;
    const seen = new Set<string>();
    let repeats = 0;
    for (;;) {
      const page = await this.deliveries(id, { limit, offset }, options);
      const listed: unknown = page.deliveries;
      const deliveries: WebhookDelivery[] = Array.isArray(listed) ? listed : [];
      const rows = deliveries.length;
      let readable = 0;
      let unseen = 0;
      const fresh = deliveries.filter((d) => {
        if (typeof d.id !== "string") return true;
        readable++;
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        unseen++;
        return true;
      });
      const total = count(page.total);
      if (total === undefined) {
        // No usable total: only pages of already-yielded ids, again and again, are a stall.
        // The page that shows it is not yielded; it is on the error's `body`.
        repeats = readable > 0 && unseen === 0 ? repeats + 1 : 0;
        if (repeats >= REPEATS_BEFORE_THROW) throw stalled("the server repeated the same deliveries", page);
      } else {
        repeats = 0; // a page with a usable total ends any run of repeats
      }
      yield { ...page, deliveries: fresh };
      offset += rows;
      if (rows === 0 || (total !== undefined && offset >= total)) return;
    }
  }
}
