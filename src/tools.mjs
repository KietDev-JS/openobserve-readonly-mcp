// Tool definitions and implementations.

import { LIMITS, STREAM_TYPES } from './config.mjs';
import { checkSql } from './sql.mjs';
import { clipDeep, withIsoTime } from './sanitize.mjs';

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
    start = end - minutes * 60_000;
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
    description: 'List OpenObserve streams (read-only) with type, document count and last event time.',
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
      'No semicolons or SQL comments outside string literals.',
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
  const { apiPrefix, maxWindowMin } = client.config;

  return {
    async o2_list_streams(args) {
      const limit = intArg(args.limit, {
        name: 'limit',
        min: 1,
        max: LIMITS.MAX_STREAMS,
        fallback: LIMITS.DEFAULT_STREAMS,
      });
      const wantType = args.type === undefined ? undefined : streamType(args.type);
      const needle = args.filter === undefined ? '' : String(args.filter).toLowerCase();

      const data = await client.request('GET', `${apiPrefix}/streams`);
      let list = Array.isArray(data.list) ? data.list : [];
      if (wantType) list = list.filter((s) => s.stream_type === wantType);
      if (needle) list = list.filter((s) => String(s.name ?? '').toLowerCase().includes(needle));

      return {
        matched: list.length,
        returned: Math.min(list.length, limit),
        streams: list.slice(0, limit).map((s) => ({
          name: s.name,
          type: s.stream_type,
          docs: s.stats?.doc_num,
          last_event: s.stats?.doc_time_max ? new Date(s.stats.doc_time_max / 1000).toISOString() : null,
        })),
      };
    },

    async o2_stream_schema(args) {
      const stream = streamName(args.stream);
      const type = streamType(args.type);
      const data = await client.request('GET', `${apiPrefix}/streams/${stream}/schema`, { type });
      return {
        stream: data.name ?? stream,
        type: data.stream_type ?? type,
        fields: (data.schema || []).map((f) => ({ name: f.name, type: f.type })),
      };
    },

    async o2_search(args) {
      const sql = checkSql(args.sql);
      const type = streamType(args.type);
      const { start, end } = timeWindow(args, maxWindowMin);
      const size = intArg(args.size, { name: 'size', min: 1, max: LIMITS.MAX_ROWS, fallback: LIMITS.DEFAULT_SIZE });

      const data = await client.request(
        'POST',
        `${apiPrefix}/_search`,
        { type },
        // OpenObserve expects microseconds since epoch.
        { query: { sql, start_time: start * 1000, end_time: end * 1000, from: 0, size } },
      );

      return {
        window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
        total: data.total,
        took_ms: data.took,
        hits: (data.hits || []).map((row) => clipDeep(withIsoTime(row))),
      };
    },
  };
}
