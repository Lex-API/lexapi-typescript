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

describe("citation graph types (API 2.10.0–2.13.0)", () => {
  it("CitationType includes transposition and the filters take one value or a list", () => {
    expectTypeOf<"transposition">().toMatchTypeOf<import("../src/index.js").CitationType>();
    type Filters = import("../src/index.js").CitationFilterParams;
    expectTypeOf<{ citationType: ["amendment", "repeal"] }>().toMatchTypeOf<Filters>();
    expectTypeOf<{ citationType: "amendment" }>().toMatchTypeOf<Filters>();
    expectTypeOf<{ provenance: ["notice", "cellar-nim"]; resolution: ["id", "key"]; jurisdictions: ["eu", "at"] }>().toMatchTypeOf<Filters>();
    expectTypeOf<{ citationType: "cites" }>().not.toMatchTypeOf<Filters>();
    expectTypeOf<{ provenance: "unknown" }>().not.toMatchTypeOf<Filters>();
  });

  it("every graph method accepts the filters; unresolved only on cites and network", () => {
    expectTypeOf<NonNullable<Parameters<LexAPI["getCites"]>[1]>>().toHaveProperty("unresolved");
    expectTypeOf<NonNullable<Parameters<LexAPI["getCitationNetwork"]>[1]>>().toHaveProperty("unresolved");
    expectTypeOf<NonNullable<Parameters<LexAPI["getCitedBy"]>[1]>>().toHaveProperty("provenance");
    expectTypeOf<NonNullable<Parameters<LexAPI["getCitedBy"]>[1]>>().not.toHaveProperty("unresolved");
    expectTypeOf<NonNullable<Parameters<LexAPI["getRelatedDocuments"]>[1]>>().toHaveProperty("resolution");
    expectTypeOf<Parameters<LexAPI["getCitationPath"]>[2]>().toEqualTypeOf<import("../src/index.js").CitationPathParams | undefined>();
    expectTypeOf<import("../src/index.js").CitationPathParams>().toHaveProperty("jurisdictions");
  });

  it("edge provenance / resolution are nullable; countsSource is stats | counted", () => {
    type Edge = import("../src/index.js").CitationEdgeDetail;
    expectTypeOf<NonNullable<Edge["provenance"]>>().toEqualTypeOf<import("../src/index.js").CitationProvenance>();
    expectTypeOf<Edge["resolution"]>().toEqualTypeOf<import("../src/index.js").CitationResolution | null | undefined>();
    expectTypeOf<NonNullable<import("../src/index.js").CitedByResponse["countsSource"]>>().toEqualTypeOf<"stats" | "counted">();
    expectTypeOf<import("../src/index.js").CitationNetworkResponse["paging"]["countsSource"]>().toEqualTypeOf<
      "stats" | "counted" | null | undefined
    >();
  });

  it("new methods return their response types", () => {
    expectTypeOf<ReturnType<LexAPI["getTransposition"]>>().toEqualTypeOf<Promise<import("../src/index.js").TranspositionResponse>>();
    expectTypeOf<ReturnType<LexAPI["getCounterparts"]>>().toEqualTypeOf<Promise<import("../src/index.js").CounterpartsResponse>>();
    expectTypeOf<import("../src/index.js").Counterpart["rank"]>().toEqualTypeOf<1 | 2 | 3>();
  });

  it("national content carries textSource / ocr (API 2.9.0)", () => {
    expectTypeOf<NationalDocumentContent["ocr"]>().toEqualTypeOf<import("../src/index.js").NationalOcrInfo | null>();
    expectTypeOf<"pdf-text">().toMatchTypeOf<NonNullable<NationalDocumentContent["textSource"]>>();
  });
});
