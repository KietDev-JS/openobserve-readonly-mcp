import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, reply, TEST_ENV } from '../test-utils/helpers.mjs';
import { O2Client, O2Error } from '../src/client.mjs';
import { LIMITS, loadConfig } from '../src/config.mjs';

const PATH = '/api/default/streams';

/** Respond with each entry in turn, repeating the last one. */
function sequence(...responses) {
  let i = 0;
  return () => responses[Math.min(i++, responses.length - 1)];
}

const networkError = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

describe('retries', () => {
  for (const status of [429, 502, 503, 504]) {
    test(`retries a transient ${status}`, async () => {
      const { client, calls, sleeps } = makeClient(sequence(reply({ status, text: 'busy' }), { list: [] }));
      assert.deepEqual(await client.request('GET', PATH), { list: [] });
      assert.equal(calls.length, 2);
      assert.equal(sleeps.length, 1);
    });
  }

  test('retries a transient connection failure', async () => {
    const { client, calls } = makeClient(sequence(networkError('ECONNRESET'), { list: [] }));
    await client.request('GET', PATH);
    assert.equal(calls.length, 2);
  });

  test('does not retry failures that will repeat', async () => {
    for (const status of [400, 401, 403, 404, 500]) {
      const { client, calls } = makeClient(reply({ status, text: 'no' }));
      await assert.rejects(() => client.request('GET', PATH), O2Error);
      assert.equal(calls.length, 1, `${status} must not be retried`);
    }
    const dns = makeClient(networkError('ENOTFOUND'));
    await assert.rejects(() => dns.client.request('GET', PATH), O2Error);
    assert.equal(dns.calls.length, 1, 'a DNS failure must not be retried');
  });

  test('stops after O2_MAX_RETRIES and says how many attempts ran', async () => {
    const { client, calls } = makeClient(reply({ status: 503, text: 'down' }));
    await assert.rejects(() => client.request('GET', PATH), /gave up after 3 attempts/);
    assert.equal(calls.length, 3);
  });

  test('O2_MAX_RETRIES=0 disables retries', async () => {
    const { client, calls } = makeClient(reply({ status: 503, text: 'down' }), { ...TEST_ENV, O2_MAX_RETRIES: '0' });
    await assert.rejects(() => client.request('GET', PATH), O2Error);
    assert.equal(calls.length, 1);
  });

  test('honours a short Retry-After', async () => {
    const { client, sleeps } = makeClient(
      sequence(reply({ status: 429, text: 'slow', headers: { 'retry-after': '2' } }), { list: [] }),
    );
    await client.request('GET', PATH);
    assert.deepEqual(sleeps, [2000]);
  });

  test('gives up at once when Retry-After is too long to wait', async () => {
    const { client, calls, sleeps } = makeClient(reply({ status: 429, text: 'slow', headers: { 'retry-after': '120' } }));
    await assert.rejects(() => client.request('GET', PATH), /rate limiting/);
    assert.equal(calls.length, 1);
    assert.equal(sleeps.length, 0);
  });

  test('does not wait past the overall deadline', async () => {
    const env = { ...TEST_ENV, O2_TIMEOUT_MS: '100' };
    const { client, calls } = makeClient(reply({ status: 503, text: 'down' }), env);
    await assert.rejects(() => client.request('GET', PATH), O2Error);
    assert.equal(calls.length, 1, 'the first backoff is longer than the whole budget');
  });
});

describe('timeouts and cancellation', () => {
  /** A fetch that never answers until its signal aborts. */
  const hanging = (counter = {}) => (_url, init) =>
    new Promise((_, reject) => {
      counter.calls = (counter.calls ?? 0) + 1;
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

  test('enforces O2_TIMEOUT_MS on a request that never answers', async () => {
    const counter = {};
    const config = loadConfig({ ...TEST_ENV, O2_TIMEOUT_MS: '20' });
    const client = new O2Client(config, { fetch: hanging(counter) });
    await assert.rejects(() => client.request('GET', PATH), /timed out after 20ms.*O2_TIMEOUT_MS/);
    assert.equal(counter.calls, 1, 'a timeout has used the whole budget and is not retried');
  });

  test('a cancelled signal aborts the in-flight request', async () => {
    const client = new O2Client(loadConfig(TEST_ENV), { fetch: hanging() });
    const controller = new AbortController();
    const pending = client.request('GET', PATH, undefined, undefined, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (e) => e instanceof O2Error && e.cancelled === true);
  });

  test('an already cancelled signal never reaches the network', async () => {
    const { client, calls } = makeClient({ list: [] });
    const signal = AbortSignal.abort();
    await assert.rejects(() => client.request('GET', PATH, undefined, undefined, { signal }), /cancelled/);
    assert.equal(calls.length, 0);
  });

  test('cancelling during a retry wait stops further attempts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = new O2Client(loadConfig(TEST_ENV), {
      fetch: async () => {
        calls += 1;
        return { ok: false, status: 503, headers: new Headers(), text: async () => 'down' };
      },
      sleep: async () => controller.abort(),
    });
    await assert.rejects(() => client.request('GET', PATH, undefined, undefined, { signal: controller.signal }), /cancelled/);
    assert.equal(calls, 1);
  });
});

describe('the default retry wait', () => {
  const busy = (retryAfter) => async () => ({
    ok: false,
    status: 503,
    headers: new Headers({ 'retry-after': retryAfter }),
    text: async () => 'down',
  });

  test('waits, then tries again', async () => {
    let calls = 0;
    const fetch = async (...args) => {
      calls += 1;
      return busy('0')(...args);
    };
    const client = new O2Client(loadConfig({ ...TEST_ENV, O2_MAX_RETRIES: '1' }), { fetch });
    await assert.rejects(() => client.request('GET', PATH), /gave up after 2 attempts/);
    assert.equal(calls, 2);
  });

  test('ends early when the call is cancelled', async () => {
    const client = new O2Client(loadConfig(TEST_ENV), { fetch: busy('4') });
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.request('GET', PATH, undefined, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, /cancelled/);
    assert.ok(Date.now() - started < 2000, 'must not sit out the 4 second wait');
  });
});

describe('redirects', () => {
  test('asks fetch not to follow redirects', async () => {
    let seen;
    const client = new O2Client(loadConfig(TEST_ENV), {
      fetch: async (_url, init) => {
        seen = init.redirect;
        return { ok: true, status: 200, headers: new Headers(), text: async () => '{}' };
      },
    });
    await client.request('GET', PATH);
    assert.equal(seen, 'manual');
  });

  test('reports a redirect without following it or echoing its query string', async () => {
    const { client, calls } = makeClient(
      reply({ status: 302, text: '', headers: { location: 'https://login.example.com/sso?ticket=abc123' } }),
    );
    await assert.rejects(
      () => client.request('GET', PATH),
      (e) => /redirected/.test(e.message) && /login\.example\.com\/sso/.test(e.message) && !e.message.includes('abc123'),
    );
    assert.equal(calls.length, 1);
  });
});

describe('response body limits', () => {
  const streamed = (chunks, headers = {}) =>
    new O2Client(loadConfig(TEST_ENV), {
      fetch: async () => new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: 200, headers },
      ),
    });

  test('refuses a declared Content-Length above the limit', async () => {
    const { client } = makeClient(
      reply({ text: '{}', headers: { 'content-length': String(LIMITS.MAX_RESPONSE_BYTES + 1) } }),
    );
    await assert.rejects(() => client.request('GET', PATH), /read limit/);
  });

  test('stops reading a stream that grows past the limit', async () => {
    const chunk = new Uint8Array(LIMITS.MAX_RESPONSE_BYTES / 2 + 1);
    await assert.rejects(() => streamed([chunk, chunk]).request('GET', PATH), /read limit/);
  });

  test('decodes a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"msg":"日本"}');
    const client = streamed([bytes.slice(0, 9), bytes.slice(9)]);
    assert.deepEqual(await client.request('GET', PATH), { msg: '日本' });
  });
});

describe('actionable errors', () => {
  test('names the underlying network failure', async () => {
    const { client } = makeClient(networkError('ENOTFOUND'));
    await assert.rejects(() => client.request('GET', PATH), /fetch failed \(ENOTFOUND\)/);
  });

  test('explains a login page returned with status 200', async () => {
    const { client } = makeClient(reply({ text: '<html>sign in</html>' }));
    await assert.rejects(() => client.request('GET', PATH), /non-JSON.*O2_BASE_URL/);
  });

  test('points a rejected query at the schema tool', async () => {
    const { client } = makeClient(reply({ status: 400, text: 'No field named x' }));
    await assert.rejects(() => client.request('GET', PATH), /No field named x.*o2_stream_schema/);
  });

  test('removes the credential and secrets from upstream error text', async () => {
    const text = `bad header ${TEST_ENV.O2_AUTH} password=hunter2`;
    const { client } = makeClient(reply({ status: 500, text }));
    await assert.rejects(
      () => client.request('GET', PATH),
      (e) => !e.message.includes('ZHVtbXk') && !e.message.includes('hunter2') && !String(e.body).includes('hunter2'),
    );
  });
});
