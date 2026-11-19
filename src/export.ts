import {
  LexAPIError,
  NetworkError,
  RequestAbortedError,
  IncompleteExportError,
  TimeoutError,
} from "./errors.js";
import { parseHeaderInteger } from "./headers.js";
import { timerDelay } from "./retryHints.js";
import type { Language } from "./types.js";

// ── GET /export (NDJSON stream, BUSINESS / SCALE / ENTERPRISE) ───────

/** A list filter: an array, or a comma-separated string (`"regulation,directive"`). */
export type ExportListFilter = string | ReadonlyArray<string>;

/**
 * Filters for `GET /export` (API 2.3.0). List values are sent
 * comma-separated and ORed.
 */
export interface ExportParams {
  /**
   * Document types: the stored label, matched exactly ignoring case
   * (`"regulation"` matches `Regulation`, not `Implementing regulation`).
   * For a whole family use `documentTypeCode`.
   */
  documentType?: ExportListFilter;
  /**
   * Type families by the `documentTypeCode` each row carries: `"regulation"`
   * includes implementing and delegated regulations. Combined with
   * `documentType`, both must match.
   */
  documentTypeCode?: ExportListFilter;
  /** Authors: whole stored values, ignoring case (a joint act's author string is one value). */
  author?: ExportListFilter;
  /** Subdomains (`legislation`, `case-law`, `treaties`, `preparatory`, `international`, `consolidated`, …). */
  subdomain?: ExportListFilter;
  /** Document language (default `en`). */
  language?: Language;
  /** Earliest document date to include (inclusive, `YYYY-MM-DD`; anything else is a 400). */
  dateFrom?: string;
  /** Latest document date to include (inclusive, `YYYY-MM-DD`). */
  dateTo?: string;
  /**
   * Rows whose `lastSeenAt` is at or after this time (any write to the row).
   * An ISO 8601 date or a date-time WITH a timezone (the API answers 400 to
   * one without), or a `Date` (sent as UTC).
   */
  fetchedSince?: string | Date;
  /**
   * Rows whose text changed (`contentChangedAt`) at or after this time — the
   * cheapest incremental sync. Same format as `fetchedSince`.
   */
  changedSince?: string | Date;
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
  /**
   * Max rows to stream: a positive integer (anything else throws a
   * `RangeError` before the request — the API answers 400). Clamped to the
   * server's row ceiling (50,000).
   */
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
  /**
   * `true` when matching rows remain that the export did not reach (API
   * 2.3.0: authoritative, see `truncatedBy`) — narrow the filters or resume
   * via `changedSince` / `fetchedSince`.
   */
  truncated?: boolean;
  /** Metadata-only rows skipped because `includeStubs` was off. */
  skippedStubs?: number;
  /** Exactly `false` marks an incomplete export (SDK contract §1.8); absent or `true` = complete. */
  complete?: boolean;
  /**
   * API 2.3.0: what cut the export short — `limit`, `max_rows`, `recovered`
   * (the server's recovery sweep took the export's billing record mid-stream), `credits`
   * (the pool could not pay for rows added since the count), or `null`.
   */
  truncatedBy?: "limit" | "max_rows" | "credits" | "recovered" | null;
  /**
   * API 2.3.0, credit plans: the pool after settlement, plus `reserved`,
   * `charged` (max(written, 1)) and `refunded`; `refundPending: true` when
   * the refund is applied later by the server's recovery sweep.
   */
  credits?: {
    reserved?: number;
    charged?: number;
    refunded?: number;
    refundPending?: boolean;
    remaining?: number;
    [key: string]: unknown;
  };
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
  /**
   * `X-Export-Truncated: 1` — the up-front count exceeded the row cap. A hint
   * only; `stream.truncated` prefers `_done.truncated` once it is read.
   */
  truncated: boolean | undefined;
}

/**
 * Single-pass async iterator over export rows.
 *
 * - `meta` is parsed from the leading `_meta` line and available
 *   immediately (before iterating).
 * - `done` is populated from the trailing `_done` line once iteration
 *   completes; check `stream.truncated` (`_done.truncated` once read,
 *   else the header / `_meta` hints — SDK contract §1.8) to detect rows the
 *   export did not reach.
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
 * - A line ends at a line feed byte only. Lines are read as strict UTF-8,
 *   whatever charset the response names (one byte order mark at the very
 *   start of the stream is ignored), with spaces, tabs and carriage returns
 *   trimmed; blank lines are skipped. Lines that are not UTF-8, or not one
 *   JSON object, are counted in `invalidLines`, not yielded.
 * - `_meta`/`_done`/`_error` lines are never yielded as rows; `meta` comes
 *   only from the very first line of the stream.
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
   * Whether matching rows remain that this export did not reach, per SDK
   * contract §1.8: `_done.truncated` once the trailer has been read (API
   * 2.3.0: authoritative — set by `limit`, the server maximum or the credit
   * pool, see `done.truncatedBy`; never derived from the count; skipped stubs
   * do not count). Before the trailer: the `X-Export-Truncated` header, then
   * `_meta.truncated` — hints from the up-front count, which may be cached
   * for up to a minute and never caps the stream. `false` when none of
   * these says.
   */
  readonly truncated: boolean;
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

/** A line whose bytes are not UTF-8: an invalid line. */
const INVALID_LINE = Symbol("invalid line");
type Line = string | typeof INVALID_LINE;

const NO_BYTES = new Uint8Array(0);

/**
 * The bytes a streaming decoder holds after `previous` (what it held before)
 * and then `chunk` were decoded without an error: the start of a character
 * not yet complete, at most three bytes, copied.
 */
function heldBytes(previous: Uint8Array, chunk: Uint8Array): Uint8Array {
  const n = chunk.length;
  if (n > 0 && chunk[n - 1]! < 0x80) return NO_BYTES;
  const tail = n >= 3 ? chunk.subarray(n - 3) : new Uint8Array([...previous, ...chunk].slice(-3));
  for (let k = 1; k <= tail.length; k++) {
    const byte = tail[tail.length - k]!;
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte
    const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return size > k ? tail.slice(tail.length - k) : NO_BYTES;
  }
  return NO_BYTES;
}

function strictDecoder(): TextDecoder {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
}

/** A chunk as a byte view, or `undefined` when it is not bytes. */
function byteView(chunk: unknown): Uint8Array | undefined {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return undefined;
}

/** Remove leading and trailing spaces, tabs and carriage returns, and nothing else (SDK contract §1.8). */
function trimLine(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && isLineSpace(line.charCodeAt(start))) start++;
  while (end > start && isLineSpace(line.charCodeAt(end - 1))) end--;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

function isLineSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d;
}

/**
 * Pull-based NDJSON line reader over a fetch body. Every read has an idle
 * timeout and honours the caller's signal; any failure cancels the body so
 * the connection is released.
 *
 * A line ends at a line feed byte and nowhere else. Lines are strict UTF-8,
 * whatever charset the response names; a line that is not is an invalid line
 * and does not affect the next one (a line feed byte never occurs inside a
 * multi-byte sequence). One streaming decoder reads every byte once: each
 * chunk's complete lines are decoded in one call and split on "\n" (only when
 * that call fails are they decoded one by one, to find the invalid ones); the
 * line still in progress is kept as text pieces and joined once, so a
 * multi-megabyte line (`includeHtml`) costs O(n). No byte of a chunk is kept
 * after the chunk is processed. One byte order mark at the very start of
 * the stream is ignored.
 */
class NdjsonReader {
  private readonly reader: ReadableStreamDefaultReader<unknown>;
  /** Decodes the line in progress; holds the bytes of a character split across chunks. */
  private decoder = strictDecoder();
  /** A copy of the bytes the decoder holds (a character not yet complete), so it can be rebuilt. */
  private carry: Uint8Array = NO_BYTES;
  /** Text pieces of the line in progress. */
  private partial: string[] = [];
  /** The line in progress already holds bytes that are not UTF-8. */
  private broken = false;
  /** Complete lines not yet handed out. */
  private readonly ready: Line[] = [];
  /** No line has been completed yet. */
  private atStart = true;
  /** The first line of the stream was blank (so the first line handed out is not the stream's first). */
  firstLineBlank = false;
  private eof = false;
  private released = false;
  /** Data rows handed out so far (for error messages). */
  rows = 0;

  /** Releases the connection the moment the caller aborts — even while nobody is reading. */
  private readonly onAbort = (): void => this.cancel();

  constructor(
    body: ReadableStream<unknown>,
    private readonly options: ExportStreamOptions,
  ) {
    this.reader = body.getReader();
    const { signal } = options;
    if (signal?.aborted) this.cancel();
    else signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Next non-blank line (trimmed), or `INVALID_LINE`, or `undefined` at EOF. */
  async nextLine(): Promise<Line | undefined> {
    const { signal } = this.options;
    if (signal?.aborted) {
      this.cancel();
      throw new RequestAbortedError("Export stream was aborted", signal.reason);
    }
    try {
      for (;;) {
        const line = this.ready.shift();
        if (line !== undefined) return line;
        if (this.eof) return undefined;
        const result = await this.read();
        if (result.done) {
          this.finish();
          this.release();
        } else {
          this.ingest(result.value);
        }
      }
    } catch (cause) {
      this.cancel();
      if (cause instanceof LexAPIError) throw cause;
      throw new NetworkError(`Export stream interrupted after ${this.rows} rows`, cause);
    }
  }

  private ingest(value: unknown): void {
    const chunk = byteView(value);
    if (chunk === undefined) throw new TypeError("Export stream yielded a chunk that is not bytes");
    if (!this.broken) {
      // Common case: the whole chunk is UTF-8. Decode it in one call and
      // split the text, as a non-strict reader would.
      let text: string | undefined;
      try {
        text = this.decoder.decode(chunk, { stream: true });
      } catch {
        // Rebuild the decoder as it was before this chunk, then find the
        // invalid line byte by byte.
        this.decoder = strictDecoder();
        if (this.carry.length > 0) this.decoder.decode(this.carry, { stream: true });
      }
      if (text !== undefined) {
        this.carry = heldBytes(this.carry, chunk);
        let pos = 0;
        for (;;) {
          const newline = text.indexOf("\n", pos);
          if (newline === -1) break;
          this.partial.push(text.slice(pos, newline));
          const line = this.partial.length === 1 ? this.partial[0]! : this.partial.join("");
          this.partial = [];
          this.complete(line);
          pos = newline + 1;
        }
        if (pos < text.length) this.partial.push(pos === 0 ? text : text.slice(pos));
        return;
      }
    }
    this.ingestBytes(chunk);
  }

  /** A chunk that is not all UTF-8, or that continues a line that is not. */
  private ingestBytes(chunk: Uint8Array): void {
    const first = chunk.indexOf(0x0a);
    if (first === -1) {
      this.feed(chunk);
      return;
    }
    const last = chunk.lastIndexOf(0x0a);
    // The line in progress ends at the first line feed. Every decode below
    // ends at a line feed, so a sequence cut short before it throws instead
    // of waiting for more bytes, and the decoder holds nothing afterwards.
    let line: Line = INVALID_LINE;
    if (!this.broken) {
      try {
        const text = this.decoder.decode(chunk.subarray(0, first + 1), { stream: true });
        this.partial.push(text.slice(0, -1));
        line = this.partial.length === 1 ? this.partial[0]! : this.partial.join("");
      } catch {
        this.decoder = strictDecoder();
      }
    }
    this.partial = [];
    this.broken = false;
    this.carry = NO_BYTES;
    this.complete(line);
    // The complete lines after it: one call when they are all UTF-8.
    if (first < last) this.completeRegion(chunk.subarray(first + 1, last + 1));
    if (last + 1 < chunk.length) this.feed(chunk.subarray(last + 1));
  }

  /** Whole lines, each ending with its line feed. */
  private completeRegion(region: Uint8Array): void {
    let text: string | undefined;
    try {
      text = this.decoder.decode(region, { stream: true });
    } catch {
      this.decoder = strictDecoder();
    }
    if (text !== undefined) {
      let pos = 0;
      for (;;) {
        const newline = text.indexOf("\n", pos);
        if (newline === -1) break;
        this.complete(text.slice(pos, newline));
        pos = newline + 1;
      }
      return;
    }
    // Some line here is not UTF-8: decode them one by one.
    let pos = 0;
    while (pos < region.length) {
      const newline = region.indexOf(0x0a, pos);
      try {
        this.complete(this.decoder.decode(region.subarray(pos, newline + 1), { stream: true }).slice(0, -1));
      } catch {
        this.decoder = strictDecoder();
        this.complete(INVALID_LINE);
      }
      pos = newline + 1;
    }
  }

  /** Bytes of the line in progress (after a line feed, or continuing a line that is not UTF-8). */
  private feed(bytes: Uint8Array): void {
    if (this.broken || bytes.length === 0) return;
    try {
      const text = this.decoder.decode(bytes, { stream: true });
      if (text) this.partial.push(text);
      this.carry = heldBytes(this.carry, bytes);
    } catch {
      this.broken = true;
      this.decoder = strictDecoder();
      this.carry = NO_BYTES;
    }
  }

  /** End of stream: the line in progress, if any. */
  private finish(): void {
    this.eof = true;
    let line: Line = INVALID_LINE;
    if (!this.broken) {
      try {
        this.partial.push(this.decoder.decode());
        line = this.partial.length === 1 ? this.partial[0]! : this.partial.join("");
      } catch {
        // a sequence cut off by the end of the stream
      }
    }
    this.partial = [];
    this.broken = false;
    this.complete(line);
  }

  /** Queue a complete line: a byte order mark leading the stream is dropped; blank lines are skipped. */
  private complete(line: Line): void {
    const first = this.atStart;
    this.atStart = false;
    if (line === INVALID_LINE) {
      this.ready.push(line);
      return;
    }
    const text = trimLine(first && line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
    if (text) this.ready.push(text);
    else if (first) this.firstLineBlank = true;
  }

  private async read(): Promise<ReadableStreamReadResult<unknown>> {
    const { idleTimeoutMs, signal } = this.options;
    if (signal?.aborted) {
      this.cancel();
      throw new RequestAbortedError("Export stream was aborted", signal.reason);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interruptions = new Promise<never>((_, reject) => {
      if (idleTimeoutMs !== undefined && idleTimeoutMs > 0 && idleTimeoutMs !== Infinity) {
        timer = setTimeout(() => {
          reject(
            new TimeoutError(`Export stream received no data for ${idleTimeoutMs}ms (after ${this.rows} rows)`, 0),
          );
        }, timerDelay(idleTimeoutMs));
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
      return result;
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

/** `String(value)`, or the value's kind when that fails (an array nested too deep to join). */
function text(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Array.isArray(value) ? "array" : typeof value;
  }
}

/** A line whose only key is `_error`: a server failure signal, never a row. */
function errorLine(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "_error") return undefined;
  const value = parsed._error;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { message: text(value) };
}

/** Parse one NDJSON line; `undefined` when it is not UTF-8 or not a JSON object. */
function parseLine(line: Line): Record<string, unknown> | undefined {
  if (line === INVALID_LINE) return undefined;
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
      return `the server reported an error mid-stream (${text(this.error.code ?? "UNKNOWN")}: ${text(this.error.message ?? "")})`;
    }
    return "its _done trailer says complete: false";
  }

  get rowsRead(): number {
    return this.lines.rows;
  }

  get truncated(): boolean {
    // API 2.3.0: once read, `_done.truncated` is authoritative — never
    // derived from the (possibly cached) count, skipped stubs not counted.
    if (typeof this.done?.truncated === "boolean") return this.done.truncated;
    if (this.headers.truncated !== undefined) return this.headers.truncated;
    if (typeof this.meta?.truncated === "boolean") return this.meta.truncated;
    return false;
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
    const first = await this.lines.nextLine();
    if (first === undefined) return;
    const parsed = parseLine(first);
    if (parsed === undefined) {
      this.invalidLines++;
      return;
    }
    const error = errorLine(parsed);
    if (error !== undefined) {
      this.error = error; // never a row; iteration reports it
      return;
    }
    // §1.8: `_meta` counts only on the very first line of the stream; a later
    // one (also after a blank first line) is skipped, never a row.
    if ("_meta" in parsed && !this.lines.firstLineBlank) {
      this.meta = liftEnvelope<ExportMeta>(parsed, "_meta");
    } else if ("_done" in parsed) {
      this.done = liftEnvelope<ExportDone>(parsed, "_done");
      this.lines.cancel();
    } else if (!("_meta" in parsed)) {
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
    total: parseHeaderInteger(totalHeader),
    streaming: parseHeaderInteger(streamingHeader),
    truncated: truncatedHeader !== null ? truncatedHeader === "1" : undefined,
  });
  await stream.init();
  return stream;
}
