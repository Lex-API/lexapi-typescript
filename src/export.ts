import { LexAPIError } from "./errors.js";
import type { Language } from "./types.js";

// ── GET /export (NDJSON stream, BUSINESS / SCALE / ENTERPRISE) ───────

/** A list filter: an array, or a comma-separated string (`"regulation,directive"`). */
export type ExportListFilter = string | ReadonlyArray<string>;

export interface ExportParams {
  /** Document types (prose form as stored, e.g. `"Regulation"`), array or comma-separated. */
  documentType?: ExportListFilter;
  /** Authors, array or comma-separated. */
  author?: ExportListFilter;
  /** Subdomains (`legislation`, `case-law`, `treaties`, `preparatory`, `international`, `consolidated`, …). */
  subdomain?: ExportListFilter;
  /** Document language (default `en`). */
  language?: Language;
  /** Earliest `dateOfDocument` to include (inclusive, `YYYY-MM-DD`). */
  dateFrom?: string;
  /** Latest `dateOfDocument` to include (inclusive, `YYYY-MM-DD`). */
  dateTo?: string;
  /** Incremental sync: only rows whose `lastSeenAt` is at or after this ISO timestamp. */
  fetchedSince?: string;
  /** Include raw `htmlContent` / `htmlMetadata` per row (large). Default false. */
  includeHtml?: boolean;
  /** Set `false` to omit `parsedContent` from each row. Default true. */
  includeContent?: boolean;
  /**
   * Also stream metadata-only rows (documents whose text EUR-Lex does not
   * publish, or not yet). Default false — skipped rows are counted as
   * `skippedStubs` on the trailer.
   */
  includeStubs?: boolean;
  /** Max rows to stream. Clamped to the server's `EXPORT_MAX_ROWS` ceiling (default 50 000). */
  limit?: number;
}

/**
 * One corpus document line from the export stream. Explicit fields per the
 * spec's line-shape description; the index signature keeps future server
 * additions accessible without an SDK update.
 */
export interface ExportRow {
  celex?: string;
  language?: string;
  title?: string | null;
  documentType?: string | null;
  /** Stable enum slug alongside the prose `documentType`. */
  documentTypeCode?: string | null;
  author?: string | null;
  dateOfDocument?: string | null;
  dateOfEffect?: string | null;
  dateOfPublication?: string | null;
  dateOfDocumentISO?: string | null;
  dateOfEffectISO?: string | null;
  dateOfPublicationISO?: string | null;
  /** Recovered from `htmlMetadata` for case-law rows where the column is null. */
  ecli?: string | null;
  eli?: string | null;
  caseNumber?: string | null;
  parties?: string | null;
  keywords?: string[];
  subject?: string[];
  /** Monotonic corpus version for this CELEX. */
  version?: number;
  contentHash?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  fetchedAt?: string;
  source?: string;
  /** Present unless `includeContent: false`. */
  parsedContent?: Record<string, unknown> | null;
  /** Present only with `includeHtml: true`. */
  htmlContent?: string | null;
  htmlMetadata?: unknown;
  [key: string]: unknown;
}

/** Body of the leading `{"_meta": {...}}` line. */
export interface ExportMetaInfo {
  filters?: {
    documentType?: string[] | null;
    author?: string[] | null;
    subdomain?: string[] | null;
    language?: string;
    dateFrom?: string | null;
    dateTo?: string | null;
    fetchedSince?: string | null;
  };
  /** Rows matching the filters (same as `X-Export-Total`). */
  totalMatching?: number;
  /** Rows the server will stream (min of total and limit). */
  streaming?: number;
  truncated?: boolean;
  includeHtml?: boolean;
  includeContent?: boolean;
  exportedAt?: string;
  [key: string]: unknown;
}

/**
 * The leading `_meta` envelope line. The server nests everything under
 * `_meta`; the SDK also lifts those fields to the top level for convenience
 * (`stream.meta.totalMatching`).
 */
export interface ExportMeta extends ExportMetaInfo {
  _meta?: ExportMetaInfo | unknown;
}

/** Body of the trailing `{"_done": {...}}` line. */
export interface ExportDoneInfo {
  /** Rows actually written. */
  written?: number;
  /** `true` when the row cap was hit — narrow the filters or resume via `fetchedSince`. */
  truncated?: boolean;
  /** Metadata-only rows skipped because `includeStubs` was off. */
  skippedStubs?: number;
  [key: string]: unknown;
}

/**
 * The trailing `_done` line. The server nests the fields under `_done`; the
 * SDK lifts them to the top level so `stream.done?.truncated` works.
 */
export interface ExportDone extends ExportDoneInfo {
  _done?: ExportDoneInfo | unknown;
}

/** Signals lifted from the `X-Export-*` response headers. */
export interface ExportHeaderInfo {
  /** Total rows matching the filters in the database (`X-Export-Total`). */
  total: number | undefined;
  /**
   * Rows the server set out to stream — min of total and limit
   * (`X-Export-Streaming`). Rows written can be lower by `done.skippedStubs`.
   */
  streaming: number | undefined;
  /** `true` when the row cap was hit (`X-Export-Truncated: 1`). */
  truncated: boolean | undefined;
}

/**
 * Single-pass async iterator over export rows.
 *
 * - `meta` is parsed from the leading `_meta` line and available
 *   immediately (before iterating).
 * - `done` is populated from the trailing `_done` line once iteration
 *   completes; check `done.truncated` (or `headers.truncated`) to detect
 *   the row cap — do not assume the stream was complete.
 * - `_meta`/`_done` lines are never yielded as rows.
 */
export interface ExportStream extends AsyncIterable<ExportRow> {
  readonly meta: ExportMeta | undefined;
  readonly done: ExportDone | undefined;
  readonly headers: ExportHeaderInfo;
  /**
   * Abandon the export and release the connection (e.g. after inspecting
   * `meta` without iterating). Breaking out of `for await` does this too.
   */
  cancel(): Promise<void>;
}

/** Split a fetch body ReadableStream into trimmed, non-empty NDJSON lines. */
async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    // Consumer stopped early (break / throw): cancel the body so the
    // connection is released instead of streaming the rest of the export.
    // Not awaited — a tee'd (cloned) body only settles cancel() once every
    // branch is cancelled, which must not block the consumer.
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Lift the nested `_meta` / `_done` object's fields to the top level (keeping the raw key). */
function liftEnvelope<T>(parsed: Record<string, unknown>, key: "_meta" | "_done"): T {
  const inner = parsed[key];
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    return { ...(inner as Record<string, unknown>), ...parsed } as T;
  }
  return parsed as T;
}

function parseLine(line: string): Record<string, unknown> {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch (cause) {
    throw new LexAPIError(
      "INTERNAL",
      `Malformed NDJSON line in export stream: ${line.slice(0, 120)}`,
      0,
      cause,
    );
  }
}

class ExportStreamImpl implements ExportStream {
  meta: ExportMeta | undefined;
  done: ExportDone | undefined;
  readonly headers: ExportHeaderInfo;

  private readonly lines: AsyncGenerator<string, void>;
  private pendingFirstRow: ExportRow | undefined;
  private consumed = false;

  constructor(lines: AsyncGenerator<string, void>, headers: ExportHeaderInfo) {
    this.lines = lines;
    this.headers = headers;
  }

  async cancel(): Promise<void> {
    this.consumed = true;
    await this.lines.return(undefined);
  }

  /** Read the leading line so `meta` is available before iteration starts. */
  async init(): Promise<void> {
    const first = await this.lines.next();
    if (first.done) return;
    const parsed = parseLine(first.value);
    if ("_meta" in parsed) {
      this.meta = liftEnvelope<ExportMeta>(parsed, "_meta");
    } else if ("_done" in parsed) {
      this.done = liftEnvelope<ExportDone>(parsed, "_done");
    } else {
      // Defensive: no _meta envelope — treat the line as the first row.
      this.pendingFirstRow = parsed as ExportRow;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ExportRow, void> {
    if (this.consumed) {
      throw new LexAPIError("INTERNAL", "Export stream already consumed (single-pass)", 0);
    }
    this.consumed = true;
    if (this.pendingFirstRow !== undefined) {
      yield this.pendingFirstRow;
      this.pendingFirstRow = undefined;
    }
    try {
      if (this.done !== undefined) return; // _done arrived first (empty export)
      for (;;) {
        const next = await this.lines.next();
        if (next.done) return;
        const parsed = parseLine(next.value);
        if ("_done" in parsed) {
          this.done = liftEnvelope<ExportDone>(parsed, "_done");
          return;
        }
        if ("_meta" in parsed) continue; // never surface envelope lines as rows
        yield parsed as ExportRow;
      }
    } finally {
      // Runs on normal completion AND on early exit — releases the body.
      await this.lines.return(undefined);
    }
  }
}

/** Build an `ExportStream` from a raw `/export` fetch response. */
export async function createExportStream(response: Response): Promise<ExportStream> {
  if (response.body === null) {
    throw new LexAPIError("INTERNAL", "Export response had no body stream", response.status);
  }
  const totalHeader = response.headers.get("x-export-total");
  const streamingHeader = response.headers.get("x-export-streaming");
  const truncatedHeader = response.headers.get("x-export-truncated");
  const stream = new ExportStreamImpl(ndjsonLines(response.body), {
    total: totalHeader !== null ? Number(totalHeader) : undefined,
    streaming: streamingHeader !== null ? Number(streamingHeader) : undefined,
    truncated: truncatedHeader !== null ? truncatedHeader === "1" : undefined,
  });
  await stream.init();
  return stream;
}
