// HTTP transport for the OpenObserve API.
//
// Every outbound request is checked against an allowlist of three read
// endpoints. This is enforced in-process and does not depend on the
// privileges of the supplied credential.

import { LIMITS } from './config.mjs';
import { REDACTED, redactText } from './sanitize.mjs';

/** Upstream statuses that usually clear up on their own. 500 is excluded: it often reports a failed query. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Connection failures worth another attempt. DNS and TLS failures are not. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export class O2Error extends Error {
  constructor(message, { status, body, retryable = false, retryAfterMs, cancelled = false } = {}) {
    super(message);
    this.name = 'O2Error';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.cancelled = cancelled;
  }
}

/**
 * Build the allowlist for a given API prefix.
 * The prefix is escaped because it may contain a reverse-proxy mount path.
 */
function buildAllowlist(apiPrefix) {
  const p = apiPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ['GET', new RegExp(`^${p}/streams$`)],
    ['GET', new RegExp(`^${p}/streams/[A-Za-z0-9_][A-Za-z0-9_.-]*/schema$`)],
    ['POST', new RegExp(`^${p}/_search$`)],
  ];
}

/** Wait for `ms`, resolving early on cancellation so the caller can stop. */
function sleepFor(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export class O2Client {
  /**
   * @param {ReturnType<import('./config.mjs').loadConfig>} config
   * @param {{ fetch?: typeof globalThis.fetch, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} [deps]
   *   injectable for tests
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? sleepFor;
    this.allowlist = buildAllowlist(config.apiPrefix);
  }

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path absolute path including the api prefix
   * @param {Record<string, string|number>} [query]
   * @param {unknown} [body]
   * @param {{ signal?: AbortSignal }} [options] signal cancels the call, including any retry wait
   */
  async request(method, path, query, body, { signal } = {}) {
    if (!this.allowlist.some(([m, re]) => m === method && re.test(path))) {
      throw new O2Error(`blocked request: ${method} ${path} is not a permitted read endpoint`);
    }

    const url = new URL(this.config.origin);
    url.pathname = path;
    // Reject anything the URL parser rewrites (traversal, encoded separators):
    // the allowlist checked `path`, so the sent path must match it exactly.
    if (url.pathname !== path) {
      throw new O2Error(`blocked request: path changed on normalization (${path} -> ${url.pathname})`);
    }
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));

    // O2_TIMEOUT_MS bounds the whole call, retries and waits included.
    const deadline = Date.now() + this.config.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(method, url, body, deadline - Date.now(), signal);
      } catch (e) {
        const delay = this.retryDelay(e, attempt, deadline);
        if (delay === null) {
          if (attempt > 0 && e instanceof O2Error) e.message += ` (gave up after ${attempt + 1} attempts)`;
          throw e;
        }
        await this.sleep(delay, signal);
      }
    }
  }

  /** Milliseconds to wait before retrying, or null when the error is final. */
  retryDelay(e, attempt, deadline) {
    if (!e?.retryable || attempt >= this.config.maxRetries) return null;
    const backoff = LIMITS.RETRY_BASE_MS * 2 ** attempt * (0.75 + Math.random() / 2);
    const delay = e.retryAfterMs ?? backoff;
    if (delay > LIMITS.MAX_RETRY_DELAY_MS || delay >= deadline - Date.now()) return null;
    return delay;
  }

  /** Make one HTTP attempt within the remaining time budget. */
  async attempt(method, url, body, budgetMs, signal) {
    const cancelled = () => new O2Error('request was cancelled by the client', { cancelled: true });
    if (signal?.aborted) throw cancelled();

    // AbortSignal.any needs Node 20.3 and this package supports 18.17, so the
    // timeout and the caller's cancellation share one controller by hand. It
    // stays armed during the body read, so a slow body also maps to O2Error.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, budgetMs));
    const onCancel = () => controller.abort();
    signal?.addEventListener('abort', onCancel, { once: true });

    const failure = (e, prefix) => {
      if (signal?.aborted) return cancelled();
      if (timedOut) return this.timeoutError();
      return this.transportError(e, prefix);
    };

    try {
      let res;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: this.config.auth,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          // Following a redirect would send the credential to a path the
          // allowlist never checked.
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (e) {
        throw failure(e, `cannot reach OpenObserve at ${this.config.origin}`);
      }

      let text;
      try {
        text = await readBounded(res);
      } catch (e) {
        if (e instanceof O2Error) throw e;
        throw failure(e, 'connection to OpenObserve was interrupted while reading the response');
      }

      if (!res.ok) throw this.statusError(res, text, url);
      try {
        return JSON.parse(text);
      } catch {
        throw new O2Error(
          `OpenObserve returned a non-JSON response (HTTP ${res.status}). ` +
            'O2_BASE_URL may point at a login page or a proxy instead of the OpenObserve API.',
          { status: res.status },
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
    }
  }

  /** Remove the configured credential and secret-shaped text from a message. */
  scrub(text) {
    const token = this.config.auth.split(/\s+/)[1];
    return redactText(token ? String(text).split(token).join(REDACTED) : String(text));
  }

  timeoutError() {
    return new O2Error(
      `request to OpenObserve timed out after ${this.config.timeoutMs}ms. ` +
        'Narrow the time window, lower size, or raise O2_TIMEOUT_MS.',
    );
  }

  /** Map a fetch/body-read failure to an O2Error. */
  transportError(e, prefix) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return this.timeoutError();
    // fetch reports every network failure as "fetch failed"; the reason is on `cause`.
    const code = e?.code ?? e?.cause?.code;
    const detail = `${e?.message || e}${code ? ` (${code})` : ''}`;
    return new O2Error(this.scrub(`${prefix}: ${detail}`), { retryable: RETRYABLE_CODES.has(code) });
  }

  /** Map a non-2xx response to an O2Error. */
  statusError(res, text, url) {
    const snippet = this.scrub(text.slice(0, LIMITS.SCAN_CHARS)).slice(0, 300);
    return new O2Error(explainStatus(res.status, snippet, redirectTarget(res, url)), {
      status: res.status,
      body: snippet,
      retryable: RETRYABLE_STATUS.has(res.status),
      retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')),
    });
  }
}

/**
 * Read a response body, refusing to buffer more than MAX_RESPONSE_BYTES.
 * The output budget applies only after parsing, so without this a misbehaving
 * upstream could exhaust the process's memory.
 */
async function readBounded(res) {
  const max = LIMITS.MAX_RESPONSE_BYTES;
  const tooLarge = () =>
    new O2Error(
      `OpenObserve response exceeded the ${Math.round(max / 1_048_576)} MB read limit. ` +
        'Select fewer columns, lower size, or narrow the time window.',
      { status: res.status },
    );

  if (Number(res.headers?.get?.('content-length')) > max) {
    await res.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  if (!res.body?.getReader) return res.text();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    received += value.byteLength;
    if (received > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Parse Retry-After (seconds or HTTP date) to milliseconds. */
function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** The redirect destination without its query string, which may carry tokens. */
function redirectTarget(res, url) {
  const location = res.headers?.get?.('location');
  if (!location) return undefined;
  try {
    const target = new URL(location, url);
    return `${target.origin}${target.pathname}`;
  } catch {
    return undefined;
  }
}

function explainStatus(status, snippet, location) {
  if (status >= 300 && status < 400) {
    return (
      `OpenObserve redirected the request (${status}${location ? ` to ${location}` : ''}). Redirects are not followed. ` +
      'Set O2_BASE_URL to the final address; a redirect to a login page means a proxy is rejecting the request.'
    );
  }
  if (status === 400) {
    return `OpenObserve rejected the request (400): ${snippet} Check the SQL; o2_stream_schema lists valid column names.`;
  }
  if (status === 401) return 'OpenObserve rejected the credential (401). Check O2_AUTH.';
  if (status === 403) return `OpenObserve denied access (403). The user may lack permission for this stream or org. ${snippet}`;
  if (status === 404) return `Not found (404). Check O2_ORG and the stream name. ${snippet}`;
  if (status === 429) return `OpenObserve is rate limiting requests (429). Wait before retrying. ${snippet}`;
  if (status === 502 || status === 503 || status === 504) {
    return `OpenObserve is temporarily unavailable (${status}). Try again shortly, or narrow the query. ${snippet}`;
  }
  return `OpenObserve ${status}: ${snippet}`;
}
