import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, streamList, TEST_ENV } from '../test-utils/helpers.mjs';
import { ToolError, timeWindow, TOOLS } from '../src/tools.mjs';
import { SqlError } from '../src/sql.mjs';

describe('o2_list_streams limit handling', () => {
  test('defaults to 100 streams', async () => {
    const { handlers } = makeClient(streamList(300));
    const r = await handlers.o2_list_streams({});
    assert.equal(r.streams.length, 100);
    assert.equal(r.matched, 300);
  });

  test('honours an explicit limit', async () => {
    const { handlers } = makeClient(streamList(50));
    assert.equal((await handlers.o2_list_streams({ limit: 5 })).streams.length, 5);
  });

  test('rejects a negative limit instead of returning nothing', async () => {
    // Regression: slice(0, -5) counts from the end, so a negative limit
    // reported matched:480 and then returned an empty list.
    const { handlers } = makeClient(streamList(12));
    await assert.rejects(() => handlers.o2_list_streams({ limit: -5 }), ToolError);
  });

  test('rejects a fractional limit', async () => {
    const { handlers } = makeClient(streamList(12));
    await assert.rejects(() => handlers.o2_list_streams({ limit: 2.7 }), ToolError);
  });

  test('rejects a non-numeric or zero limit', async () => {
    const { handlers } = makeClient(streamList(12));
    for (const bad of ['abc', 0, Infinity, NaN]) {
      await assert.rejects(() => handlers.o2_list_streams({ limit: bad }), ToolError, `should reject ${bad}`);
    }
  });

  test('rejects a limit above the cap', async () => {
    const { handlers } = makeClient(streamList(12));
    await assert.rejects(() => handlers.o2_list_streams({ limit: 5000 }), ToolError);
  });

  test('reports matched and returned separately', async () => {
    const { handlers } = makeClient(streamList(300));
    const r = await handlers.o2_list_streams({ limit: 10 });
    assert.equal(r.matched, 300);
    assert.equal(r.returned, 10);
  });
});

describe('o2_list_streams filtering', () => {
  test('filters by case-insensitive substring', async () => {
    const { handlers } = makeClient({
      list: [
        { name: 'AppLogs', stream_type: 'logs', stats: {} },
        { name: 'metrics_cpu', stream_type: 'metrics', stats: {} },
      ],
    });
    const r = await handlers.o2_list_streams({ filter: 'applogs' });
    assert.equal(r.matched, 1);
    assert.equal(r.streams[0].name, 'AppLogs');
  });

  test('filters by stream type', async () => {
    const { handlers } = makeClient(streamList(9));
    const r = await handlers.o2_list_streams({ type: 'metrics' });
    assert.ok(r.streams.every((s) => s.type === 'metrics'));
  });

  test('rejects an unknown type', async () => {
    const { handlers } = makeClient(streamList(3));
    await assert.rejects(() => handlers.o2_list_streams({ type: 'bogus' }), ToolError);
  });

  test('converts last_event to ISO', async () => {
    const { handlers } = makeClient(streamList(1));
    const r = await handlers.o2_list_streams({});
    assert.equal(r.streams[0].last_event, new Date(1_700_000_000_000).toISOString());
  });

  test('survives a response without a list', async () => {
    const { handlers } = makeClient({});
    assert.deepEqual((await handlers.o2_list_streams({})).streams, []);
  });
});

describe('o2_stream_schema', () => {
  test('returns field names and types', async () => {
    const { handlers, calls } = makeClient({
      name: 'applogs',
      stream_type: 'logs',
      schema: [{ name: 'level', type: 'Utf8' }, { name: '_timestamp', type: 'Int64' }],
    });
    const r = await handlers.o2_stream_schema({ stream: 'applogs' });
    assert.equal(r.fields.length, 2);
    assert.equal(calls[0].url.pathname, '/api/default/streams/applogs/schema');
    assert.equal(calls[0].url.searchParams.get('type'), 'logs');
  });

  test('rejects stream names that could alter the path', async () => {
    const { handlers } = makeClient({});
    for (const bad of ['../etc', 'a/b', 'a b', '-lead', 'a%2fb', '', 'a?b', 'a#b']) {
      await assert.rejects(() => handlers.o2_stream_schema({ stream: bad }), ToolError, `should reject ${bad}`);
    }
  });

  test('accepts dots, dashes and underscores', async () => {
    const { handlers } = makeClient({ schema: [] });
    for (const ok of ['a.b-c', '_x', 'A1']) {
      await assert.doesNotReject(() => handlers.o2_stream_schema({ stream: ok }));
    }
  });
});

describe('o2_search', () => {
  const searchBody = { total: 2, took: 7, hits: [{ _timestamp: 1_700_000_000_000_000, msg: 'hi' }] };

  test('sends microsecond timestamps and the requested size', async () => {
    const { handlers, calls } = makeClient(searchBody);
    await handlers.o2_search({ sql: 'SELECT * FROM "l"', minutes: 30, size: 25 });
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent.query.size, 25);
    assert.equal(sent.query.from, 0);
    // microseconds => 1000x milliseconds
    assert.equal(sent.query.end_time - sent.query.start_time, 30 * 60_000 * 1000);
  });

  test('adds _time to hits', async () => {
    const { handlers } = makeClient(searchBody);
    const r = await handlers.o2_search({ sql: 'SELECT * FROM "l"' });
    assert.equal(r.hits[0]._time, new Date(1_700_000_000_000).toISOString());
  });

  test('clips long nested strings in hits', async () => {
    const { handlers } = makeClient({ hits: [{ body: { trace: 'x'.repeat(5000) } }] });
    const r = await handlers.o2_search({ sql: 'SELECT * FROM "l"' });
    assert.ok(r.hits[0].body.trace.length < 700);
  });

  test('rejects a write statement before any request is made', async () => {
    const { handlers, calls } = makeClient(searchBody);
    await assert.rejects(() => handlers.o2_search({ sql: 'DROP TABLE x' }), SqlError);
    assert.equal(calls.length, 0, 'must not contact the server');
  });

  test('rejects an out-of-range size', async () => {
    const { handlers } = makeClient(searchBody);
    for (const bad of [-5, 0, 2.5, 9999, 'abc']) {
      await assert.rejects(() => handlers.o2_search({ sql: 'SELECT 1', size: bad }), ToolError);
    }
  });

  test('passes the stream type through as a query param', async () => {
    const { handlers, calls } = makeClient(searchBody);
    await handlers.o2_search({ sql: 'SELECT 1', type: 'traces' });
    assert.equal(calls[0].url.searchParams.get('type'), 'traces');
  });
});

describe('timeWindow', () => {
  const MAX = 1440;
  test('defaults to the last 15 minutes', () => {
    const { start, end } = timeWindow({}, MAX);
    assert.equal(Math.round((end - start) / 60_000), 15);
  });
  test('accepts an explicit range', () => {
    const w = timeWindow({ start: '2025-01-01T00:00:00Z', end: '2025-01-01T01:00:00Z' }, MAX);
    assert.equal((w.end - w.start) / 60_000, 60);
  });
  test('rejects a window over the cap', () => {
    assert.throws(() => timeWindow({ minutes: 99_999 }, MAX), ToolError);
  });
  test('rejects zero, negative and non-numeric minutes', () => {
    for (const m of [0, -5, 'abc', NaN]) assert.throws(() => timeWindow({ minutes: m }, MAX), ToolError);
  });
  test('rejects unparseable timestamps', () => {
    assert.throws(() => timeWindow({ start: 'nope' }, MAX), ToolError);
    assert.throws(() => timeWindow({ end: 'nope' }, MAX), ToolError);
  });
  test('rejects start on or after end', () => {
    assert.throws(() => timeWindow({ start: '2025-01-02T00:00:00Z', end: '2025-01-01T00:00:00Z' }, MAX), ToolError);
    assert.throws(() => timeWindow({ start: '2025-01-01T00:00:00Z', end: '2025-01-01T00:00:00Z' }, MAX), ToolError);
  });
  test('honours a lowered cap', () => {
    assert.throws(() => timeWindow({ minutes: 120 }, 60), ToolError);
  });
});

describe('tool declarations', () => {
  test('all tools are annotated read-only', () => {
    for (const t of TOOLS) {
      assert.equal(t.annotations.readOnlyHint, true, `${t.name} must be read-only`);
      assert.equal(t.annotations.destructiveHint, false);
    }
  });
  test('every tool has a name, description and object schema', () => {
    for (const t of TOOLS) {
      assert.ok(t.name && t.description);
      assert.equal(t.inputSchema.type, 'object');
    }
  });
  test('schemas reject unknown arguments', () => {
    for (const t of TOOLS) assert.equal(t.inputSchema.additionalProperties, false);
  });
});
