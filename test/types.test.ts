import { describe, expectTypeOf, it } from "vitest";

import type {
  AsOfReason,
  Document,
  DocumentContent,
  LexAPI,
  NationalDecision,
  NationalDocument,
  NationalDocumentContent,
  NationalDocumentKind,
  NationalSemanticLegislationResult,
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

  it("models the API 2.8.0 national document shape (always-present nullable fields)", () => {
    expectTypeOf<NationalDocument["documentKind"]>().toEqualTypeOf<NationalDocumentKind | null>();
    expectTypeOf<NationalDocument["decision"]>().toEqualTypeOf<NationalDecision | null>();
    expectTypeOf<NationalDocument["content"]>().toEqualTypeOf<NationalDocumentContent | null>();
    expectTypeOf<NationalDocument["ecli"]>().toEqualTypeOf<string | null>();
    expectTypeOf<NationalDocument["inForce"]>().toEqualTypeOf<boolean | null>();
    expectTypeOf<NationalSemanticLegislationResult["in_force"]>().toEqualTypeOf<boolean | null>();
    expectTypeOf<NationalSemanticLegislationResult["language"]>().toEqualTypeOf<string | null>();
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

describe("review S7", () => {
  it("getRecentDocuments takes a single documentType (the endpoint has no multi-type fan-out)", () => {
    expectTypeOf<import("../src/index.js").RecentDocumentsParams["documentType"]>().toEqualTypeOf<
      import("../src/index.js").DocumentType | undefined
    >();
  });
});

describe("round 2 — R1", () => {
  it("getRecentDocuments takes a single subdomain (EUR-Lex reads only the first DTS_SUBDOM)", () => {
    expectTypeOf<import("../src/index.js").RecentDocumentsParams["subdomain"]>().toEqualTypeOf<
      import("../src/index.js").Subdomain | undefined
    >();
    // author arrays stay: every AU_CODED is appended and EUR-Lex ORs them
    expectTypeOf<["commission", "council"]>().toMatchTypeOf<
      NonNullable<import("../src/index.js").RecentDocumentsParams["author"]>
    >();
  });
});
