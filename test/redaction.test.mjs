import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, TEST_ENV } from '../test-utils/helpers.mjs';
import { REDACTED, isSensitiveKey, redactText, shapeRow } from '../src/sanitize.mjs';

// Fixtures are assembled at runtime so no credential-shaped literal is stored
// in the repository, where secret scanners would rightly flag it.
const filler = (n) => 'Ab1'.repeat(Math.ceil(n / 3)).slice(0, n);

describe('redactText removes secrets from free text', () => {
  const cases = [
    ['key=value', 'login password=hunter2 ok', 'hunter2'],
    ['key: value', 'api_key: abc123def', 'abc123def'],
    ['JSON pair', '{"client_secret":"s3cr3t value"}', 's3cr3t value'],
    ['escaped JSON pair', '{\\"password\\":\\"hunter2\\"}', 'hunter2'],
    ['single quoted value', "password='two words'", 'two words'],
    ['authorization header', 'Authorization: Bearer abc.def123', 'abc.def123'],
    ['bare bearer token', 'sent Bearer abcDEF123456', 'abcDEF123456'],
    ['bare basic credential', 'sent Basic ZHVtbXk6ZHVtbXk=', 'ZHVtbXk6ZHVtbXk='],
    ['connection string', 'postgres://app:hunter2@db.example.com/main', 'hunter2'],
    ['cookie header', 'Cookie: session=abc123; theme=dark', 'abc123'],
    ['JWT', `token ${['eyJhbGciOi', 'eyJzdWIiOiIx', 'c2lnbmF0dXJl'].join('.')}`, 'c2lnbmF0dXJl'],
    ['AWS access key', `key ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`, 'ABCDEFGHIJKLMNOP'],
    ['GitHub token', `using ${'ghp_'}${filler(36)}`, filler(36)],
    ['Slack token', `using ${'xoxb-'}${filler(24)}`, filler(24)],
    ['sk- key', `using ${'sk-'}${filler(32)}`, filler(32)],
  ];
  for (const [name, input, secret] of cases) {
    test(name, () => {
      const out = redactText(input);
      assert.ok(!out.includes(secret), `leaked: ${out}`);
      assert.ok(out.includes(REDACTED));
    });
  }

  test('private key block, with or without its footer', () => {
    const label = ['PRIVATE', 'KEY'].join(' ');
    const block = `-----BEGIN ${label}-----\nMIIEvQIBADANBg\n-----END ${label}-----`;
    assert.equal(redactText(`a ${block} b`), `a ${REDACTED} b`);
    assert.equal(redactText(`-----BEGIN ${label}-----\nMIIEvQIBADANBg`), REDACTED);
  });
});

describe('redactText leaves ordinary log text alone', () => {
  const unchanged = [
    'connection refused by upstream',
    'Basic Authentication failed for user',
    'Bearer token is missing',
    'the secret to success',
    'tokens used by the model',
    'https://example.com/path?page=2',
    'password reset email sent',
  ];
  for (const text of unchanged) {
    test(text, () => assert.equal(redactText(text), text));
  }
});

describe('isSensitiveKey', () => {
  test('recognizes common credential field names', () => {
    for (const key of ['password', 'DB_PASSWORD', 'accessToken', 'X-Api-Key', 'apikey', 'client.secret', 'set-cookie', 'headers_authorization']) {
      assert.equal(isSensitiveKey(key), true, key);
    }
  });

  test('ignores names that merely contain a sensitive word', () => {
    for (const key of ['token_count', 'password_changed_at', 'secret_name', 'author', 'message']) {
      assert.equal(isSensitiveKey(key), false, key);
    }
  });
});

describe('shapeRow', () => {
  test('hides sensitive fields at any depth', () => {
    const out = shapeRow({ user: 'a', auth: { password: 'hunter2' }, list: [{ apiKey: 'abc' }] });
    assert.deepEqual(out, { user: 'a', auth: { password: REDACTED }, list: [{ apiKey: REDACTED }] });
  });

  test('hides an object stored under a sensitive field', () => {
    assert.deepEqual(shapeRow({ cookies: { sid: 'abc' } }), { cookies: REDACTED });
  });

  test('keeps numbers, booleans, nulls and empty strings under sensitive names', () => {
    const row = { token: 12, password: null, secret: false, api_key: '' };
    assert.deepEqual(shapeRow(row), row);
  });

  test('redacts before clipping so a secret at the clip boundary cannot leak', () => {
    const secret = 'hunter2-long-value';
    const text = `${'x'.repeat(480)} password=${secret} ${'y'.repeat(600)}`;
    const out = shapeRow({ msg: text }).msg;
    assert.ok(!out.includes('hunter2'));
    assert.ok(out.includes(`+${text.length - 500} chars`));
  });

  test('bounds the work done on a huge string', () => {
    const out = shapeRow({ msg: 'password=a '.repeat(500_000) }).msg;
    assert.ok(out.length < 600);
  });

  test('redact: false only clips', () => {
    assert.deepEqual(shapeRow({ password: 'hunter2' }, { redact: false }), { password: 'hunter2' });
  });
});

describe('o2_search redaction', () => {
  const body = { hits: [{ password: 'hunter2', msg: 'Authorization: Bearer abc.def123' }] };

  test('is on by default', async () => {
    const { handlers } = makeClient(body);
    const text = JSON.stringify(await handlers.o2_search({ sql: 'SELECT 1' }));
    assert.ok(!text.includes('hunter2'));
    assert.ok(!text.includes('abc.def123'));
  });

  test('O2_REDACT=off returns rows as stored', async () => {
    const { handlers } = makeClient(body, { ...TEST_ENV, O2_REDACT: 'off' });
    const result = await handlers.o2_search({ sql: 'SELECT 1' });
    assert.equal(result.hits[0].password, 'hunter2');
  });
});
