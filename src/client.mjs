// HTTP transport for the OpenObserve API.
//
// Every outbound request is checked against an allowlist of three read
// endpoints. This is enforced in-process and does not depend on the
// privileges of the supplied credential.

export class O2Error extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'O2Error';
    this.status = status;
    this.body = body;
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

export class O2Client {
  /**
   * @param {ReturnType<import('./config.mjs').loadConfig>} config
   * @param {{ fetch?: typeof globalThis.fetch }} [deps] injectable for tests
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.allowlist = buildAllowlist(config.apiPrefix);
  }

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path absolute path including the api prefix
   * @param {Record<string, string|number>} [query]
   * @param {unknown} [body]
   */
  async request(method, path, query, body) {
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

    // The timeout signal stays armed while the body is read, so both the
    // request and the body read can fail with it; both must map to O2Error or
    // a slow response surfaces as an opaque "Unexpected error".
    let res;
    let text;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.config.auth,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      throw this.transportError(e, `cannot reach OpenObserve at ${this.config.origin}`);
    }
    try {
      text = await res.text();
    } catch (e) {
      throw this.transportError(e, 'connection to OpenObserve was interrupted while reading the response');
    }

    if (!res.ok) {
      throw new O2Error(explainStatus(res.status, text), { status: res.status, body: text.slice(0, 500) });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new O2Error(`OpenObserve returned a non-JSON response (HTTP ${res.status})`, { status: res.status });
    }
  }

  /** Map a fetch/body-read failure to an O2Error. */
  transportError(e, prefix) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return new O2Error(`request to OpenObserve timed out after ${this.config.timeoutMs}ms`);
    }
    return new O2Error(`${prefix}: ${e?.message || e}`);
  }
}

function explainStatus(status, text) {
  const snippet = text.slice(0, 300);
  if (status === 401) return 'OpenObserve rejected the credential (401). Check O2_AUTH.';
  if (status === 403) return `OpenObserve denied access (403). The user may lack permission for this stream or org. ${snippet}`;
  if (status === 404) return `Not found (404). Check O2_ORG and the stream name. ${snippet}`;
  return `OpenObserve ${status}: ${snippet}`;
}
