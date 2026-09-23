import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clipDeep, withIsoTime, serializeBounded } from '../src/sanitize.mjs';

describe('clipDeep', () => {
  test('clips long top-level strings', () => {
    const out = clipDeep({ msg: 'x'.repeat(900) }, 500);
    assert.ok(out.msg.startsWith('x'.repeat(500)));
    assert.ok(out.msg.includes('+400 chars'));
  });

  test('clips strings nested inside objects', () => {
    // Regression: the original only walked top-level values, so a stack trace
    // under body.exception bypassed the cell cap entirely.
    const out = clipDeep({ body: { exception: 'y'.repeat(900) } }, 500);
    assert.ok(out.body.exception.length < 600, 'nested string should be clipped');
  });

  test('clips strings nested inside arrays', () => {
    const out = clipDeep({ items: [{ deep: { s: 'z'.repeat(900) } }] }, 500);
    assert.ok(out.items[0].deep.s.length < 600);
  });

  test('leaves short strings and non-strings untouched', () => {
    const input = { a: 'short', n: 42, b: true, nil: null };
    assert.deepEqual(clipDeep(input, 500), input);
  });

  test('stops at excessive nesting instead of recursing forever', () => {
    let deep = 'leaf';
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const out = clipDeep(deep, 500);
    assert.equal(typeof out, 'object');
    assert.ok(JSON.stringify(out).includes('nesting too deep'));
  });
});

describe('withIsoTime', () => {
  test('adds _time from microsecond _timestamp', () => {
    const out = withIsoTime({ _timestamp: 1_700_000_000_000_000 });
    assert.equal(out._time, new Date(1_700_000_000_000).toISOString());
  });
  test('leaves rows without a numeric _timestamp alone', () => {
    assert.deepEqual(withIsoTime({ a: 1 }), { a: 1 });
    assert.deepEqual(withIsoTime({ _timestamp: 'nope' }), { _timestamp: 'nope' });
  });
});

describe('serializeBounded always emits valid JSON', () => {
  const parses = (s) => {
    assert.doesNotThrow(() => JSON.parse(s), `not valid JSON: ${s.slice(0, 120)}`);
    return JSON.parse(s);
  };

  test('passes small results through unchanged', () => {
    const r = { total: 1, hits: [{ a: 1 }] };
    assert.deepEqual(parses(serializeBounded(r)), r);
  });

  test('halves oversized hit arrays', () => {
    const r = { total: 100, hits: Array.from({ length: 100 }, (_, i) => ({ i, msg: 'x'.repeat(400) })) };
    const out = parses(serializeBounded(r, ['hits'], 20_000));
    assert.ok(out.hits.length < 100);
    assert.equal(out.truncated.of, 100);
    assert.ok(JSON.stringify(out).length <= 20_000);
  });

  test('handles a single row larger than the whole budget', () => {
    // Regression: the halving loop cannot go below one row, and the old code
    // then sliced the serialized string, emitting unparseable output.
    const r = { total: 1, hits: [{ blob: { nested: 'y'.repeat(80_000) } }] };
    const out = parses(serializeBounded(r, ['hits'], 10_000));
    assert.ok(JSON.stringify(out).length <= 10_000);
  });

  test('shrinks arrays that are not named hits', () => {
    // Regression: list_streams returns `streams`, which the hits-only loop
    // never touched, so large stream lists were hard-sliced.
    const r = { matched: 5000, streams: Array.from({ length: 5000 }, (_, i) => ({ name: `stream_${i}`, type: 'logs' })) };
    const out = parses(serializeBounded(r, ['hits', 'streams'], 20_000));
    assert.ok(out.streams.length < 5000);
    assert.ok(JSON.stringify(out).length <= 20_000);
  });

  test('returns a structured error when nothing can be shed', () => {
    const r = { note: 'q'.repeat(80_000) };
    const out = parses(serializeBounded(r, ['hits'], 10_000));
    assert.match(out.error, /output budget/);
  });

  test('reports how many rows were dropped', () => {
    const r = { hits: Array.from({ length: 64 }, (_, i) => ({ i, pad: 'p'.repeat(300) })) };
    const out = parses(serializeBounded(r, ['hits'], 8_000));
    assert.equal(out.truncated.of, 64);
    assert.equal(out.truncated.returned, out.hits.length);
  });
});
