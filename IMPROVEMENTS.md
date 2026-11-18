# Improvements: openobserve-readonly-mcp

> Snapshot from the review before the 1.2.0 release. Items marked as open may since have been resolved.

Review of the published 1.1.0 code, carried out on 2026-11-18. Nothing here has
been committed, pushed or published, and the package version is unchanged.

## Summary

- 20 of the 31 ideas below are implemented. All tool names and existing
  arguments still work, and there are still no runtime dependencies.
- The test suite grew from 149 to 253 tests, and all of them pass on Node 26.7.0.
- The most serious finding was a bypass of the SQL validator (S1). It is fixed.
- **Not checked:** a real OpenObserve server, Node 18 to 24, Linux and macOS, and
  an installed copy of the package. See [Not verified](#not-verified).

## Behavior changes to review before release

These are deliberate, but an existing user could notice them.

| Change | Who notices | How to adapt |
| --- | --- | --- |
| Credentials in log rows now appear as `[REDACTED]` | Anyone searching for those values | Set `O2_REDACT=off` |
| Redirects are reported as errors instead of followed | Deployments whose `O2_BASE_URL` redirects, such as `http` to `https` | Set `O2_BASE_URL` to the final address |
| `O2_BASE_URL` containing `user:password@` is refused | Configurations that had it; those credentials were already ignored | Remove them and use `O2_AUTH` |
| SQL with `INTO`, or a backslash before a literal's own quote, is refused | Queries using those forms | Double the quote: `'it''s'` |
| Transient failures are retried twice | Upstreams under heavy load see up to 3 attempts | Set `O2_MAX_RETRIES=0` |

Because of these changes, a minor version bump is more appropriate than a patch.
That decision is yours, so the version was left at 1.1.0.

## Ideas ranked

Ranked by user value first, then by low effort and low risk. Status: **Done** was
implemented in this change, **Open** was not.

### Security

| # | Idea | Value | Effort | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| S1 | Fix SQL validator bypass: `SELECT "'" ; DROP TABLE x ; SELECT "'"` passed validation | High | Low | Low | **Done** |
| S2 | Stop following redirects, which could carry the credential to paths the allowlist never checked | High | Low | Low | **Done** |
| S3 | Redact credentials in log rows before they reach the model | High | Medium | Medium | **Done** |
| S4 | Scrub the credential and secrets from upstream error text | High | Low | Low | **Done** |
| S5 | Refuse `SELECT INTO` and ambiguous backslash-quote literals | Medium | Low | Low | **Done** |
| S6 | Refuse credentials in `O2_BASE_URL`, never echo a malformed URL, warn on remote plain `http` | Medium | Low | Low | **Done** |
| S7 | Optional stream allowlist or denylist (`O2_ALLOWED_STREAMS`) | Medium | Medium | Low | Open |
| S8 | User-defined redaction patterns (`O2_REDACT_PATTERNS`) | Medium | Medium | Medium | Open |
| S9 | Report how many values were redacted in each result | Low | Low | Low | Open |

### Reliability

| # | Idea | Value | Effort | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | Honor `notifications/cancelled` and abort the upstream request | High | Medium | Low | **Done** |
| R2 | Retry 429, 502, 503, 504 and dropped connections with backoff and `Retry-After`, inside the existing timeout | High | Medium | Low | **Done** |
| R3 | Report malformed upstream responses clearly instead of "Unexpected error" | High | Low | Low | **Done** |
| R4 | Cap the upstream body at 32 MB so a bad response cannot exhaust memory | Medium | Low | Low | **Done** |
| R5 | Keep one out-of-range timestamp from failing a whole result | Medium | Low | Low | **Done** |
| R6 | Send whole-number timestamps when `minutes` is fractional | Medium | Low | Low | **Done** |
| R7 | Never answer a notification that carries a request method | Low | Low | Low | **Done** |
| R8 | Limit concurrent upstream searches | Medium | Medium | Low | Open |
| R9 | Return JSON-RPC `-32600` for valid JSON that is not a request object | Low | Low | Low | Open |

### Tool design for AI agents

| # | Idea | Value | Effort | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| A1 | Add `offset`, `has_more` and `next_offset`; rows beyond the first page were unreachable | High | Medium | Low | **Done** |
| A2 | Keep paging correct when rows are shed to fit the 60 KB budget | High | Low | Low | **Done** |
| A3 | Make errors actionable: network cause, redirects, login pages, rejected SQL, reserved words | High | Low | Low | **Done** |
| A4 | Add workflow `instructions` to `initialize` and clearer tool descriptions | Medium | Low | Low | **Done** |
| A5 | Measure the output budget in bytes, as documented, so non-ASCII logs stay within it | Medium | Low | Low | **Done** |
| A6 | Find the largest page that fits instead of halving, which can discard up to half of a page | Medium | Low | Low | Open |
| A7 | Declare `outputSchema` and return `structuredContent` | Medium | Medium | Low | Open |
| A8 | Add a `fields` filter to `o2_stream_schema` for very wide streams | Medium | Low | Low | Open |
| A9 | Add an aggregate helper tool, such as error counts over time | Medium | High | Medium | Open |

### Tests, packaging and documentation

| # | Idea | Value | Effort | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| T1 | Add mocked-HTTP tests for every change above | High | Medium | Low | **Done** |
| T2 | Add a contract test suite against a disposable OpenObserve container in CI | High | High | Low | Open |
| P1 | Add npm provenance and a tag-driven release workflow | Medium | Medium | Low | Open |
| D1 | Document the new settings, limits, paging and troubleshooting; fix `base64` line wrapping in the setup commands | Medium | Low | Low | **Done** |

## What changed

| Area | Files |
| --- | --- |
| Retries, cancellation, redirects, body cap, error messages | `src/client.mjs` |
| Secret redaction, safe timestamps, paging-aware truncation | `src/sanitize.mjs` |
| Validator fix and new refusals | `src/sql.mjs` |
| `offset` paging and response shape checks | `src/tools.mjs` |
| Cancellation, notification handling, `instructions` | `src/server.mjs` |
| `O2_MAX_RETRIES`, `O2_REDACT`, URL checks | `src/config.mjs`, `bin/openobserve-readonly-mcp.mjs` |
| New tests | `test/resilience.test.mjs`, `test/redaction.test.mjs`, `test/pagination.test.mjs` |
| Extended tests | `test/config.test.mjs`, `test/server.test.mjs`, `test/sql.test.mjs`, `test-utils/helpers.mjs` |
| Documentation | `README.md`, `docs/SETUP.md`, `.env.example` |

Results now also include `offset`, `returned`, `has_more` and, when there is more
to read, `next_offset`. Existing fields are unchanged.

## Verification results

All results below were recorded on Windows 11 with Node 26.7.0 and npm 11.0.0.

| Check | Result |
| --- | --- |
| Baseline before changes (`npm test`) | 149 passed, 0 failed |
| Final suite (`npm test`) | **253 passed, 0 failed, 0 skipped** |
| Coverage (`npm run test:coverage`) | 99.45% lines, 96.52% branches, 95.29% functions |
| New tests run against the original source | 33 failures, which confirms they detect the old defects |
| Local stdio run: `initialize` | Passed: protocol `2025-06-18`, server `openobserve-readonly-mcp` 1.1.0 |
| Local stdio run: `tools/list` | Passed: `o2_list_streams`, `o2_stream_schema`, `o2_search`, all read-only |
| Local stdio run: behavior over real `fetch` | 10 of 10 checks passed, covering retry, redirect refusal, redaction, paging and cancellation |
| Regex stress test at the 16 KB scan limit | Slowest input took 4.8 ms |
| `npm pack --dry-run` | 11 files, version 1.1.0, no tests included |
| Runtime dependencies | 0 |

The stdio run used a temporary mock server on `127.0.0.1`. No real Grafana,
OpenObserve, Kafka or Redpanda system was contacted.

### Not verified

- **Real OpenObserve behavior.** Everything was tested against mocks. Three
  assumptions need checking on a real server: that `from` pages correctly, how it
  interacts with a SQL `LIMIT`, and what `total` means. `has_more` is deliberately
  cautious, so the last page of a result may be followed by one empty page.
- **Other Node versions.** CI targets Node 18, 20, 22 and 24, but only 26.7.0 is
  installed here. The code avoids `AbortSignal.any` to stay compatible with 18.17,
  but that has not been run.
- **Linux and macOS.** Only Windows was tested.
- **An installed package.** The check that packs a tarball, extracts it and starts
  it was declined by the permission prompt, so it did not run. Only
  `npm pack --dry-run` ran. The `npx` path is also untested.
- **Real MCP clients.** The handshake used a scripted client, not Claude Desktop,
  Claude Code or opencode.
- **Redaction completeness.** It is pattern-based. It cannot recognize a secret
  stored in an ordinary field, and it can hide harmless text such as
  `token: expired`.

### Sensitive data scan

No secrets, personal details or company-specific hostnames were found in the
tracked files. Test fixtures use `example.com` and obvious placeholders, and
credential-shaped fixtures are assembled at runtime so that no real-looking key is
stored in the repository.

## Top remaining ideas

1. **T2:** run a contract test against a disposable OpenObserve container. This
   would settle the paging assumptions above.
2. **S7:** add a stream allowlist, so sensitive streams can be kept away from the
   model entirely.
3. **A6:** return the largest page that fits the output budget, which reduces the
   number of calls an agent needs.
4. **R8:** limit concurrent searches, so parallel agent calls cannot overload the
   upstream server.
5. **A7:** add `outputSchema` and `structuredContent` for clients that can use them.
