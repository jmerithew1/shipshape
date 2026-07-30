# Resilience Assessment — retries, timeouts, circuit breakers

Week-4 implementation rule 7: assess outbound calls for missing retry logic, hardcoded timeouts,
and missing circuit breakers; add or improve where gaps are found; document each decision with the
failure mode it protects against. This is the written assessment; changes shipped this week are
marked ✅ with their commit.

## Inventory of outbound dependencies

| Dependency | Call path | Timeouts | Retries | Circuit breaker |
| --- | --- | --- | --- | --- |
| PostgreSQL | `api/src/db/client.ts` pool | ✅ `connectionTimeoutMillis: 2000`, `statement_timeout: 30000`, `idleTimeoutMillis: 30000` | ✖ none at pool level (see decision 1) | ✖ (see decision 3) |
| Browser → API (TanStack Query) | `web/src/lib/queryClient.ts:139-155` | Browser defaults | ✅ retry predicate: retries transient failures, skips 4xx | n/a client-side |
| Browser → API (session keepalive) | `web/src/hooks/useSessionTimeout.ts` | Browser defaults | ✅ **added this week** — transient extend-session failures no longer treated as fatal; only 401/403 logs out (commit `22acc2f`) | n/a |
| WebSocket collaboration (Yjs) | `web/src/components/Editor.tsx` y-websocket provider | library defaults | ✅ y-websocket reconnects with backoff by design; IndexedDB persistence bridges offline gaps | n/a |
| Process-level failure | `api/src/index.ts` | n/a | n/a | ✅ **added this week** — `unhandledRejection` logs-and-serves; `uncaughtException` exits for supervisor restart (commit `dd98511`) |
| AWS SSM (production secrets) | `api/src/config/ssm.ts`, startup only | SDK defaults | SDK default (3 attempts, adaptive) | startup-fatal by design: no secrets → no serve |

## Decisions

1. **No pool-level query retries — deliberate.** Blind retry of failed SQL risks double-applying
   non-idempotent writes (issue creation uses ticket-number sequences behind advisory locks). The
   correct retry boundary is the HTTP client, which already distinguishes retryable transport
   failures from 4xx application errors. Failure mode protected against: duplicate writes under
   partial failure.
2. **Statement timeout 30 s stays.** It bounds worst-case queries; the audit's slowest measured
   query is ~8 ms at seed scale, so the headroom is ~3 orders of magnitude. Failure mode: a
   runaway query pinning a pool connection indefinitely.
3. **No circuit breaker on PostgreSQL — deliberate, documented.** A breaker's value is shedding
   load to a degraded downstream while serving from fallbacks. The API has exactly one datastore
   and no fallback surface: with Postgres down, every request fails fast anyway on
   `connectionTimeoutMillis: 2000`. A breaker would add state and configuration without changing
   observable behavior. Revisit when a second downstream (external API, cache) exists. Failure
   mode considered: thundering-herd reconnects — already bounded by the pool max and the 2 s
   connection timeout.
4. **Session keepalive is now failure-mode-aware** (this week): the previous behavior treated a
   one-second network blip as session death and logged the user out — a user-facing data-loss
   class bug (Cat 6). Only an authoritative 401/403 does that now.
5. **Process-level nets** (this week): one unawaited rejection no longer takes down every user's
   session; synchronous corruption still exits non-zero so the supervisor (Docker restart policy /
   Render) restarts a clean process.

## Gaps acknowledged, not built (with reasons)

- **Retry/backoff on the collaboration server's persistence writes** (`api/src/collaboration/`):
  debounced Yjs saves that fail are currently logged, with state retained in memory and IndexedDB
  client-side; a dedicated retry queue is the right shape but touches the CRDT persistence path —
  too high-risk for this window. Tracked in AUDIT_REPORT.md (shutdown-hook correction row).
- **hono/undici transitive advisories** are inventoried by the CI audit artifact, not patched here
  (major-version bumps of upstream frameworks).
