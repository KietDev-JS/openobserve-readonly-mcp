// Output shaping: keep tool results bounded without ever emitting text the
// client cannot parse, and keep credentials found in log data out of them.

import { LIMITS } from './config.mjs';

export const REDACTED = '[REDACTED]';

/** Field names whose string values are credentials, matched on the end of the normalized name. */
const SENSITIVE_KEY =
  /(?:^|_)(?:password|passwd|passphrase|pwd|secret|token|api_?key|access_?key|secret_?key|private_?key|authorization|credentials?|cookies?)$/;

/** `name=value` and `"name":"value"` pairs inside free text, including escaped JSON. */
const SECRET_PAIR =
  /((?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?)(?:\\?["'])?\s*[:=]\s*)(?:(\\?")(?:(?!\2)[^\n])*(?:\2|(?=\n|$))|(\\?')(?:(?!\3)[^\n])*(?:\3|(?=\n|$))|(?:(?:bearer|basic)\s+)?[^\s"'\\,;&)}\]]+)/gi;

/** Secret formats recognizable without any surrounding field name. */
const SECRET_PATTERNS = [
  // An unterminated block is still redacted: clipping can remove its footer.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/((?:set-)?cookie["']?\s*[:=]\s*)[^\n]+/gi, `$1${REDACTED}`],
  // user:password@ in a connection string.
  [/(:\/\/[^\s:/@]+:)[^\s/@]+@/g, `$1${REDACTED}@`],
  // JSON Web Tokens.
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, REDACTED],
  // The lookahead keeps prose such as "Basic Authentication" intact.
  [/\b(Bearer|Basic|bearer|basic|BEARER|BASIC)\s+(?=[A-Za-z._~-]*[0-9+/=])[A-Za-z0-9+/._~-]{8,}={0,2}/g, `$1 ${REDACTED}`],
  // Cloud and SaaS key formats.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_\w{20,}/g, REDACTED],
  [/\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[\w-]{30,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
];

/**
 * Replace secret-shaped substrings. Best effort: it catches common formats,
 * not an arbitrary password stored under an innocuous field name.
 *
 * @param {string} text
 */
export function redactText(text) {
  let out = text.replace(SECRET_PAIR, (_, prefix, dq, sq) => {
    const quote = dq ?? sq ?? '';
    return `${prefix}${quote}${REDACTED}${quote}`;
  });
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Whether a field name denotes a credential: `accessToken`, `X-Api-Key`, `db.password`. */
export function isSensitiveKey(key) {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase();
  return SENSITIVE_KEY.test(normalized);
}

/** Clip one string, redacting first so a secret cannot survive by being cut in half. */
function shapeString(value, maxCell, redact) {
  // Only the head can reach the output, so a huge cell costs bounded regex work.
  const head = value.slice(0, Math.max(maxCell, LIMITS.SCAN_CHARS));
  const clean = redact ? redactText(head) : head;
  if (value.length <= maxCell) return clean;
  return `${clean.slice(0, maxCell)}… [+${value.length - maxCell} chars]`;
}

function shape(value, maxCell, redact, depth) {
  if (typeof value === 'string') return shapeString(value, maxCell, redact);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 12) return '[nesting too deep]';

  if (Array.isArray(value)) {
    return value.map((v) => shape(v, maxCell, redact, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // Numbers and booleans stay: `token: 12` is far more often a count than a secret.
    const secretValue = (typeof v === 'string' && v !== '') || (v !== null && typeof v === 'object');
    out[k] = redact && secretValue && isSensitiveKey(k) ? REDACTED : shape(v, maxCell, redact, depth + 1);
  }
  return out;
}

/**
 * Recursively clip long strings.
 *
 * The original implementation only clipped top-level values, which missed the
 * common case: OpenObserve log rows routinely nest the interesting payload
 * under an object, so an 8KB stack trace at `body.exception` slipped through
 * untouched.
 *
 * @param {unknown} value
 * @param {number} maxCell
 * @param {number} depth guards against pathological nesting and cycles
 */
export function clipDeep(value, maxCell = LIMITS.MAX_CELL, depth = 0) {
  return shape(value, maxCell, false, depth);
}

/**
 * Prepare a log row for output: redact credentials, then clip long strings.
 *
 * @param {unknown} row
 * @param {{ redact?: boolean, maxCell?: number }} [options]
 */
export function shapeRow(row, { redact = true, maxCell = LIMITS.MAX_CELL } = {}) {
  return shape(row, maxCell, redact, 0);
}

/**
 * Convert OpenObserve's microseconds to ISO-8601, or null if out of range.
 * `Date#toISOString` throws on invalid dates, and one bad value must not fail
 * a whole result.
 */
export function isoFromMicros(micros) {
  if (typeof micros !== 'number' || !Number.isFinite(micros) || micros === 0) return null;
  const date = new Date(micros / 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Add a human-readable timestamp next to OpenObserve's microsecond `_timestamp`.
 */
export function withIsoTime(row) {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const time = isoFromMicros(row._timestamp);
    if (time) return { ...row, _time: time };
  }
  return row;
}

/**
 * Keep pagination fields truthful after rows were shed: the caller must resume
 * from the first row it did not receive. A row dropped for being oversized is
 * skipped, otherwise the same offset would fail forever.
 */
function repage(result, shown, original) {
  const out = { ...result };
  if (typeof result.returned === 'number') out.returned = shown;
  if (typeof result.offset === 'number') {
    const next = result.offset + Math.max(shown, 1);
    if (result.has_more === true || next < result.offset + original) {
      out.has_more = true;
      out.next_offset = next;
    }
  }
  return out;
}

/**
 * Serialize a result to JSON, shrinking it until it fits the output budget.
 *
 * Guarantees the returned string is always valid JSON. The previous version
 * fell back to slicing the serialized text, which produced unparseable output
 * exactly when a result was most interesting — a single oversized row, or a
 * large `streams` array that the hits-only halving loop never touched.
 *
 * @param {Record<string, unknown>} result
 * @param {string[]} arrayKeys keys holding row arrays, in drop-priority order
 * @param {number} maxOut budget in UTF-8 bytes
 */
export function serializeBounded(result, arrayKeys = ['hits', 'streams', 'fields'], maxOut = LIMITS.MAX_OUT) {
  const fits = (s) => Buffer.byteLength(s, 'utf8') <= maxOut;
  let current = result;
  let text = JSON.stringify(current) ?? 'null';
  if (fits(text)) return text;

  const key = arrayKeys.find((k) => Array.isArray(current[k]));

  if (key) {
    const original = current[key].length;
    let rows = current[key];

    // Halve until it fits or only one row is left.
    while (rows.length > 1) {
      rows = rows.slice(0, Math.floor(rows.length / 2));
      current = { ...repage(result, rows.length, original), [key]: rows, truncated: { key, returned: rows.length, of: original } };
      text = JSON.stringify(current);
      if (fits(text)) return text;
    }

    // One row still too big: clip that row hard, then drop it if needed.
    const shrunk = clipDeep(rows[0], 200);
    current = { ...repage(result, 1, original), [key]: [shrunk], truncated: { key, returned: 1, of: original, clipped: true } };
    text = JSON.stringify(current);
    if (fits(text)) return text;

    current = {
      ...repage(result, 0, original),
      [key]: [],
      truncated: { key, returned: 0, of: original, note: 'row exceeded output budget; narrow your query or SELECT fewer columns' },
    };
    text = JSON.stringify(current);
    if (fits(text)) return text;
  }

  // Nothing array-shaped to shed: return a valid JSON error object rather than
  // a truncated fragment.
  return JSON.stringify({
    error: 'result exceeded the output budget and could not be reduced',
    budget_bytes: maxOut,
    hint: 'select fewer columns, lower size, or narrow the time window',
  });
}
