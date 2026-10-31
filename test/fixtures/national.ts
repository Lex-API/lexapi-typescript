/**
 * National-law fixtures in the API 2.8.0 shape (`NationalDocument` /
 * `NationalDocumentSummary` / `NationalDecision` / `NationalDocumentContent` /
 * `NationalArticle`): every documented field always present, `null` / `[]`
 * when the source has nothing; source extras only under
 * `content.details` / `articles[].details`.
 */
import type {
  NationalDocument,
  NationalDocumentSummary,
  NationalSemanticCaseLawResult,
  NationalSemanticLegislationResult,
} from "../../src/index.js";

export const AT_ATTRIBUTION =
  "Data source: RIS, Bundeskanzleramt Österreich (data.bka.gv.at), CC BY 4.0. Consolidated texts are not legally authentic — only the Bundesgesetzblatt is.";

/** A listing row (act) — override any field. */
export function summary(overrides: Partial<NationalDocumentSummary> = {}): NationalDocumentSummary {
  return {
    id: "AT-NOR-10001597",
    jurisdiction: "AT",
    language: "de",
    documentKind: "act",
    title: "Datenschutzgesetz",
    documentType: "Bundesgesetz (konsolidiert)",
    ecli: null,
    eli: "https://www.ris.bka.gv.at/eli/bgbl/i/1999/165",
    dateOfDocument: null,
    version: 3,
    fetchedAt: "2026-11-02T22:10:00.000Z",
    validTo: null,
    inForce: null,
    ...overrides,
  };
}

/** `GET /at/documents/AT-NOR-10001597` — an act. */
export const AT_ACT: NationalDocument = {
  ...summary(),
  decision: null,
  content: {
    fullText: "§ 1. (1) Jedermann hat …",
    articles: [
      {
        number: "§ 1",
        title: "Grundrecht auf Datenschutz",
        section: null,
        text: "(1) Jedermann hat …",
        inForceFrom: "2018-05-25",
        inForceTo: null,
        details: { norId: "NOR40198753" },
      },
      {
        number: "Anl. 1",
        title: null,
        section: null,
        // The source publishes no text for this unit — never an empty provision.
        text: null,
        inForceFrom: null,
        inForceTo: null,
        details: { norId: "NOR40198999", noHtmlRendition: true },
      },
    ],
    textLanguages: ["de"],
    textLanguage: null,
    embeddedForeignText: false,
    repeal: null,
    source: { system: "RIS", gesetzesnummer: "10001597" },
    details: { kundmachungsorgan: "BGBl. I Nr. 165/1999" },
  },
  textAvailability: { available: true },
  attribution: AT_ATTRIBUTION,
  textBasis: null,
};

/** `GET /de/documents/DE-JUD-BFH-…` — a decision: court/caseNumbers/citedNorms normalized under `decision`. */
export const DE_DECISION: NationalDocument = {
  ...summary({
    id: "DE-JUD-BFH-KBRE202550123",
    jurisdiction: "DE",
    documentKind: "decision",
    title: "Kindergeld: Berücksichtigung eines volljährigen Kindes",
    documentType: "Urteil",
    ecli: "ECLI:DE:BFH:2025:U.120625.IIIR27.24.0",
    eli: null,
    dateOfDocument: "2025-06-12",
    version: 1,
  }),
  decision: {
    court: "BFH 3. Senat",
    chamber: null,
    caseNumbers: ["III R 27/24"],
    citedNorms: [{ text: "§ 62 Abs 1a S 3 EStG 2009", documentId: null }],
  },
  content: {
    fullText: "Tenor … Tatbestand … Entscheidungsgründe …",
    articles: [],
    textLanguages: ["de"],
    textLanguage: null,
    embeddedForeignText: false,
    repeal: null,
    source: { system: "rechtsprechung-im-internet.de", docId: "KBRE202550123" },
    // The source's own field names stay here, unchanged — read `decision` instead.
    details: { gericht: "BFH 3. Senat", aktenzeichen: "III R 27/24", normen: ["§ 62 Abs 1a S 3 EStG 2009"] },
  },
  textAvailability: { available: true },
  attribution: "Source: rechtsprechung-im-internet.de (BMJ).",
  textBasis: null,
};

/** A case-law semantic hit carrying the per-hit `document` summary. */
export const AT_CASE_LAW_HIT: NationalSemanticCaseLawResult = {
  score: 0.81,
  snippet: "…",
  case_number: "6 Ob 123/24x",
  metadata: { celex_id: "AT-JUD-JJT_20250115_OGH0002_0060OB00123_24X0000_000" },
  documentId: "AT-JUD-JJT_20250115_OGH0002_0060OB00123_24X0000_000",
  jurisdiction: "AT",
  document: summary({
    id: "AT-JUD-JJT_20250115_OGH0002_0060OB00123_24X0000_000",
    documentKind: "decision",
    title: null,
    documentType: "Entscheidungstext (Justiz)",
    ecli: "ECLI:AT:OGH0002:2025:0060OB00123.24X.0115.000",
    eli: null,
    dateOfDocument: "2025-01-15",
    version: 1,
  }),
  attribution: "Data source: RIS.",
};

/** A legislation semantic hit — index fields null-filled, `document` attached. */
export const DE_LEGISLATION_HIT: NationalSemanticLegislationResult = {
  score: 0.77,
  snippet: "…",
  law_id: "DE-BJNR001950896",
  documentId: "DE-BJNR001950896",
  jurisdiction: "DE",
  law_title: "Bürgerliches Gesetzbuch",
  article_ref: "§ 622",
  section: null,
  language: "de",
  in_force: false,
  valid_from: null,
  valid_to: "2020-01-01",
  law_type: null,
  document: summary({
    id: "DE-BJNR001950896",
    jurisdiction: "DE",
    title: "Bürgerliches Gesetzbuch",
    documentType: "Gesetz",
    eli: null,
    validTo: "2020-01-01",
    inForce: false,
  }),
  attribution: "Source: gesetze-im-internet.de.",
};
