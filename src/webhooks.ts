import type { CallOptions } from "./client.js";
import { parseResponseHeaders } from "./headers.js";
import type { HttpClient, RequestOptions } from "./http.js";
import type {
  WebhookCreateRequest,
  WebhookCreateResponse,
  WebhookDeleteResponse,
  WebhookDeliveriesParams,
  WebhookDeliveriesResponse,
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
   * or when the offset reaches `total`. Pages are free (0 credits).
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
    const limit = params.limit ?? 50;
    let offset = params.offset ?? 0;
    const seen = new Set<string>();
    for (;;) {
      const page = await this.deliveries(id, { limit, offset }, options);
      const count = page.deliveries.length;
      const fresh = page.deliveries.filter((d) => {
        if (typeof d.id !== "string") return true;
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
      });
      yield { ...page, deliveries: fresh };
      offset += count;
      if (count === 0 || (page.total !== undefined && offset >= page.total)) return;
    }
  }
}
