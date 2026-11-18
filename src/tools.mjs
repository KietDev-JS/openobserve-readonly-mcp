// Tool definitions and implementations.

import { LIMITS, STREAM_TYPES } from './config.mjs';
import { checkSql } from './sql.mjs';
import { isoFromMicros, shapeRow, withIsoTime } from './sanitize.mjs';
import { O2Error } from './client.mjs';

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Parse a bounded integer argument.
 *
 * Rejects negatives and non-integers instead of coercing them. The previous
 * behaviour passed the raw value to Array.prototype.slice, where a negative
 * limit counts from the end of the array — `limit: -5` on 480 streams reported
 * `matched: 480` and then returned an empty list.
 */
function intArg(value, { name, min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ToolError(`${name} must be an integer, got: ${JSON.stringify(value)}`);
  }
  if (n < min || n > max) {
    throw new ToolError(`${name} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

function streamType(value) {
  const v = value ?? 'logs';
  if (!STREAM_TYPES.includes(v)) {
    throw new ToolError(`type must be one of: ${STREAM_TYPES.join(', ')}`);
  }
  return v;
}

const STREAM_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function streamName(value) {
  if (typeof value !== 'string' || !STREAM_NAME_RE.test(value)) {
    throw new ToolError(`invalid stream name: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Read an array field from an upstream response. A missing field is an empty
 * result; any other shape means the response is not what this server expects,
 * and saying so beats failing later with an opaque TypeError.
 */
function upstreamArray(data, field, what) {
  if (!isRecord(data)) {
    throw new O2Error(`OpenObserve returned an unexpected ${what} response: expected a JSON object`);
  }
  const value = data[field] ?? [];
  if (!Array.isArray(value)) {
    throw new O2Error(`OpenObserve returned an unexpected ${what} response: "${field}" is not an array`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve the query time window.
 * @param {Record<string, unknown>} args
 * @param {number} maxWindowMin
 */
export function timeWindow(args, maxWindowMin) {
  const end = args.end ? Date.parse(String(args.end)) : Date.now();
  if (!Number.isFinite(end)) throw new ToolError(`end is not a valid ISO-8601 timestamp: ${args.end}`);

  let start;
  if (args.start) {
    start = Date.parse(String(args.start));
    if (!Number.isFinite(start)) throw new ToolError(`start is not a valid ISO-8601 timestamp: ${args.start}`);
  } else {
    const minutes = args.minutes === undefined ? LIMITS.DEFAULT_MINUTES : Number(args.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new ToolError(`minutes must be a positive number, got: ${args.minutes}`);
    }
    // Whole milliseconds keep the microsecond timestamps sent upstream integral
    // when minutes is fractional.
    start = Math.round(end - minutes * 60_000);
  }

  if (start >= end) throw new ToolError('invalid time range: start must be before end');
  const spanMin = (end - start) / 60_000;
  if (spanMin > maxWindowMin) {
    throw new ToolError(
      `time window is ${Math.round(spanMin)} minutes, which exceeds the ${maxWindowMin} minute limit. ` +
        'Narrow the range or raise O2_MAX_WINDOW_MIN.',
    );
  }
  return { start, end };
}

export const TOOLS = [
  {
    name: 'o2_list_streams',
    description:
      'List OpenObserve streams (read-only) with type, document count and last event time. ' +
      'Start here to find the exact stream name. When has_more is true, call again with offset set to next_offset.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Case-insensitive substring of the stream name.' },
        type: { type: 'string', enum: STREAM_TYPES, description: 'Only streams of this type.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: LIMITS.MAX_STREAMS,
          description: `Max streams to return (default ${LIMITS.DEFAULT_STREAMS}).`,
        },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: LIMITS.MAX_OFFSET,
          description: 'Matching streams to skip (default 0). Use next_offset from the previous result.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List streams', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'o2_stream_schema',
    description: 'Field names and types of one stream (read-only). Use before writing a query to learn valid column names.',
    inputSchema: {
      type: 'object',
      properties: {
        stream: { type: 'string', description: 'Exact stream name.' },
        type: { type: 'string', enum: STREAM_TYPES, description: 'Stream type (default logs).' },
      },
      required: ['stream'],
      additionalProperties: false,
    },
    annotations: { title: 'Stream schema', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'o2_search',
    description:
      'Run one read-only SQL SELECT/WITH query against OpenObserve. Quote the stream name: ' +
      'SELECT * FROM "stream" ORDER BY _timestamp DESC. ' +
      `Defaults to the last ${LIMITS.DEFAULT_MINUTES} minutes and returns at most ${LIMITS.MAX_ROWS} rows. ` +
      'Set the time range with minutes or start/end. ' +
      'When has_more is true, call again with offset set to next_offset. ' +
      'No semicolons or SQL comments outside string literals. ' +
      'Values that look like credentials are returned as [REDACTED].',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One SELECT or WITH statement.' },
        minutes: { type: 'number', exclusiveMinimum: 0, description: 'Look back this many minutes from end (default 15).' },
        start: { type: 'string', description: 'ISO-8601 start time (overrides minutes).' },
        end: { type: 'string', description: 'ISO-8601 end time (default now).' },
        size: {
          type: 'integer',
          minimum: 1,
          maximum: LIMITS.MAX_ROWS,
          description: `Rows to return (default ${LIMITS.DEFAULT_SIZE}).`,
        },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: LIMITS.MAX_OFFSET,
          description: 'Rows to skip (default 0). Use next_offset from the previous result.',
        },
        type: { type: 'string', enum: STREAM_TYPES, description: 'Stream type (default logs).' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    annotations: { title: 'Search logs', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

/**
 * @param {import('./client.mjs').O2Client} client
 */
export function createHandlers(client) {
  const { apiPrefix, maxWindowMin, redactSecrets } = client.config;

  return {
    async o2_list_streams(args, { signal } = {}) {
      const limit = intArg(args.limit, {
        name: 'limit',
        min: 1,
        max: LIMITS.MAX_STREAMS,
        fallback: LIMITS.DEFAULT_STREAMS,
      });
      const offset = intArg(args.offset, { name: 'offset', min: 0, max: LIMITS.MAX_OFFSET, fallback: 0 });
      const wantType = args.type === undefined ? undefined : streamType(args.type);
      const needle = args.filter === undefined ? '' : String(args.filter).toLowerCase();

      const data = await client.request('GET', `${apiPrefix}/streams`, undefined, undefined, { signal });
      let list = upstreamArray(data, 'list', 'stream list').filter(isRecord);
      if (wantType) list = list.filter((s) => s.stream_type === wantType);
      if (needle) list = list.filter((s) => String(s.name ?? '').toLowerCase().includes(needle));

      const page = list.slice(offset, offset + limit);
      const next = offset + page.length;
      const hasMore = next < list.length;

      return {
        matched: list.length,
        offset,
        returned: page.length,
        has_more: hasMore,
        ...(hasMore ? { next_offset: next } : {}),
        streams: page.map((s) => ({
          name: s.name,
          type: s.stream_type,
          docs: s.stats?.doc_num,
          last_event: isoFromMicros(s.stats?.doc_time_max),
        })),
      };
    },

    async o2_stream_schema(args, { signal } = {}) {
      const stream = streamName(args.stream);
      const type = streamType(args.type);
      const data = await client.request('GET', `${apiPrefix}/streams/${stream}/schema`, { type }, undefined, { signal });
      const fields = upstreamArray(data, 'schema', 'stream schema').filter(isRecord);
      return {
        stream: data.name ?? stream,
        type: data.stream_type ?? type,
        fields: fields.map((f) => ({ name: f.name, type: f.type })),
      };
    },

    async o2_search(args, { signal } = {}) {
      const sql = checkSql(args.sql);
      const type = streamType(args.type);
      const { start, end } = timeWindow(args, maxWindowMin);
      const size = intArg(args.size, { name: 'size', min: 1, max: LIMITS.MAX_ROWS, fallback: LIMITS.DEFAULT_SIZE });
      const offset = intArg(args.offset, { name: 'offset', min: 0, max: LIMITS.MAX_OFFSET, fallback: 0 });

      const data = await client.request(
        'POST',
        `${apiPrefix}/_search`,
        { type },
        // OpenObserve expects microseconds since epoch.
        { query: { sql, start_time: start * 1000, end_time: end * 1000, from: offset, size } },
        { signal },
      );
      const hits = upstreamArray(data, 'hits', 'search');
      const next = offset + hits.length;
      // `total` may only count the returned page, so a full page also signals
      // that more rows can exist. The worst case is one extra, empty page.
      const hasMore = hits.length > 0 && (hits.length >= size || (typeof data.total === 'number' && next < data.total));

      return {
        window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
        total: data.total,
        took_ms: data.took,
        offset,
        returned: hits.length,
        has_more: hasMore,
        ...(hasMore ? { next_offset: next } : {}),
        hits: hits.map((row) => shapeRow(withIsoTime(row), { redact: redactSecrets })),
      };
    },
  };
}
