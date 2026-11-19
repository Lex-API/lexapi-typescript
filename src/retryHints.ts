/**
 * Server-directed waits (SDK contract §1.2): the grammar of `Retry-After`,
 * `RateLimit-Reset` and the JSON `retryAfter` field. Anything outside it
 * counts as absent.
 */

/**
 * Normalize a numeric retry hint. The field can carry absolute epoch values
 * instead of delta-seconds: above 1e12 it is read as epoch milliseconds,
 * above 1e9 as epoch seconds, and either is converted to a non-negative
 * delta in seconds. A value that is not finite gives 0.
 */
export function normalizeRetryAfterSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1e12) return Math.max(0, Math.round((value - Date.now()) / 1000)); // epoch millis
  if (value > 1e9) return Math.max(0, Math.round(value - Date.now() / 1000)); // epoch seconds
  return Math.max(0, value);
}

/** Remove leading and trailing spaces and tabs (and nothing else). */
export function trimSpaces(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** `1*DIGIT [ "." 1*DIGIT ]` after trimming, finite; then the epoch rule. Anything else is absent. */
export function decimalSeconds(raw: string | null | undefined): number | undefined {
  if (typeof raw !== "string") return undefined;
  const value = trimSpaces(raw);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? normalizeRetryAfterSeconds(seconds) : undefined;
}

/** A JSON `retryAfter`: a finite number ≥ 0 (`-0` is 0), else absent. */
export function bodySeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return normalizeRetryAfterSeconds(value);
}

const DAYS = "Mon|Tue|Wed|Thu|Fri|Sat|Sun";
const LONG_DAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = MONTHS.join("|");
const TIME = "([0-9]{2}):([0-9]{2}):([0-9]{2})";
const ZONE = "(?:GMT|UTC|\\+0000)";
/** IMF-fixdate: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE = new RegExp(`^(?:${DAYS}), ([0-9]{2}) (${MONTH}) ([0-9]{4}) ${TIME} ${ZONE}$`, "i");
/** RFC 850: `Sunday, 06-Nov-94 08:49:37 GMT`. */
const RFC850_DATE = new RegExp(`^(?:${LONG_DAYS}), ([0-9]{2})-(${MONTH})-([0-9]{2}) ${TIME} ${ZONE}$`, "i");
/** asctime: `Sun Nov  6 08:49:37 1994` (no zone: UTC). */
const ASCTIME_DATE = new RegExp(`^(?:${DAYS}) (${MONTH}) ([0-9]{2}| [0-9]) ${TIME} ([0-9]{4})$`, "i");

/** A sortable key for a calendar date and time (no validation). */
function dateKey(year: number, month: number, day: number, h: number, m: number, s: number): number {
  return ((((year * 12 + month) * 31 + day) * 24 + h) * 60 + m) * 60 + s;
}

/**
 * RFC 9110 §5.6.7, per timestamp: a two-digit year is the year with those
 * last two digits that puts the timestamp latest without being more than 50
 * years after now (the same UTC date and time 50 years on).
 */
function fullYear(twoDigits: number, month: string, day: number, h: number, m: number, s: number, now: number): number {
  const at = new Date(now);
  const limit = dateKey(at.getUTCFullYear() + 50, at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds());
  const monthIndex = MONTHS.indexOf(month.toLowerCase());
  let year = Math.floor(at.getUTCFullYear() / 100) * 100 + 100 + twoDigits;
  while (dateKey(year, monthIndex, day, h, m, s) > limit) year -= 100;
  return year;
}

function utcMs(year: number, month: string, day: number, h: number, m: number, s: number): number | undefined {
  const monthIndex = MONTHS.indexOf(month.toLowerCase());
  if (monthIndex < 0 || h > 23 || m > 59 || s > 59 || day < 1) return undefined;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthIndex]!;
  if (day > daysInMonth) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(h, m, s, 0);
  return date.getTime();
}

/** An HTTP-date (RFC 9110 §5.6.7) as epoch milliseconds, or `undefined` for anything else. */
export function httpDateMs(value: string, now = Date.now()): number | undefined {
  let match = IMF_FIXDATE.exec(value);
  if (match) {
    const [, day, month, year, h, m, s] = match as unknown as string[];
    return utcMs(Number(year), month!, Number(day), Number(h), Number(m), Number(s));
  }
  match = RFC850_DATE.exec(value);
  if (match) {
    const [, day, month, year, h, m, s] = match as unknown as string[];
    const [d, hh, mm, ss] = [Number(day), Number(h), Number(m), Number(s)];
    return utcMs(fullYear(Number(year), month!, d, hh, mm, ss, now), month!, d, hh, mm, ss);
  }
  match = ASCTIME_DATE.exec(value);
  if (match) {
    const [, month, day, h, m, s, year] = match as unknown as string[];
    return utcMs(Number(year), month!, Number(day!.trim()), Number(h), Number(m), Number(s));
  }
  return undefined;
}

/** `Retry-After`: delta-seconds or an HTTP-date (a past date is a wait of 0); anything else is absent. */
export function retryAfterHeaderSeconds(raw: string | null | undefined): number | undefined {
  if (typeof raw !== "string") return undefined;
  const value = trimSpaces(raw);
  if (/^[0-9]/.test(value)) return decimalSeconds(value);
  const now = Date.now();
  const date = httpDateMs(value, now);
  return date === undefined ? undefined : Math.max(0, Math.round((date - now) / 1000));
}

/** The longest delay a timer keeps (JavaScript's limit); a longer one fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A delay a timer honours: within 0 … `MAX_TIMER_MS`, 0 for a value that is not a number. */
export function timerDelay(ms: number): number {
  if (Number.isNaN(ms)) return 0;
  return Math.min(Math.max(ms, 0), MAX_TIMER_MS);
}
