// Compile-only (tsc --noEmit covers test/): code written against the 0.4.0
// types must keep compiling. Not run by the test runner.
import {
  AS_OF_REASONS,
  LexAPI,
  NotFoundError,
  type AsOfReason,
  type AsOfVersion,
  type Document,
  type DocumentMetadataResponse,
  type DocumentVersionResponse,
  type NationalSemanticLegislationOptions,
  type NationalSemanticLegislationResponse,
  type NationalSemanticLegislationResult,
  type SemanticCaseLawResult,
  type SemanticLegislationResult,
  type SemanticLegislationSearchResponse,
  type VersionEntry,
} from "../src/index.js";

export async function usage(client: LexAPI): Promise<string[]> {
  const out: string[] = [];

  const atDate: DocumentVersionResponse = await client.getDocumentAtDate("32016R0679", "2026-04-01");
  const entry: VersionEntry = atDate.document;
  out.push(String(entry.version), entry.fetchedAt, atDate.asOf ?? "");

  const eu: SemanticLegislationSearchResponse = await client.semanticLegislationSearch({ query: "x", asOf: "2019-06-01" });
  const hits: SemanticLegislationResult[] = eu.results;
  for (const hit of hits) {
    const reason: AsOfReason | undefined = hit.asOfReason;
    if (reason === "not_yet_in_force" || reason === "some_reason_from_a_later_api") out.push(reason);
    const version: AsOfVersion | undefined = hit.asOfVersion;
    out.push(version?.celex ?? "", String(hit["inForce"]));
  }
  out.push(...AS_OF_REASONS.filter((r) => r !== "insufficient_credits"));

  const cases: SemanticCaseLawResult[] = (await client.semanticSearch({ query: "x" })).results;
  out.push(String(cases[0]?.["provenance"]));

  const options: NationalSemanticLegislationOptions = { query: "Kündigungsfrist", filters: { inForce: true } };
  const national: NationalSemanticLegislationResponse = await client.nationalLegislationSemanticSearch("DE", options);
  for (const hit of national.results) {
    const h: NationalSemanticLegislationResult = hit;
    const score = h.score as number;
    const ref: unknown = h["asOfVersion"];
    out.push(h.law_id, String(score), String(ref), String(h.in_force));
  }

  const doc: Document = (await client.getDocument({ celexNumber: "32016R0679" })).document;
  const meta: DocumentMetadataResponse["metadata"] = (await client.getDocumentMetadata({ celexNumber: "32016R0679" })).metadata;
  out.push(doc.title ?? "", meta.celex ?? "");

  try {
    await client.getDocumentAtDate("32016R0679", "2019-06-01");
  } catch (err) {
    if (err instanceof NotFoundError && !err.unknownEndpoint) out.push(err.message, JSON.stringify(err.details));
  }
  return out;
}

// A stand-in written against 0.4.0: returns the 0.4.0 response shape.
export const fakeVersions: Pick<LexAPI, "getDocumentAtDate"> = {
  async getDocumentAtDate(celex: string, date: string) {
    const response: DocumentVersionResponse = {
      success: true,
      celex,
      language: "en",
      asOf: date,
      semantics: "",
      document: { version: 1, isCurrent: true, contentHash: "h", fetchedAt: "2026-01-10T08:00:00.000Z" },
    };
    return response;
  },
};

export const fixture: SemanticLegislationSearchResponse = {
  success: true,
  results: [{ law_id: "32016R0679", score: 0.8, asOfReason: "fetch_timeout" }],
};
