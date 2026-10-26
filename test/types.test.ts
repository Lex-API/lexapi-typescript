import { describe, expectTypeOf, it } from "vitest";

import type {
  AsOfReason,
  Document,
  DocumentContent,
  LexAPI,
  ResolvedVia,
  SemanticLegislationSearchOptions,
  WebhookCreateRequest,
  WebhookPayload,
} from "../src/index.js";

// Compile-time contract checks (tsc --noEmit runs over test/ too).
describe("public types", () => {
  it("models nullable document content", () => {
    expectTypeOf<Document["content"]>().toEqualTypeOf<DocumentContent | null | undefined>();
  });

  it("accepts asOf on legislation search options only", () => {
    expectTypeOf<SemanticLegislationSearchOptions>().toHaveProperty("asOf");
    expectTypeOf<Parameters<LexAPI["semanticLegislationSearch"]>[0]>().toEqualTypeOf<SemanticLegislationSearchOptions>();
  });

  it("keeps open enums assignable from known literals", () => {
    expectTypeOf<"insufficient_credits">().toMatchTypeOf<AsOfReason>();
    expectTypeOf<"ecli-corpus">().toMatchTypeOf<ResolvedVia>();
  });

  it("allows watch-list-only webhooks", () => {
    expectTypeOf<{ name: string; url: string; watchCelex: string[] }>().toMatchTypeOf<WebhookCreateRequest>();
  });

  it("discriminates webhook payloads on event", () => {
    expectTypeOf<WebhookPayload["event"]>().toEqualTypeOf<"documents.new" | "watchlist.changes" | "webhook.test">();
  });
});
