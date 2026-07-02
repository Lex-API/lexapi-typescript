import type { CallOptions } from "./client.js";
import type { HttpClient } from "./http.js";
import type {
  WebhookCreateRequest,
  WebhookCreateResponse,
  WebhookDeliveriesParams,
  WebhookDeliveriesResponse,
  WebhookListResponse,
  WebhookResponse,
  WebhookTestResponse,
  WebhookUpdateRequest,
  WebhookUpdateResponse,
} from "./types.js";

/**
 * Webhook subscriptions — notify a URL when newly-published documents
 * match saved `/search` criteria. Accessed as `client.webhooks.*`.
 */
export class WebhooksAPI {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  /**
   * `GET /webhooks` — every webhook owned by the caller, newest first.
   * The `secret` is never returned here (only once, on creation).
   */
  async list(options?: CallOptions): Promise<WebhookListResponse> {
    return this.http.requestJson<WebhookListResponse>({
      method: "GET",
      path: "/webhooks",
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `POST /webhooks` — subscribe a URL to documents matching saved search
   * criteria. If `secret` is omitted the server generates one and returns
   * it in this response ONLY — store it. Rejected with 400 when the tier
   * webhook ceiling is reached (FREE=0, STARTER=2, PROFESSIONAL=10,
   * BUSINESS=50).
   */
  async create(request: WebhookCreateRequest, options?: CallOptions): Promise<WebhookCreateResponse> {
    return this.http.requestJson<WebhookCreateResponse>({
      method: "POST",
      path: "/webhooks",
      body: request,
      timeoutMs: options?.timeoutMs,
    });
  }

  /** `GET /webhooks/{id}` — full details including the 20 most recent deliveries. */
  async get(id: string, options?: CallOptions): Promise<WebhookResponse> {
    return this.http.requestJson<WebhookResponse>({
      method: "GET",
      path: `/webhooks/${encodeURIComponent(id)}`,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `PUT /webhooks/{id}` — partial update; only supplied fields change.
   * Setting `status: "ACTIVE"` also resets `consecutiveFailures` to 0
   * (re-enables an auto-paused webhook).
   */
  async update(
    id: string,
    request: WebhookUpdateRequest,
    options?: CallOptions,
  ): Promise<WebhookUpdateResponse> {
    return this.http.requestJson<WebhookUpdateResponse>({
      method: "PUT",
      path: `/webhooks/${encodeURIComponent(id)}`,
      body: request,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `DELETE /webhooks/{id}` — permanently deletes the webhook and its
   * delivery history. Resolves on 204; a repeat delete throws
   * `NotFoundError`.
   */
  async delete(id: string, options?: CallOptions): Promise<void> {
    await this.http.requestJson<undefined>({
      method: "DELETE",
      path: `/webhooks/${encodeURIComponent(id)}`,
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * `POST /webhooks/{id}/test` — synchronously POSTs a `webhook.test`
   * payload (HMAC-SHA256 signed via `X-Webhook-Signature`) to the webhook
   * URL and returns the upstream result. 10 s timeout; redirects are not
   * followed.
   */
  async test(id: string, options?: CallOptions): Promise<WebhookTestResponse> {
    return this.http.requestJson<WebhookTestResponse>({
      method: "POST",
      path: `/webhooks/${encodeURIComponent(id)}/test`,
      timeoutMs: options?.timeoutMs,
    });
  }

  /** `GET /webhooks/{id}/deliveries` — delivery history, most recent first. */
  async deliveries(
    id: string,
    params: WebhookDeliveriesParams = {},
    options?: CallOptions,
  ): Promise<WebhookDeliveriesResponse> {
    return this.http.requestJson<WebhookDeliveriesResponse>({
      method: "GET",
      path: `/webhooks/${encodeURIComponent(id)}/deliveries`,
      query: { limit: params.limit, offset: params.offset },
      timeoutMs: options?.timeoutMs,
    });
  }
}
