import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, reply, streamList } from '../test-utils/helpers.mjs';
import { ToolError, timeWindow, TOOLS } from '../src/tools.mjs';
import { O2Error } from '../src/client.mjs';
import { LIMITS } from '../src/config.mjs';
import { isoFromMicros, serializeBounded, withIsoTime } from '../src/sanitize.mjs';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ i }));

describe('o2_search pagination', () => {
  test('sends offset upstream as from', async () => {
    const { handlers, calls } = makeClient({ total: 500, hits: rows(10) });
    await handlers.o2_search({ sql: 'SELECT 1', offset: 40, size: 10 });
    assert.equal(JSON.parse(calls[0].body).query.from, 40);
  });

  test('reports the next page when total shows more rows', async () => {
    const { handlers } = makeClient({ total: 500, hits: rows(10) });
    const r = await handlers.o2_search({ sql: 'SELECT 1', offset: 40, size: 50 });
    assert.equal(r.offset, 40);
    assert.equal(r.returned, 10);
    assert.equal(r.has_more, true);
    assert.equal(r.next_offset, 50);
  });

  test('treats a full page as possibly having more when total only counts the page', async () => {
    const { handlers } = makeClient({ total: 10, hits: rows(10) });
    const r = await handlers.o2_search({ sql: 'SELECT 1', size: 10 });
    assert.equal(r.has_more, true);
    assert.equal(r.next_offset, 10);
  });

  test('reports the last page', async () => {
    const { handlers } = makeClient({ total: 3, hits: rows(3) });
    const r = await handlers.o2_search({ sql: 'SELECT 1', size: 10 });
    assert.equal(r.has_more, false);
    assert.equal('next_offset' in r, false);
  });

  test('an empty page never claims more rows', async () => {
    const { handlers } = makeClient({ total: 500, hits: [] });
    assert.equal((await handlers.o2_search({ sql: 'SELECT 1', offset: 500 })).has_more, false);
  });

  test('rejects an invalid offset before any request', async () => {
    const { handlers, calls } = makeClient({ hits: [] });
    for (const bad of [-1, 1.5, 'abc', LIMITS.MAX_OFFSET + 1]) {
      await assert.rejects(() => handlers.o2_search({ sql: 'SELECT 1', offset: bad }), ToolError);
    }
    assert.equal(calls.length, 0);
  });
});

describe('o2_list_streams pagination', () => {
  test('walks every stream exactly once', async () => {
    const { handlers } = makeClient(streamList(25));
    const seen = [];
    let offset = 0;
    for (;;) {
      const page = await handlers.o2_list_streams({ limit: 10, offset });
      seen.push(...page.streams.map((s) => s.name));
      if (!page.has_more) break;
      offset = page.next_offset;
    }
    assert.equal(new Set(seen).size, 25);
    assert.equal(seen.length, 25);
  });

  test('an offset past the end returns an empty final page', async () => {
    const { handlers } = makeClient(streamList(5));
    const r = await handlers.o2_list_streams({ offset: 50 });
    assert.equal(r.returned, 0);
    assert.equal(r.has_more, false);
  });
});

describe('serializeBounded keeps pagination truthful', () => {
  const big = (n) => Array.from({ length: n }, (_, i) => ({ i, pad: 'p'.repeat(300) }));

  test('resumes from the first row that was shed', () => {
    const result = { offset: 100, returned: 64, has_more: false, hits: big(64) };
    const out = JSON.parse(serializeBounded(result, ['hits'], 8_000));
    assert.ok(out.hits.length < 64);
    assert.equal(out.returned, out.hits.length);
    assert.equal(out.has_more, true);
    assert.equal(out.next_offset, 100 + out.hits.length);
  });

  test('skips a row too large to return so paging cannot stall', () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`column_${i}`, 'v'.repeat(150)]));
    const result = { offset: 7, returned: 1, has_more: false, hits: [wide] };
    const out = JSON.parse(serializeBounded(result, ['hits'], 2_000));
    assert.equal(out.hits.length, 0);
    assert.equal(out.returned, 0);
  });

  test('moves past a dropped row when more rows follow it', () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`column_${i}`, 'v'.repeat(150)]));
    const result = { offset: 7, returned: 1, has_more: true, next_offset: 8, hits: [wide] };
    const out = JSON.parse(serializeBounded(result, ['hits'], 2_000));
    assert.equal(out.next_offset, 8);
  });

  test('measures the budget in bytes, not characters', () => {
    const hits = Array.from({ length: 40 }, () => ({ msg: '日本語'.repeat(50) }));
    const text = serializeBounded({ hits }, ['hits'], 8_000);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 8_000);
  });
});

describe('malformed upstream responses', () => {
  const unexpected = (e) => e instanceof O2Error && /unexpected/.test(e.message);

  test('a JSON null body is reported clearly by every tool', async () => {
    const { handlers } = makeClient(reply({ text: 'null' }));
    await assert.rejects(() => handlers.o2_list_streams({}), unexpected);
    await assert.rejects(() => handlers.o2_stream_schema({ stream: 'a' }), unexpected);
    await assert.rejects(() => handlers.o2_search({ sql: 'SELECT 1' }), unexpected);
  });

  test('a field of the wrong type is reported clearly', async () => {
    await assert.rejects(() => makeClient({ list: 'x' }).handlers.o2_list_streams({}), unexpected);
    await assert.rejects(() => makeClient({ schema: 'x' }).handlers.o2_stream_schema({ stream: 'a' }), unexpected);
    await assert.rejects(() => makeClient({ hits: {} }).handlers.o2_search({ sql: 'SELECT 1' }), unexpected);
  });

  test('skips junk entries in stream and field lists', async () => {
    const streams = await makeClient({ list: [null, 1, { name: 'ok' }] }).handlers.o2_list_streams({});
    assert.deepEqual(streams.streams.map((s) => s.name), ['ok']);
    const schema = await makeClient({ schema: [null, { name: 'f', type: 'Utf8' }] }).handlers.o2_stream_schema({ stream: 'a' });
    assert.deepEqual(schema.fields, [{ name: 'f', type: 'Utf8' }]);
  });

  test('one out-of-range timestamp does not fail the result', async () => {
    const search = await makeClient({ hits: [{ _timestamp: 1e30, msg: 'kept' }] }).handlers.o2_search({ sql: 'SELECT 1' });
    assert.equal(search.hits[0].msg, 'kept');
    assert.equal('_time' in search.hits[0], false);
    const list = await makeClient({ list: [{ name: 'a', stats: { doc_time_max: 1e30 } }] }).handlers.o2_list_streams({});
    assert.equal(list.streams[0].last_event, null);
  });

  test('isoFromMicros rejects anything that is not a usable time', () => {
    for (const bad of [undefined, null, 'x', NaN, Infinity, 1e30, 0]) assert.equal(isoFromMicros(bad), null);
    assert.deepEqual(withIsoTime({ _timestamp: 1e30 }), { _timestamp: 1e30 });
  });
});

describe('time window precision', () => {
  test('fractional minutes produce whole microsecond timestamps', async () => {
    const { handlers, calls } = makeClient({ hits: [] });
    await handlers.o2_search({ sql: 'SELECT 1', minutes: 1 / 7, end: '2025-01-01T00:00:00Z' });
    const { start_time: start, end_time: end } = JSON.parse(calls[0].body).query;
    assert.ok(Number.isInteger(start), `start_time was ${start}`);
    assert.ok(Number.isInteger(end), `end_time was ${end}`);
  });

  test('a window that rounds to nothing is rejected', () => {
    assert.throws(() => timeWindow({ minutes: 1e-9 }, 1440), ToolError);
  });
});

describe('tool schemas stay backward compatible', () => {
  test('existing arguments are still declared and offset is optional', () => {
    const props = (name) => TOOLS.find((t) => t.name === name).inputSchema;
    assert.deepEqual(Object.keys(props('o2_list_streams').properties), ['filter', 'type', 'limit', 'offset']);
    assert.deepEqual(Object.keys(props('o2_stream_schema').properties), ['stream', 'type']);
    assert.deepEqual(Object.keys(props('o2_search').properties), ['sql', 'minutes', 'start', 'end', 'size', 'offset', 'type']);
    assert.deepEqual(props('o2_search').required, ['sql']);
    assert.deepEqual(props('o2_stream_schema').required, ['stream']);
    assert.equal(props('o2_list_streams').required, undefined);
  });
});
