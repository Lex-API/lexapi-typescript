import {
  LexAPIError,
  NetworkError,
  RequestAbortedError,
  IncompleteExportError,
  TimeoutError,
} from "./errors.js";
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
  /** Exactly `false` marks an incomplete export (SDK contract §1.8); absent or `true` = complete. */
  complete?: boolean;
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
 *   completes; check `stream.truncated` (it resolves the header, `_meta`
 *   and `_done` signals per SDK contract §1.8) to detect the row cap.
 * - If the body ends WITHOUT the `_done` trailer (the server stopped
 *   mid-export), iteration throws `IncompleteExportError` after yielding the
 *   rows that did arrive (`complete` stays `false`); a dropped connection
 *   throws `NetworkError` (`CONNECTION_ERROR`); no data for `timeoutMs`
 *   throws `TimeoutError` (`REQUEST_TIMEOUT`); the call's `signal` throws
 *   `RequestAbortedError`. In every case the connection is released.
 * - A `_done` line with `complete: false`, or any line whose only key is
 *   `_error`, also means incomplete: iteration throws `IncompleteExportError`
 *   after the rows that did arrive (the `_error` body is on its `details` and
 *   on `stream.error`). Unknown `_done` fields (`truncatedBy`, `credits`) are
 *   kept on `done`.
 * - Lines that are not JSON objects are counted in `invalidLines`, not yielded.
 * - `_meta`/`_done`/`_error` lines are never yielded as rows.
 */
export interface ExportStream extends AsyncIterable<ExportRow> {
  readonly meta: ExportMeta | undefined;
  readonly done: ExportDone | undefined;
  readonly headers: ExportHeaderInfo;
  /**
   * `true` once a `_done` trailer was read that does not say
   * `complete: false`, and no `_error` line arrived — only then is the export
   * whole (SDK contract §1.8).
   */
  readonly complete: boolean;
  /** The server's `_error` line body, if one arrived (never yielded as a row). */
  readonly error: Record<string, unknown> | undefined;
  /** Data rows yielded so far. */
  readonly rowsRead: number;
  /** Lines that were not JSON objects (e.g. a half-written last line) — counted, not yielded. */
  readonly invalidLines: number;
  /**
   * Whether the server's row cap was hit, resolved per SDK contract §1.8:
   * the `X-Export-Truncated` header (cap-only) first, then `_meta.truncated`,
   * then `_done.truncated` discounted by `skippedStubs` (the server sets that
   * flag to `written < total`, and `total` includes metadata-only rows that
   * `includeStubs=false` skips). `undefined` when unknown.
   */
  readonly truncated: boolean | undefined;
  /**
   * Abandon the export and release the connection (e.g. after inspecting
   * `meta` without iterating). Breaking out of `for await` does this too.
   */
  cancel(): Promise<void>;
}

/** Options for reading an export body. */
export interface ExportStreamOptions {
  /** Abort a read that receives no bytes for this long (ms). Default: the client timeout. */
  idleTimeoutMs?: number;
  /** Caller cancellation (aborts the read and releases the connection). */
  signal?: AbortSignal;
}

/**
 * Pull-based NDJSON line reader over a fetch body. Every read has an idle
 * timeout and honours the caller's signal; any failure cancels the body so
 * the connection is released. Each decoded chunk is scanned once and partial
 * lines are kept as pieces (joined once, when the line completes), so a
 * multi-megabyte line (`includeHtml`) costs O(n), not O(n²).
 */
class NdjsonReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  /** Pieces of the line currently being received. */
  private partial: string[] = [];
  /** Complete lines not yet handed out. */
  private readonly ready: string[] = [];
  private eof = false;
  private released = false;
  /** Data rows handed out so far (for error messages). */
  rows = 0;

  /** Releases the connection the moment the caller aborts — even while nobody is reading. */
  private readonly onAbort = (): void => this.cancel();

  constructor(
    body: ReadableStream<Uint8Array>,
    private readonly options: ExportStreamOptions,
  ) {
    this.reader = body.getReader();
    const { signal } = options;
    if (signal?.aborted) this.cancel();
    else signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Next trimmed, non-empty line, or `undefined` at EOF. */
  async nextLine(): Promise<string | undefined> {
    const { signal } = this.options;
    if (signal?.aborted) {
      this.cancel();
      throw new RequestAbortedError("Export stream was aborted", signal.reason);
    }
    for (;;) {
      const line = this.ready.shift();
      if (line !== undefined) return line;
      if (this.eof) {
        const tail = this.partial.join("").trim();
        this.partial = [];
        return tail || undefined;
      }
      const chunk = await this.read();
      if (chunk === undefined) {
        this.eof = true;
        this.ingest(this.decoder.decode());
        this.release();
      } else {
        this.ingest(this.decoder.decode(chunk, { stream: true }));
      }
    }
  }

  private ingest(text: string): void {
    let pos = 0;
    for (;;) {
      const newline = text.indexOf("\n", pos);
      if (newline === -1) break;
      this.partial.push(text.slice(pos, newline));
      const line = this.partial.join("").trim();
      this.partial = [];
      if (line) this.ready.push(line);
      pos = newline + 1;
    }
    if (pos < text.length) this.partial.push(text.slice(pos));
  }

  private async read(): Promise<Uint8Array | undefined> {
    const { idleTimeoutMs, signal } = this.options;
    if (signal?.aborted) {
      this.cancel();
      throw new RequestAbortedError("Export stream was aborted", signal.reason);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interruptions = new Promise<never>((_, reject) => {
      if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
        timer = setTimeout(() => {
          reject(
            new TimeoutError(`Export stream received no data for ${idleTimeoutMs}ms (after ${this.rows} rows)`, 0),
          );
        }, idleTimeoutMs);
      }
      if (signal) {
        onAbort = () => reject(new RequestAbortedError("Export stream was aborted", signal.reason));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      const result = await Promise.race([this.reader.read(), interruptions]);
      // The abort listener cancels the body, which can settle the pending
      // read as "done" before the rejection above wins the race.
      if (signal?.aborted) throw new RequestAbortedError("Export stream was aborted", signal.reason);
      return result.done ? undefined : result.value;
    } catch (cause) {
      this.cancel();
      if (cause instanceof LexAPIError) throw cause;
      throw new NetworkError(`Export stream interrupted after ${this.rows} rows`, cause);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Cancel the body immediately (even while a read is pending) and release
   * the connection. Not awaited: a tee'd (cloned) body only settles
   * `cancel()` once every branch is cancelled.
   */
  cancel(): void {
    if (this.released) return;
    this.eof = true;
    void this.reader.cancel().catch(() => undefined);
    this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.options.signal?.removeEventListener("abort", this.onAbort);
    try {
      this.reader.releaseLock();
    } catch {
      // a pending read keeps the lock until cancel() settles it — harmless
    }
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

/** A line whose only key is `_error`: a server failure signal, never a row. */
function errorLine(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "_error") return undefined;
  const value = parsed._error;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { message: String(value) };
}

/** Parse one NDJSON line; `undefined` when it is not a JSON object. */
function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

class ExportStreamImpl implements ExportStream {
  meta: ExportMeta | undefined;
  done: ExportDone | undefined;
  error: Record<string, unknown> | undefined;
  readonly headers: ExportHeaderInfo;

  private readonly lines: NdjsonReader;
  private pendingFirstRow: ExportRow | undefined;
  private consumed = false;
  invalidLines = 0;

  get complete(): boolean {
    return this.done !== undefined && this.done.complete !== false && this.error === undefined;
  }

  private incomplete(reason: string): IncompleteExportError {
    return new IncompleteExportError(
      `Export stream is incomplete after ${this.lines.rows} rows: ${reason}`,
      this.lines.rows,
      this.error,
    );
  }

  private failureReason(): string {
    if (this.error !== undefined) {
      return `the server reported an error mid-stream (${String(this.error.code ?? "UNKNOWN")}: ${String(this.error.message ?? "")})`;
    }
    return "its _done trailer says complete: false";
  }

  get rowsRead(): number {
    return this.lines.rows;
  }

  get truncated(): boolean | undefined {
    if (this.headers.truncated !== undefined) return this.headers.truncated;
    if (typeof this.meta?.truncated === "boolean") return this.meta.truncated;
    const done = this.done;
    if (done === undefined || typeof done.truncated !== "boolean") return undefined;
    if (!done.truncated) return false;
    const skipped = typeof done.skippedStubs === "number" ? done.skippedStubs : 0;
    if (skipped === 0) return true;
    const total = this.meta?.totalMatching;
    const written = typeof done.written === "number" ? done.written : undefined;
    if (typeof total === "number" && written !== undefined) return written + skipped < total;
    return undefined; // can't tell a real cap from skipped stubs
  }

  constructor(lines: NdjsonReader, headers: ExportHeaderInfo) {
    this.lines = lines;
    this.headers = headers;
  }

  async cancel(): Promise<void> {
    this.consumed = true;
    this.lines.cancel();
  }

  /** Read the leading line so `meta` is available before iteration starts. */
  async init(): Promise<void> {
    let parsed: Record<string, unknown> | undefined;
    for (;;) {
      const first = await this.lines.nextLine();
      if (first === undefined) return;
      parsed = parseLine(first);
      if (parsed !== undefined) {
        const error = errorLine(parsed);
        if (error === undefined) break;
        this.error = error; // never a row; iteration reports it
        continue;
      }
      this.invalidLines++;
    }
    if ("_meta" in parsed) {
      this.meta = liftEnvelope<ExportMeta>(parsed, "_meta");
    } else if ("_done" in parsed) {
      this.done = liftEnvelope<ExportDone>(parsed, "_done");
      this.lines.cancel();
    } else {
      // Defensive: no _meta envelope — treat the line as the first row.
      this.pendingFirstRow = parsed as ExportRow;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ExportRow, void> {
    if (this.consumed) {
      // SDK contract §1.8: a stream is read once. Re-iterating one that was
      // read to its `_done` yields nothing; one that was ended early
      // (cancel(), break, an error) never looks complete.
      if (this.complete) return;
      if (this.done !== undefined || this.error !== undefined) throw this.incomplete(this.failureReason());
      throw new IncompleteExportError(
        `Export stream was ended before its _done trailer (after ${this.lines.rows} rows) — call export() again to re-read`,
        this.lines.rows,
      );
    }
    this.consumed = true;
    try {
      if (this.pendingFirstRow !== undefined) {
        const row = this.pendingFirstRow;
        this.pendingFirstRow = undefined;
        this.lines.rows++;
        yield row;
      }
      if (this.done !== undefined) {
        // _done arrived first (empty export)
        if (!this.complete) throw this.incomplete(this.failureReason());
        return;
      }
      for (;;) {
        const line = await this.lines.nextLine();
        if (line === undefined) {
          // Clean EOF without the trailer: the server stopped mid-export.
          if (this.error !== undefined) throw this.incomplete(this.failureReason());
          throw new IncompleteExportError(
            `Export stream ended without its _done trailer after ${this.lines.rows} rows — the export is incomplete`,
            this.lines.rows,
          );
        }
        const parsed = parseLine(line);
        if (parsed === undefined) {
          this.invalidLines++;
          continue;
        }
        if ("_done" in parsed) {
          this.done = liftEnvelope<ExportDone>(parsed, "_done");
          if (!this.complete) throw this.incomplete(this.failureReason());
          return;
        }
        if ("_meta" in parsed) continue; // never surface envelope lines as rows
        const error = errorLine(parsed);
        if (error !== undefined) {
          this.error = error; // a failure signal, never a row
          continue;
        }
        this.lines.rows++;
        yield parsed as ExportRow;
      }
    } finally {
      // Runs on normal completion, errors AND early exit — releases the body.
      this.lines.cancel();
    }
  }
}

/** Build an `ExportStream` from a raw `/export` fetch response. */
export async function createExportStream(
  response: Response,
  options: ExportStreamOptions = {},
): Promise<ExportStream> {
  if (response.body === null) {
    throw new LexAPIError("INTERNAL", "Export response had no body stream", response.status);
  }
  const totalHeader = response.headers.get("x-export-total");
  const streamingHeader = response.headers.get("x-export-streaming");
  const truncatedHeader = response.headers.get("x-export-truncated");
  const stream = new ExportStreamImpl(new NdjsonReader(response.body, options), {
    total: totalHeader !== null ? Number(totalHeader) : undefined,
    streaming: streamingHeader !== null ? Number(streamingHeader) : undefined,
    truncated: truncatedHeader !== null ? truncatedHeader === "1" : undefined,
  });
  await stream.init();
  return stream;
}
