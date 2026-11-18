import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError, insecureTransportWarning, redact } from '../src/config.mjs';

const BASE = { O2_BASE_URL: 'https://o2.example.com', O2_AUTH: 'Basic ZHVtbXk6ZHVtbXk=' };

describe('loadConfig requires explicit configuration', () => {
  test('refuses to start without a base URL', () => {
    // No default host: guessing where to send credentials is worse than failing.
    assert.throws(() => loadConfig({ O2_AUTH: BASE.O2_AUTH }), ConfigError);
  });

  test('refuses to start without credentials', () => {
    assert.throws(() => loadConfig({ O2_BASE_URL: BASE.O2_BASE_URL }), ConfigError);
  });

  test('rejects a malformed credential', () => {
    assert.throws(() => loadConfig({ ...BASE, O2_AUTH: 'ZHVtbXk=' }), ConfigError);
  });

  test('accepts Basic and Bearer', () => {
    assert.ok(loadConfig({ ...BASE, O2_AUTH: 'Basic abc' }).auth);
    assert.ok(loadConfig({ ...BASE, O2_AUTH: 'Bearer abc' }).auth);
  });

  test('does not read the ambient process environment', () => {
    // Config comes from the passed mapping only, so a stray global cannot
    // silently point the server somewhere unexpected.
    assert.throws(() => loadConfig({}), ConfigError);
  });
});

describe('loadConfig base URL handling', () => {
  test('builds the api prefix for a plain host', () => {
    const c = loadConfig(BASE);
    assert.equal(c.origin, 'https://o2.example.com');
    assert.equal(c.apiPrefix, '/api/default/streams'.replace('/streams', ''));
  });

  test('tolerates a trailing slash', () => {
    assert.equal(loadConfig({ ...BASE, O2_BASE_URL: 'https://o2.example.com/' }).apiPrefix, '/api/default');
  });

  test('preserves a reverse-proxy subpath', () => {
    // Regression: subpath deployments were rejected outright.
    const c = loadConfig({ ...BASE, O2_BASE_URL: 'https://o2.example.com/observe' });
    assert.equal(c.basePath, '/observe');
    assert.equal(c.apiPrefix, '/observe/api/default');
  });

  test('keeps a non-default port', () => {
    assert.equal(loadConfig({ ...BASE, O2_BASE_URL: 'http://localhost:5080' }).origin, 'http://localhost:5080');
  });

  test('rejects non-http schemes', () => {
    assert.throws(() => loadConfig({ ...BASE, O2_BASE_URL: 'ftp://o2.example.com' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE, O2_BASE_URL: 'file:///etc/passwd' }), ConfigError);
  });

  test('rejects a URL with a query or fragment', () => {
    assert.throws(() => loadConfig({ ...BASE, O2_BASE_URL: 'https://o2.example.com/?a=1' }), ConfigError);
  });

  test('rejects a malformed URL', () => {
    assert.throws(() => loadConfig({ ...BASE, O2_BASE_URL: 'not a url' }), ConfigError);
  });
});

describe('loadConfig org and numeric settings', () => {
  test('defaults the org to "default"', () => {
    assert.equal(loadConfig(BASE).org, 'default');
  });

  test('rejects an org containing path separators', () => {
    for (const org of ['a/b', '../x', 'a b', 'a.b']) {
      assert.throws(() => loadConfig({ ...BASE, O2_ORG: org }), ConfigError, `should reject ${org}`);
    }
  });

  test('defaults the window to 1440 minutes', () => {
    assert.equal(loadConfig(BASE).maxWindowMin, 1440);
  });

  test('accepts an overridden window', () => {
    assert.equal(loadConfig({ ...BASE, O2_MAX_WINDOW_MIN: '60' }).maxWindowMin, 60);
  });

  test('rejects a non-positive or fractional window', () => {
    for (const v of ['0', '-5', 'abc', '1.5']) {
      assert.throws(() => loadConfig({ ...BASE, O2_MAX_WINDOW_MIN: v }), ConfigError, `should reject ${v}`);
    }
  });
});

describe('loadConfig protects credentials in the base URL', () => {
  test('rejects a URL with embedded credentials', () => {
    assert.throws(() => loadConfig({ ...BASE, O2_BASE_URL: 'https://user:hunter2@o2.example.com' }), /must not contain credentials/);
  });

  test('does not echo a malformed URL, which may hold a password', () => {
    assert.throws(
      () => loadConfig({ ...BASE, O2_BASE_URL: 'https://user:hunter2@ bad host' }),
      (e) => e instanceof ConfigError && !e.message.includes('hunter2'),
    );
  });
});

describe('loadConfig retry, timeout and redaction settings', () => {
  test('defaults to two retries and redaction on', () => {
    const c = loadConfig(BASE);
    assert.equal(c.maxRetries, 2);
    assert.equal(c.redactSecrets, true);
  });

  test('accepts O2_MAX_RETRIES from 0 to 5', () => {
    assert.equal(loadConfig({ ...BASE, O2_MAX_RETRIES: '0' }).maxRetries, 0);
    assert.equal(loadConfig({ ...BASE, O2_MAX_RETRIES: '5' }).maxRetries, 5);
  });

  test('rejects an invalid O2_MAX_RETRIES', () => {
    for (const v of ['-1', '6', '1.5', 'abc']) {
      assert.throws(() => loadConfig({ ...BASE, O2_MAX_RETRIES: v }), ConfigError, `should reject ${v}`);
    }
  });

  test('rejects a timeout too large for a timer', () => {
    assert.throws(() => loadConfig({ ...BASE, O2_TIMEOUT_MS: '2147483648' }), ConfigError);
  });

  test('O2_REDACT accepts on and off only', () => {
    assert.equal(loadConfig({ ...BASE, O2_REDACT: 'OFF' }).redactSecrets, false);
    assert.equal(loadConfig({ ...BASE, O2_REDACT: 'on' }).redactSecrets, true);
    assert.throws(() => loadConfig({ ...BASE, O2_REDACT: 'maybe' }), ConfigError);
  });
});

describe('insecureTransportWarning', () => {
  test('warns about plain http to a remote host', () => {
    const c = loadConfig({ ...BASE, O2_BASE_URL: 'http://o2.example.com' });
    assert.match(insecureTransportWarning(c), /unencrypted/);
  });

  test('stays quiet for https and loopback', () => {
    for (const url of ['https://o2.example.com', 'http://localhost:5080', 'http://127.0.0.1:5080', 'http://[::1]:5080']) {
      assert.equal(insecureTransportWarning(loadConfig({ ...BASE, O2_BASE_URL: url })), null, url);
    }
  });
});

describe('redact', () => {
  test('hides the credential', () => {
    const r = redact(loadConfig(BASE));
    assert.equal(r.auth, '<redacted>');
    assert.ok(!JSON.stringify(r).includes('ZHVtbXk'));
  });
});
