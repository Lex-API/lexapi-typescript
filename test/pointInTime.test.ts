import { describe, expect, it, vi } from "vitest";

import { LexAPI, NotFoundError } from "../src/index.js";
import { FAST_RETRY, fetchSequence, jsonResponse } from "./helpers.js";

function client(fetchMock: typeof fetch) {
  return new LexAPI({ apiKey: "lex_test_key", fetch: fetchMock, retry: FAST_RETRY });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit];
}

const VERSIONS_BODY = {
  success: true,
  celex: "32016R0679",
  language: "en",
  currentVersion: 3,
  trackedSince: "2026-01-10T08:00:00.000Z",
  semantics: "Versions are LexAPI observation snapshots…",
  versions: [
    {
      version: 3,
      isCurrent: true,
      contentHash: "hash-v3",
      fetchedAt: "2026-06-01T09:00:00.000Z",
      title: "GDPR (v3)",
      documentType: "Regulation",
      documentTypeCode: "regulation",
    },
    {
      version: 2,
      isCurrent: false,
      contentHash: "hash-v2",
      fetchedAt: "2026-03-15T08:00:00.000Z",
      title: "GDPR (v2)",
      documentType: "Regulation",
      documentTypeCode: "regulation",
    },
  ],
};

const SNAPSHOT_BODY = {
  success: true,
  celex: "32016R0679",
  language: "en",
  semantics: "Versions are LexAPI observation snapshots…",
  document: {
    version: 2,
    isCurrent: false,
    contentHash: "hash-v2",
    fetchedAt: "2026-03-15T08:00:00.000Z",
    title: "GDPR (v2)",
    documentType: "Regulation",
    documentTypeCode: "regulation",
    parsedContent: { articles: [{ number: "1", text: "v2 text" }] },
  },
};

describe("listDocumentVersions", () => {
  it("GETs the versions path and returns the typed history", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, VERSIONS_BODY));

    const result = await client(fetchMock).listDocumentVersions("32016R0679", {
      language: "en",
    });

    const [url] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/documents/32016R0679/versions?language=en");
    expect(result.currentVersion).toBe(3);
    expect(result.trackedSince).toBe("2026-01-10T08:00:00.000Z");
    expect(result.semantics).toContain("observation snapshots");
    expect(result.versions.map((v) => v.version)).toEqual([3, 2]);
    expect(result.versions[0]?.isCurrent).toBe(true);
    // History listings carry no content.
    expect(result.versions[0]?.parsedContent).toBeUndefined();
  });

  it("omits the language query param when not given", async () => {
    const fetchMock = fetchSequence(jsonResponse(200, VERSIONS_BODY));
    await client(fetchMock).listDocumentVersions("32016R0679");
    const [url] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/documents/32016R0679/versions");
  });
});

describe("getDocumentVersion", () => {
  it("returns the snapshot with content and mirrors X-Corpus-Version", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, SNAPSHOT_BODY, { "x-corpus-version": "2" }),
    );

    const result = await client(fetchMock).getDocumentVersion("32016R0679", 2);

    const [url] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/documents/32016R0679/versions/2");
    expect(result.document.version).toBe(2);
    expect(result.document.isCurrent).toBe(false);
    expect(result.document.parsedContent).toEqual({
      articles: [{ number: "1", text: "v2 text" }],
    });
    expect(result.corpusVersion).toBe(2);
    expect(result.asOf).toBeUndefined();
  });
});

describe("getDocumentAtDate", () => {
  it("resolves the as-of snapshot", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { ...SNAPSHOT_BODY, asOf: "2026-03-20" }),
    );

    const result = await client(fetchMock).getDocumentAtDate("32016R0679", "2026-03-20");

    const [url] = lastCall(fetchMock);
    expect(url).toBe("https://lex-api.com/api/v1/documents/32016R0679/at/2026-03-20");
    expect(result.asOf).toBe("2026-03-20");
    expect(result.document.version).toBe(2);
  });

  it("maps the pre-ingestion 404 to NotFoundError with the tracking start date", async () => {
    const fetchMock = fetchSequence(
      jsonResponse(404, {
        success: false,
        error: {
          code: "NOT_FOUND",
          message:
            "32016R0679 (en) was not yet in the corpus on 2025-12-31 — tracking began 2026-01-10.",
        },
      }),
    );

    await expect(
      client(fetchMock).getDocumentAtDate("32016R0679", "2025-12-31"),
    ).rejects.toThrowError(NotFoundError);
  });
});
