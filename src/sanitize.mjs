// Output shaping: keep tool results bounded without ever emitting text the
// client cannot parse.

import { LIMITS } from './config.mjs';

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
  if (typeof value === 'string') {
    return value.length > maxCell ? `${value.slice(0, maxCell)}… [+${value.length - maxCell} chars]` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 12) return '[nesting too deep]';

  if (Array.isArray(value)) {
    return value.map((v) => clipDeep(v, maxCell, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = clipDeep(v, maxCell, depth + 1);
  }
  return out;
}

/**
 * Add a human-readable timestamp next to OpenObserve's microsecond `_timestamp`.
 */
export function withIsoTime(row) {
  if (row && typeof row === 'object' && !Array.isArray(row) && typeof row._timestamp === 'number') {
    return { ...row, _time: new Date(row._timestamp / 1000).toISOString() };
  }
  return row;
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
 * @param {number} maxOut
 */
export function serializeBounded(result, arrayKeys = ['hits', 'streams', 'fields'], maxOut = LIMITS.MAX_OUT) {
  let current = result;
  let text = JSON.stringify(current) ?? 'null';
  if (text.length <= maxOut) return text;

  const key = arrayKeys.find((k) => Array.isArray(current[k]));

  if (key) {
    const original = current[key].length;
    let rows = current[key];

    // Halve until it fits or only one row is left.
    while (rows.length > 1) {
      rows = rows.slice(0, Math.floor(rows.length / 2));
      current = { ...current, [key]: rows, truncated: { key, returned: rows.length, of: original } };
      text = JSON.stringify(current);
      if (text.length <= maxOut) return text;
    }

    // One row still too big: clip that row hard, then drop it if needed.
    const shrunk = clipDeep(rows[0], 200);
    current = { ...current, [key]: [shrunk], truncated: { key, returned: 1, of: original, clipped: true } };
    text = JSON.stringify(current);
    if (text.length <= maxOut) return text;

    current = {
      ...current,
      [key]: [],
      truncated: { key, returned: 0, of: original, note: 'row exceeded output budget; narrow your query or SELECT fewer columns' },
    };
    text = JSON.stringify(current);
    if (text.length <= maxOut) return text;
  }

  // Nothing array-shaped to shed: return a valid JSON error object rather than
  // a truncated fragment.
  return JSON.stringify({
    error: 'result exceeded the output budget and could not be reduced',
    budget_bytes: maxOut,
    hint: 'select fewer columns, lower size, or narrow the time window',
  });
}
