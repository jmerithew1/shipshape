# Cat 6 — Error-handling fixes: repro steps and before/after evidence

Executed 2026-07-29. Raw transcripts in this directory; each was produced by
`scratch: migrate-repro.sh` equivalents recorded below. All "before" runs used the pre-fix code via
`git stash` on the same machine, same database container, minutes apart from the "after" runs.

> **Amended 2026-07-31** (reviewer feedback: "before/after transcripts for one of the three
> fixes"): every gap now has its own committed before/after evidence pair. Gap 2 gained executed
> transcripts (`*-unhandled-rejection.txt`, produced by the committed
> `repro-unhandled-rejection.{ts,sh}`), and Gap 3 — the user-facing data-loss case — gained
> screenshots, screen recordings, and step transcripts (`extend-session-*`, produced by the
> committed `capture-extend-session.mjs`). Each artifact records the `git hash-object` of the
> source file it was captured against, so before/after provenance is checkable. All "before" runs
> restore the pre-fix file from git history on the same machine, minutes apart from the "after"
> runs, same repro script both sides.

## Gap 1 — migrations fail silently with exit 0; fresh installs die at 010 (data loss)

**Repro (before):** create an empty database, run `DATABASE_URL=... tsx src/db/migrate.ts`.
**Before behavior** ([before-fresh-install.txt](before-fresh-install.txt)): applies migrations 001–009,
hits `010_oauth_state.sql` (which re-CREATEs a table schema.sql already created), prints
`Database schema already exists, continuing...` and **exits 0** — the deploy proceeds against a
half-migrated database. Same story with a deliberately broken migration
([before-broken-migration.txt](before-broken-migration.txt)): **exit 0, nothing applied after the break.**

**Root causes fixed:** (1) the "already exists" tolerance lived in the outer catch wrapping the whole
run — scoped now to schema.sql only; (2) fresh installs re-executed every migration on top of the
schema.sql snapshot — now detected (`to_regclass('public.documents')` before schema.sql) and
baseline-stamped instead, matching the repo convention that schema.sql is the complete initial snapshot.

**After behavior:** fresh install completes and stamps all 42 migrations, exit 0
([after-fresh-install.txt](after-fresh-install.txt)); a failing migration on an existing database names
the file, rolls back, and **exits 1** ([after-broken-migration.txt](after-broken-migration.txt)).

**Rollback:** revert the migrate.ts commit.

## Gap 2 — one unhandled promise rejection kills the API for every user

**Repro:** any `reject`ed promise nobody awaits in a route handler; Node ≥15 default terminates the
process. No handler existed anywhere in `api/src` (verified by grep before the fix).
**Executed evidence (2026-07-31):** [repro-unhandled-rejection.ts](repro-unhandled-rejection.ts)
boots the real API entrypoint, fires one un-awaited `Promise.reject` 3 s after `/health` first
answers, and probes `/health` from outside ([repro-unhandled-rejection.sh](repro-unhandled-rejection.sh)).
- **Before** ([before-unhandled-rejection.txt](before-unhandled-rejection.txt)), pre-fix
  `index.ts` restored via `git show dd98511~1`: `/health` 200 → rejection → crash trace →
  **process exits code 1**, `/health` no-response. (The trailing `undefined` +
  `ERR_PNPM_RECURSIVE_EXEC` lines are the pnpm wrapper reporting its dead child — noise, not
  part of the failure.)
- **After** ([after-unhandled-rejection.txt](after-unhandled-rejection.txt)): `UNHANDLED PROMISE
  REJECTION (continuing to serve)` logged, `/health` 200 at +2 s and +6 s, clean exit 0.

**Fix:** process-level `unhandledRejection` (log loudly, keep serving) and `uncaughtException`
(log, exit non-zero for supervisor restart) handlers in `api/src/index.ts`.
**Rollback:** revert the index.ts commit (restores default crash behavior).

## Gap 3 — a network blip during "Stay logged in" force-logs the user out (user-facing data loss/confusion)

**Repro (before):** show the 14-minute inactivity warning, click "Stay logged in" while the network
drops for a second: `useSessionTimeout.resetTimer`'s catch treated ANY failure — including fetch
network errors and 5xx — as session death and called `onTimeout()` (logout), dumping the user to
/login and losing their place.
**Fix:** only 401/403 (session provably gone) logs out; transient failures log a warning and keep the
session — the next activity/warning cycle retries. Behavior locked by three new unit tests
(`web/src/hooks/useSessionTimeout.test.ts`, "extend-session failure handling"): 500 → no logout,
network error → no logout, 401 → logout. Web suite 160/160.

**Visual evidence (2026-07-31, per rubric: screenshot/recording per fix):**
[capture-extend-session.mjs](capture-extend-session.mjs) drives the real app in Chromium — sign
in, fast-forward the mocked clock to the 14-minute warning, abort every `/api/**` request (the
wifi blip), press Enter on the focused "Stay Logged In" button. Same script, same machine, both
phases; each transcript records the `git hash-object` of the hook build it ran against.
- **Before** (pre-fix hook via `git show 22acc2f~1`, web rebuilt):
  [warning](extend-session-before-01-warning.png) →
  [outcome: dumped to `/login?expired=true`, "Your session expired due to inactivity"](extend-session-before-02-outcome.png)
  — the session was still alive on the server; the user's place is gone.
  Recording: [extend-session-before.webm](extend-session-before.webm) ·
  transcript: [extend-session-before-transcript.txt](extend-session-before-transcript.txt)
- **After** (current code): [warning](extend-session-after-01-warning.png) →
  [outcome: still on `/docs`, modal dismissed, session kept](extend-session-after-02-outcome.png);
  console shows `Network error extending session; staying logged in`.
  Recording: [extend-session-after.webm](extend-session-after.webm) ·
  transcript: [extend-session-after-transcript.txt](extend-session-after-transcript.txt)

**Rollback:** revert the useSessionTimeout commit.

## Bonus (found the hard way) — `pnpm -C api test` TRUNCATEs whatever DATABASE_URL points at

Live incident 2026-07-29: running the api suite with `.env.local`'s DATABASE_URL wiped `ship_dev`
(restored to exact pinned conditions; disclosed in `bench/cat3-latency/out/NOTES-2026-07-29.md`).
**Fix:** `api/vitest.config.ts` redirects non-test database URLs to `ship_test`; `api/src/test/setup.ts`
hard-refuses any database whose name is not test-patterned. Verified: plain `pnpm test` runs green
against ship_test with `ship_dev` untouched (557 documents before and after).
**Evidence status:** unlike Gaps 1–3, this fix intentionally has **no** executed before/after
pair — reproducing the "before" means truncating a live database. Its evidence is the disclosed
incident (`bench/cat3-latency/out/NOTES-2026-07-29.md`), the guard code itself
(`api/vitest.config.ts`, `api/src/test/setup.ts`, commit `d6e9fee`), and the verification note
above. The rubric's three-gap ask is covered by Gaps 1–3, each with committed pairs.
**Rollback:** revert the guard commit (and never run the suite pointed at a real database again).
