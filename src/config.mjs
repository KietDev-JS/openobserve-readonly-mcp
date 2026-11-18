// Configuration, read once from the environment.
//
// There is deliberately no default base URL: pointing a log-search tool at a
// guessed host is worse than refusing to start.

/** Hard caps. These bound what a single tool call can return. */
export const LIMITS = {
  /** Max rows returned by o2_search. */
  MAX_ROWS: 200,
  /** Max streams returned by o2_list_streams. */
  MAX_STREAMS: 500,
  /** Strings longer than this are clipped, at any nesting depth. */
  MAX_CELL: 500,
  /** Max serialized bytes of a single tool result. */
  MAX_OUT: 60_000,
  /** Default look-back when no window is given. */
  DEFAULT_MINUTES: 15,
  /** Default row count for o2_search. */
  DEFAULT_SIZE: 50,
  /** Default stream count for o2_list_streams. */
  DEFAULT_STREAMS: 100,
  /** Upstream time limit for one tool call, retries included. */
  TIMEOUT_MS: 60_000,
  /** Deepest row or stream offset a page may start from. */
  MAX_OFFSET: 10_000,
  /** Longest accepted SQL statement, in characters. */
  MAX_SQL: 65_536,
  /** Largest upstream response body that will be buffered. */
  MAX_RESPONSE_BYTES: 32 * 1_048_576,
  /** Characters of one string that are scanned for secrets. */
  SCAN_CHARS: 16_384,
  /** Default retries after a transient upstream failure. */
  RETRIES: 2,
  /** Upper bound for O2_MAX_RETRIES. */
  MAX_RETRIES: 5,
  /** First retry delay; doubles on each attempt. */
  RETRY_BASE_MS: 250,
  /** Longest wait between attempts, including a server's Retry-After. */
  MAX_RETRY_DELAY_MS: 5_000,
};

/** Largest delay setTimeout honours; anything above it fires immediately. */
const MAX_TIMER_MS = 2_147_483_647;

export const STREAM_TYPES = ['logs', 'metrics', 'traces'];

/** OpenObserve org identifiers are path segments, so keep them strict. */
const ORG_RE = /^[A-Za-z0-9_-]+$/;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Build config from an environment mapping.
 *
 * Takes the env as an argument rather than reading `process.env` directly so
 * tests can exercise it without mutating global state.
 *
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const rawBase = (env.O2_BASE_URL || '').trim();
  if (!rawBase) {
    throw new ConfigError(
      'O2_BASE_URL is not set. Point it at your OpenObserve instance, e.g. https://openobserve.example.com',
    );
  }

  let baseUrl;
  try {
    baseUrl = new URL(rawBase);
  } catch {
    // The value is not echoed: a malformed URL may still contain a password.
    throw new ConfigError('O2_BASE_URL is not a valid URL. Expected a form like https://openobserve.example.com');
  }
  if (baseUrl.username || baseUrl.password) {
    throw new ConfigError('O2_BASE_URL must not contain credentials. Put them in O2_AUTH.');
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new ConfigError(`O2_BASE_URL must be http or https, got ${baseUrl.protocol}`);
  }
  if (baseUrl.search || baseUrl.hash) {
    throw new ConfigError('O2_BASE_URL must not contain a query string or fragment');
  }

  // Keep any mount path (reverse proxies often serve OpenObserve under a
  // subpath) but drop the trailing slash so joining with "/api/..." is exact.
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  baseUrl.pathname = '/';

  const org = (env.O2_ORG || 'default').trim();
  if (!ORG_RE.test(org)) {
    throw new ConfigError(`O2_ORG must match ${ORG_RE} , got: ${org}`);
  }

  const auth = (env.O2_AUTH || '').trim();
  if (!auth) {
    throw new ConfigError(
      'O2_AUTH is not set. Expected "Basic <base64 of email:password>". ' +
        'Use a read-only OpenObserve user: this server restricts itself to read endpoints, ' +
        'but it cannot reduce the privileges of the credential you give it.',
    );
  }
  if (!/^Basic\s+\S+$/.test(auth) && !/^Bearer\s+\S+$/.test(auth)) {
    throw new ConfigError('O2_AUTH must look like "Basic <token>" or "Bearer <token>".');
  }

  const maxWindowMin = positiveInt(env.O2_MAX_WINDOW_MIN, 1440, 'O2_MAX_WINDOW_MIN');
  const timeoutMs = positiveInt(env.O2_TIMEOUT_MS, LIMITS.TIMEOUT_MS, 'O2_TIMEOUT_MS');
  if (timeoutMs > MAX_TIMER_MS) {
    throw new ConfigError(`O2_TIMEOUT_MS must be at most ${MAX_TIMER_MS}, got: ${timeoutMs}`);
  }
  const maxRetries = retryCount(env.O2_MAX_RETRIES);
  const redactSecrets = redactSetting(env.O2_REDACT);

  return {
    origin: baseUrl.origin,
    basePath,
    org,
    auth,
    maxWindowMin,
    timeoutMs,
    maxRetries,
    redactSecrets,
    /** Full prefix for API paths, including any reverse-proxy mount path. */
    apiPrefix: `${basePath}/api/${org}`,
  };
}

function positiveInt(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function retryCount(raw) {
  if (raw === undefined || String(raw).trim() === '') return LIMITS.RETRIES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > LIMITS.MAX_RETRIES) {
    throw new ConfigError(`O2_MAX_RETRIES must be an integer from 0 to ${LIMITS.MAX_RETRIES}, got: ${raw}`);
  }
  return n;
}

function redactSetting(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'on') return true;
  if (v === 'off') return false;
  throw new ConfigError(`O2_REDACT must be "on" or "off", got: ${raw}`);
}

/**
 * Warn when the credential would cross a network unencrypted.
 *
 * @param {{ origin: string }} config
 * @returns {string | null}
 */
export function insecureTransportWarning(config) {
  const { protocol, hostname } = new URL(config.origin);
  if (protocol !== 'http:') return null;
  if (hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.')) return null;
  return `O2_BASE_URL uses plain http, so O2_AUTH is sent unencrypted to ${hostname}. Use https.`;
}

/** Redact the credential so config can be logged safely. */
export function redact(config) {
  return { ...config, auth: config.auth ? '<redacted>' : '' };
}
