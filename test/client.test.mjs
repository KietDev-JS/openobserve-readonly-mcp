import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, reply, TEST_ENV } from './helpers.mjs';
import { O2Error } from '../src/client.mjs';

describe('endpoint allowlist', () => {
  test('permits the three read endpoints', async () => {
    const { client } = makeClient({ ok: true });
    await assert.doesNotReject(() => client.request('GET', '/api/default/streams'));
    await assert.doesNotReject(() => client.request('GET', '/api/default/streams/app/schema'));
    await assert.doesNotReject(() => client.request('POST', '/api/default/_search', {}, { query: {} }));
  });

  test('blocks every other path', async () => {
    const { client, calls } = makeClient({ ok: true });
    const blocked = [
      ['GET', '/api/default/users'],
      ['POST', '/api/default/streams'],
      ['DELETE', '/api/default/streams/app'],
      ['GET', '/api/default/streams/app/settings'],
      ['POST', '/api/default/streams/app/delete'],
      ['GET', '/api/other/streams'],
      ['GET', '/'],
      ['POST', '/api/default/_bulk'],
      ['GET', '/api/default/streams/../../admin'],
    ];
    for (const [m, p] of blocked) {
      await assert.rejects(() => client.request(m, p), O2Error, `${m} ${p} must be blocked`);
    }
    assert.equal(calls.length, 0, 'no blocked request may reach the network');
  });

  test('blocks writes even though the credential may allow them', async () => {
    // The allowlist is the guarantee; it does not depend on the token's role.
    const { client } = makeClient({ ok: true });
    await assert.rejects(() => client.request('POST', '/api/default/streams/app/_json'), O2Error);
  });

  test('allowlist follows a reverse-proxy subpath', async () => {
    const env = { ...TEST_ENV, O2_BASE_URL: 'https://o2.example.com/observe' };
    const { client, calls } = makeClient({ ok: true }, env);
    await client.request('GET', '/observe/api/default/streams');
    assert.equal(calls[0].url.pathname, '/observe/api/default/streams');
    // The unprefixed path must not be accepted when a mount path is configured.
    await assert.rejects(() => client.request('GET', '/api/default/streams'), O2Error);
  });

  test('allowlist follows a custom org', async () => {
    const env = { ...TEST_ENV, O2_ORG: 'team-a' };
    const { client } = makeClient({ ok: true }, env);
    await assert.doesNotReject(() => client.request('GET', '/api/team-a/streams'));
    await assert.rejects(() => client.request('GET', '/api/default/streams'), O2Error);
  });
});

describe('request construction', () => {
  test('sends the Authorization header', async () => {
    const { client, calls } = makeClient({ ok: true });
    await client.request('GET', '/api/default/streams');
    assert.equal(calls[0].headers.Authorization, TEST_ENV.O2_AUTH);
  });

  test('sets Content-Type only when there is a body', async () => {
    const { client, calls } = makeClient({ ok: true });
    await client.request('GET', '/api/default/streams');
    assert.equal(calls[0].headers['Content-Type'], undefined);
    await client.request('POST', '/api/default/_search', {}, { query: {} });
    assert.equal(calls[1].headers['Content-Type'], 'application/json');
  });

  test('appends query parameters', async () => {
    const { client, calls } = makeClient({ ok: true });
    await client.request('GET', '/api/default/streams/app/schema', { type: 'logs' });
    assert.equal(calls[0].url.searchParams.get('type'), 'logs');
  });
});

describe('error reporting', () => {
  test('explains 401 without echoing the credential', async () => {
    const { client } = makeClient(reply({ status: 401, text: 'unauthorized' }));
    await assert.rejects(
      () => client.request('GET', '/api/default/streams'),
      (e) => e instanceof O2Error && /401/.test(e.message) && !e.message.includes('ZHVtbXk'),
    );
  });

  test('explains 403 and 404', async () => {
    for (const [status, re] of [[403, /denied/i], [404, /not found/i]]) {
      const { client } = makeClient(reply({ status, text: 'x' }));
      await assert.rejects(() => client.request('GET', '/api/default/streams'), (e) => re.test(e.message));
    }
  });

  test('surfaces upstream 400 detail', async () => {
    const { client } = makeClient(reply({ status: 400, text: '{"message":"Search SQL execute error"}' }));
    await assert.rejects(() => client.request('GET', '/api/default/streams'), /Search SQL execute error/);
  });

  test('reports non-JSON responses clearly', async () => {
    const { client } = makeClient(reply({ text: '<html>proxy error</html>' }));
    await assert.rejects(() => client.request('GET', '/api/default/streams'), /non-JSON/);
  });

  test('reports connection failures with the target host', async () => {
    const { client } = makeClient(() => new Error('ECONNREFUSED'));
    await assert.rejects(() => client.request('GET', '/api/default/streams'), /cannot reach OpenObserve/);
  });

  test('reports timeouts distinctly', async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    const { client } = makeClient(() => err);
    await assert.rejects(() => client.request('GET', '/api/default/streams'), /timed out/);
  });

  test('truncates oversized error bodies', async () => {
    const { client } = makeClient(reply({ status: 500, text: 'e'.repeat(10_000) }));
    await assert.rejects(
      () => client.request('GET', '/api/default/streams'),
      (e) => e.message.length < 600,
    );
  });
});
