import { LexAPIError } from "./errors.js";
import type { Language } from "./types.js";

// ── GET /export (NDJSON stream, BUSINESS tier) ──────────────────────

export interface ExportParams {
  /** Comma-separated document types, e.g. `"regulation,directive"`. */
  documentType?: string;
  /** Comma-separated list of authors. */
  author?: string;
  /** Comma-separated subdomains (`legislation`, `case-law`, `treaties`, ...). */
  subdomain?: string;
  /** Document language (default `en`). */
  language?: Language;
  /** Earliest `dateOfDocument` to include (inclusive, `YYYY-MM-DD`). */
  dateFrom?: string;
  /** Latest `dateOfDocument` to include (inclusive, `YYYY-MM-DD`). */
  dateTo?: string;
  /** Only stream rows whose `lastSeenAt` is at or after this ISO timestamp. */
  fetchedSince?: string;
  /** Include raw `htmlContent` / `htmlMetadata` per row (large). Default false. */
  includeHtml?: boolean;
  /** Set `false` to omit `parsedContent` from each row. Default true. */
  includeContent?: boolean;
  /** Max rows to stream. Clamped to the server's `EXPORT_MAX_ROWS` ceiling. */
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

/**
 * The leading `_meta` envelope line. The spec does not pin its shape, so
 * beyond the `_meta` marker everything is kept as-is.
 */
export interface ExportMeta {
  _meta?: unknown;
  [key: string]: unknown;
}

/** The trailing `_done` line. Reports `truncated: true` when the row cap was hit. */
export interface ExportDone {
  _done?: unknown;
  truncated?: boolean;
  [key: string]: unknown;
}

/** Signals lifted from the `X-Export-*` response headers. */
export interface ExportHeaderInfo {
  /** Total rows matching the filters in the database (`X-Export-Total`). */
  total: number | undefined;
  /** Rows actually streamed — min of total and limit (`X-Export-Streaming`). */
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
}

/** Split a fetch body ReadableStream into trimmed, non-empty NDJSON lines. */
async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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
    reader.releaseLock();
  }
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

  /** Read the leading line so `meta` is available before iteration starts. */
  async init(): Promise<void> {
    const first = await this.lines.next();
    if (first.done) return;
    const parsed = parseLine(first.value);
    if ("_meta" in parsed) {
      this.meta = parsed as ExportMeta;
    } else if ("_done" in parsed) {
      this.done = parsed as ExportDone;
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
    if (this.done !== undefined) return; // _done arrived first (empty export)
    for (;;) {
      const next = await this.lines.next();
      if (next.done) return;
      const parsed = parseLine(next.value);
      if ("_done" in parsed) {
        this.done = parsed as ExportDone;
        return;
      }
      if ("_meta" in parsed) continue; // never surface envelope lines as rows
      yield parsed as ExportRow;
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
