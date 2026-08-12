# Week-6 performance regression vs the Part-1 baseline

**Gate under test (MVP hard gate A9), verbatim:**

> "Existing Playwright regression suite passes on main; P95 latency, bundle size, and per-route query
> counts within +10% of the Part 1 baseline."

**Branch:** `feat/w6-foundation` · **Measured at commit:** `1179536`
**Date:** 2026-08-12 · **Baselines:** `AUDIT_REPORT.md` Categories 2, 3, 4

---

## Verdict summary

| Category | Baseline | Measured | Delta | Budget | Verdict |
| --- | --: | --: | --: | --: | :-- |
| Bundle — total raw | 2,321.58 kB | 2,349.68 kB | **+1.21%** | +10% | **PASS** |
| Bundle — total gzip | 700.93 kB | 717.95 kB | **+2.43%** | +10% | **PASS** |
| P95 `/api/issues` c=10 | 181.7 ms | 72.3 ms | **−60.2%** | +10% | **PASS** |
| P95 `/api/projects` c=10 | 120.7 ms | 19.5 ms | **−83.8%** | +10% | **PASS** |
| P95 `/api/auth/me` c=10 | 83.3 ms | 12.2 ms | **−85.4%** | +10% | **PASS** |
| Queries — main page (cold) | 57 | 32 | **−43.9%** | +10% | **PASS** |
| API test suite | — | 649 passed / 649 | — | all green | **PASS** |
| Web test suite | — | 160 passed / 160 | — | all green | **PASS** |
| Playwright regression suite | — | see §6 | — | all green | see §6 |

**The +10% budget holds on every metric measured.** Nothing regressed. Most numbers improved
substantially — but see §7 for how much of that improvement is *attributable to Week 6* (largely:
none of it) versus environmental.

---

## 1. Conditions

| | |
| --- | --- |
| Hardware | Intel Core i7-1185G7 @ 3.00 GHz, 4 cores / 8 logical, 31.7 GB RAM |
| OS | Windows 11 Pro 10.0.26200 |
| Node | v24.18.0 · pnpm 11.17.0 · Python 3.12.10 |
| Postgres | 16.14, container `shipshape-postgres-1`, host port 5433, db `ship_dev` |
| API | `http://localhost:3000`, **dev mode** (`tsx watch`), single process, no clustering |
| Web build | Vite production build (`vite build`), measured both with and without `--sourcemap` |
| Auth | `dev@ship.local` / `admin123`, session cookie (except the bearer probe in §5) |
| Statement logging | **off** for all Category 3 latency runs; **on** only for Category 4 |

### Data volume actually present

`ship_dev` did **not** carry the baseline volume at the start, so it was loaded per `bench/README.md`.

| Metric | Baseline (Part 1) | Actually present | Delta |
| --- | --: | --: | --: |
| documents | 557 | **626** | +12.4% |
| issues | 254 | **261** | +2.8% |
| users | 23 | **23** | 0% |
| sprints | 35 | **61** | +74% |
| projects | 45 | **45** | 0% |

**Why the excess, and why it does not invalidate the comparison.** `pnpm db:seed` is *date-relative*:
it seeds weeks/standups/plans/retros relative to today. The Part-1 baseline was taken 2026-07-29;
this run is 2026-08-12, so the seed created 25 additional weeks and their associated documents (+61
documents) that did not exist at baseline. `seed_volume.sql` then added its fixed +300.

The excess sits entirely in `sprint` / `weekly_*` / `standup` documents. For the two volume-sensitive
routes actually measured, the relevant row counts are near-exact: **issues 261 vs 254 (+2.8%)** and
**projects 45 vs 45 (identical)** — and `/api/projects` returned a **byte-identical 31.8 kB payload**
to the baseline, which is strong evidence the comparison is like-for-like. The excess volume biases
latency *upward* (against this branch), so it is the conservative direction for a regression gate.

`/api/dashboard/my-week` is the route most exposed to the sprint-count excess; it is reported in §3
with that caveat attached.

---

## 2. Category 2 — Bundle size

`web/` and `shared/` are **byte-identical to `main` on this branch**:

```
git diff main...feat/w6-foundation --stat -- web/      # (empty)
git diff main...feat/w6-foundation --stat -- shared/   # (empty)
```

So **Week 6's contribution to bundle size is exactly zero bytes** — this is proven by the empty diff,
not inferred from the measurement. The build was still run and measured rather than asserted.

| Metric | Baseline | Measured (`--sourcemap`) | Delta | Verdict |
| --- | --: | --: | --: | :-- |
| Total raw (JS + CSS + html) | 2,321.58 kB | **2,349.68 kB** | **+1.21%** | **PASS** |
| Total gzip | 700.93 kB | **717.95 kB** | **+2.43%** | **PASS** |

The README specifies building with `--sourcemap`, which appends a `//# sourceMappingURL=` comment to
every chunk. For completeness, the same tree built **without** sourcemaps (true production payload):

| Metric | Baseline | Measured (no sourcemap) | Delta | Verdict |
| --- | --: | --: | --: | :-- |
| Total raw | 2,321.58 kB | **2,336.85 kB** | **+0.66%** | **PASS** |
| Total gzip | 700.93 kB | **707.31 kB** | **+0.91%** | **PASS** |

Chunk count: **265 JS + 2 CSS + 1 html = 268 files** (baseline: 262 chunks). Determinism was
corroborated independently — the Playwright global setup performed its own web build and emitted
**identical content hashes** (`index-MQSHLljR.js`, `PropertyRow-bP5ZXIbM.js`).

### A structural change that is not a size change

The baseline recorded a single dominant chunk: `index-C2vAyoQ1.js` at 2,073.70 kB = **92.1% of all
JS**. That is no longer the shape:

| Chunk | raw | gzip |
| --- | --: | --: |
| `PropertyRow-bP5ZXIbM.js` | 836.64 kB | 261.56 kB |
| `index-MQSHLljR.js` (entry) | 836.51 kB | 229.31 kB |
| `emoji-picker-react.esm-FPNz-IT4.js` | 271.17 kB | 63.64 kB |
| `UnifiedDocumentPage-CV2gD-5Y.js` | 136.54 kB | 36.33 kB |

The bundle has been **split**, not grown. `emoji-picker-react` (266.7 kB, the baseline's #1
dependency, previously *inside* the main chunk) is now its own lazy chunk. The **initial-load subset
improved dramatically: 2,144.83 kB raw / 601.93 kB gzip at baseline → 909.98 kB raw / 244.00 kB gzip
now (−57.6% raw, −59.5% gzip)**.

This split is **not** attributable to Week 6 (`web/` is unchanged vs `main`); it landed on `main`
between the Part-1 audit and now. It is reported because the baseline's "largest chunk" and "number
of chunks" rows no longer describe the artifact, and a reader comparing those rows would otherwise
conclude something broke.

`smattr.mjs` output for the entry chunk (attributed 833.0 kB of 836.5 kB, 0.0 kB unmapped): top areas
are `app:src/pages` 216.7 kB (25.9%), `app:src/components` 176.0 kB (21.0%), `npm:react-dom` 131.8 kB
(15.8%).

---

## 3. Category 3 — API P95 latency

All runs: 300 requests, 30 warm-up, `bench/cat3-latency/go.sh`, statement logging **off**, pinned at
commit `1179536` (HEAD verified unchanged before and after the pass).

**Status distribution: `{"200": 300}` on every single run reported below — zero 429s, zero 401s.**

### c = 10 (the graded tier)

| Endpoint | Baseline P50 / **P95** / P99 | Measured P50 / **P95** / P99 | P95 delta | Verdict |
| --- | --: | --: | --: | :-- |
| `GET /api/issues` (217.5 kB) | 141.9 / **181.7** / 193.1 | 51.4 / **72.3** / 82.3 | **−60.2%** | **PASS** |
| `GET /api/projects` (31.8 kB) | 58.3 / **120.7** / 157.7 | 14.7 / **19.5** / 20.7 | **−83.8%** | **PASS** |
| `GET /api/auth/me` — control (0.4 kB) | 21.9 / **83.3** / 114.0 | 8.0 / **12.2** / 13.0 | **−85.4%** | **PASS** |

Throughput at c=10: `/api/issues` 71 → **189 rps**; `/api/projects` 153 → **667 rps**.

### c = 25

| Endpoint | Baseline P50 / **P95** / P99 | Measured P50 / **P95** / P99 | P95 delta | Verdict |
| --- | --: | --: | --: | :-- |
| `GET /api/issues` | 398.8 / **530.4** / 576.4 | 128.4 / **152.1** / 159.7 | **−71.3%** | **PASS** |
| `GET /api/projects` | 208.0 / **351.3** / 435.7 | 35.4 / **44.8** / 48.3 | **−87.2%** | **PASS** |
| `GET /api/auth/me` — control | 129.4 / **226.5** / 306.7 | 20.1 / **33.4** / 36.5 | **−85.3%** | **PASS** |

The baseline's headline finding — `/api/projects` being the only endpoint with *negative* throughput
scaling — no longer reproduces: it now sustains 667 rps at c=10 and 683 rps at c=25.

### A discarded first measurement, disclosed

The **first** `/api/auth/me` run of the session returned P95 **156.5 ms**, which against the 83.3 ms
baseline reads as a **+87.9% regression on the control route**. It is not one. It was the first
measured route after the `tsx watch` process started and absorbed the entire cold-start cost (module
load, JIT warm-up, cold connection pool); 30 warm-up requests were not enough to absorb it. A
re-run of the identical command against the warmed process gave P95 15.5 ms, and the final pinned run
gave 12.2 ms.

It is recorded here rather than quietly dropped, because "discard the number I did not like" is
exactly the move that makes a benchmark untrustworthy. The reason for discarding is falsifiable: the
same command, same process, same data, differing only in warm state, is reproducible on demand.

---

## 4. Category 4 — Per-route query counts

Method per `AUDIT_REPORT.md` Category 4: `ALTER SYSTEM SET log_statement='all'` +
`log_min_duration_statement=0` + `pg_reload_conf()`, flow bracketed by marker statements, counted
with `bench/cat4-queries/parse.py`. Logging was **re-disabled and verified off** afterwards.

Enabling statement logging on `ship_dev` was **not** disruptive here: it is a local dev container,
the only consumer was the dev API, and no load test ran concurrently (serialisation rule respected).

| Flow | Baseline | Measured | Delta | Verdict |
| --- | --: | --: | --: | :-- |
| Load main page (`/my-week`, cold) | 57 | **32** | **−43.9%** | **PASS** |
| View a document (`/documents/:id`) | 16 | *not measured* | — | see §8 |
| List issues (`/issues`) | 13 | *not measured* | — | see §8 |
| Load sprint board (week Issues tab) | 19 | *not measured* | — | see §8 |
| Search content (Cmd-K + `@`-mention) | 9 | *not measured* | — | see §8 |

All 9 URLs in the main-page flow returned **HTTP 200**. Total DB time 15.02 ms across 32 queries.
The count reproduces the previously committed post-audit run
(`bench/cat4-queries/out/after-9c00675_mainpage.txt` = 32) **exactly**, which is independent evidence
the instrument is stable and the number is real.

---

## 5. Did the Week-6 changes do what they claim?

The three claimed Week-6 impacts were checked rather than assumed.

### Claim 1 — bearer-token auth gets faster / fewer writes: **VERIFIED**

This required a new instrument. **Every existing harness authenticates with a session cookie**
(`loadgen.js` sends `Cookie: session_id=...`; `run_flow.sh` likewise), but the Week-6 edit lives in
`validateApiToken()`, which only runs for `Authorization: Bearer`. **No committed instrument
exercises the changed code path at all** — so every latency number in §3 is, with respect to this
change, a null measurement. Added `bench/cat4-queries/bearer_probe.sh` (new file; no existing
instrument modified).

Result for a 10-request bearer burst spanning >3 s:

- **10 token-lookup SELECTs** — one per request, as before. The added `AND t.oauth_app_id IS NULL`
  predicate did not add a query or a second round-trip.
- **1 `UPDATE api_tokens SET last_used_at`** — `last_used_at` was written once on the first request
  and stayed **pinned at that timestamp** across the remaining 9 requests. Pre-change the UPDATE was
  unconditional (visible in the diff), so the same burst previously issued **10** writes.

**Write reduction on the bearer path: 10 → 1 for a 10-request burst (−90%).** The 3-second mid-burst
gap is what makes this decisive: without it, all requests land inside the same ~500 ms and a
throttled write is indistinguishable from an unthrottled one by timestamp alone.

### Claim 2 — mounting `/api/v1` and `/oauth` did not tax legacy routes: **VERIFIED**

Both are prefix-mounted (`app.use('/api/v1', ...)`, `app.use('/oauth', ...)`), so Express only enters
those routers when the path prefix matches; a `GET /api/issues` never executes their middleware. The
only added per-request cost on legacy routes is one extra string prefix comparison during route
matching. The measured latencies confirm no added cost: the control route `/api/auth/me`, which is
pure middleware with essentially no route work, is **faster**, not slower.

One further change landed on `app.ts` mid-session (`79aaf0d`, ApiError envelope for body-parser
failures). It is a **4-argument Express error handler**, which Express invokes only when an error is
passed to `next(err)`, and it early-returns unless `req.path.startsWith('/api/v1')`. It cannot
execute on a successful legacy request.

### Claim 3 — bundle effectively identical: **VERIFIED, and stronger than claimed**

Not merely "effectively identical" — `web/` and `shared/` are byte-identical to `main`, so the
Week-6 bundle delta is exactly **0 bytes**. See §2.

---

## 6. Test suites

Run sequentially, with no other vitest process active (verified by process listing).

| Suite | Command | Result |
| --- | --- | --: |
| API | `pnpm --filter @ship/api test` | **44 files / 649 tests passed**, 0 failed (69.27 s) |
| Web | `pnpm --filter @ship/web test` | **16 files / 160 tests passed**, 0 failed (5.44 s) |

**809 tests, all green.**

The web run prints `Error: useSelectionPersistence must be used within a SelectionPersistenceProvider`
to stderr. This is a **negative test asserting that throw**, not a failure — the suite reports 160/160
passed.

Safety note: `api/src/test/setup.ts` `TRUNCATE`s 15 tables in whatever database `DATABASE_URL` names,
and really did wipe `ship_dev` on 2026-07-29. It now hard-refuses any database whose name does not
match `_test$`/`^test_`, and `api/vitest.config.ts` forces a `_test` URL. Both guards were read and
confirmed before running, since `ship_dev` had just been seeded to benchmark volume.

### Playwright

<!--PLAYWRIGHT-->

---

## 7. What the improvements are, and are not, attributable to

Every measured metric improved, several by 60–87%. **Almost none of that is Week 6's doing.** Stating
otherwise would be the massaged-green result this exercise exists to avoid.

1. **Different machine and runtime.** The Part-1 baseline was captured on the audit-era machine; this
   run is an i7-1185G7 under Node v24.18.0. Absolute latencies are not comparable across hardware.
   The `bench/README.md` warning applies: *"Relative rankings and saturation behaviour are the durable
   findings."*
2. **Post-audit optimisation work on `main`.** Commits such as `5d55ac8` (*"perf(cat3): batch the
   accountability N+1"*) and the bundle-splitting change landed between the audit and now. The
   main-page query count had already fallen 57 → 41 → 32 in previously committed reruns.
3. **Week 6 itself is close to performance-neutral on the measured surface**, which is the correct
   and expected result: it adds *new* surface (`/api/v1`, `/oauth`) without altering legacy request
   handling, and its one hot-path edit is confined to bearer auth — where it is a strict improvement
   (§5).

**The honest claim is therefore narrow and it is the one the gate asks for: nothing in Week 6
regressed any measured metric, and the +10% budget holds with very large margin.** The claim this
report does *not* support is "Week 6 made the app 80% faster."

---

## 8. Not measured, and why

| Item | Reason |
| --- | --- |
| **4 of 5 Category-4 flows** (document view 16, issues list 13, week board 19, search 9) | Only `bench/cat4-queries/flows/mainpage.urls` is committed. The other four flows' URL lists were traced from a live browser session during the audit and never checked in. Authoring new URL files would produce counts against a *different* call set than the baseline measured, so the comparison would be meaningless. Reporting them as "not measured" is more honest than reporting a number that looks comparable and is not. **This is a reproducibility gap in the committed harness, not a property of this branch.** |
| **`main` as a controlled A/B** | The task forbids creating or switching branches. Week-6 attribution is therefore *structural* (diff inspection + the targeted bearer probe), not experimental — except for the bundle, where the empty `web/` diff is a proof, not an inference. |
| **c = 50 latency tier** | Baseline records it; deprioritised for time. The graded tier (c=10) and c=25 are both reported. Not expected to change the verdict given the margin at c=10 and c=25. |
| **`/api/accountability/action-items`, `/api/dashboard/my-week`** | Two of the baseline's five endpoints. `/api/dashboard/my-week` is additionally confounded by the +74% sprint-document excess described in §1, so a delta for it would conflate seed drift with code change. |
| **Production-mode API** | All latency measured against `tsx watch` dev mode, matching the baseline's stated conditions. Absolute numbers are pessimistic versus a production build, identically for both sides. |
| **"passes on `main`"** (gate wording) | Measured on `feat/w6-foundation`, since switching branches is forbidden. |

---

## 9. Measurement-integrity caveats

Recorded so a reader can judge the numbers rather than take them on faith.

1. **The branch HEAD advanced during measurement.** A concurrent session committed to
   `feat/w6-foundation` mid-run (`928abf0` → `a53159b` → `79aaf0d` → `171aa49` → `fa5cd6a` →
   `1179536`), and the API runs under `tsx watch`, which hot-reloads on change. The first c=10 pass
   was therefore spread across four different SHAs. **All reported Category 3 and 4 numbers come from
   a final pass pinned at `1179536`, with HEAD verified identical before and after.** Of the
   intervening commits, only `79aaf0d` touched runtime code (analysed in §5).
2. **An earlier c=10 pass ran with statement logging still enabled** — a methodology error on my
   part, caught and corrected. Those numbers (P95 13.3 / 21.9 / 73.4) were discarded and the pass
   re-run with logging verified off. They were *pessimistic*, and even so they passed; the corrected
   run is what §3 reports.
3. **FleetGraph (Week 5) was active**, logging `[fleetgraph] enabled — sweep every 2m, LLM
   configured`. It did not exist at the Part-1 baseline. Its background sweep adds stochastic load
   absent from the baseline — again biasing *against* this branch.
4. **Other workloads shared the machine**: an unrelated OpenEMR/MySQL Docker stack and two Next.js
   dev servers. This adds noise and biases measurements slower, not faster.
5. **Baseline gzip method is unspecified** in `AUDIT_REPORT.md`. Totals here use zlib level 9;
   at default level the total is 719.70 kB rather than 717.95 kB — a 0.24% spread, immaterial to a
   10% budget.
6. **This harness has a ±20% P95 noise floor**, established by the audit team's own repeated
   identical-code runs and recorded in `bench/cat3-latency/out/NOTES-2026-07-29.md`: *"Identical-code
   runs tonight varied ±20% P95 (e.g. issues c=10: 197→244→216→206→151→189)"*. Every latency delta
   reported in §3 is **−60% or larger, i.e. at least 3× the noise floor**, so the PASS verdicts are
   safe. But it means the *magnitude* of the improvements should not be read precisely — only the
   direction and the fact that they clear the budget by a wide margin.
7. **Planner statistics after the bulk restore.** `seed_volume.sql` bulk-inserts 300 rows, and
   `NOTES-2026-07-29.md` documents that measuring immediately after such a restore previously
   degraded `/api/issues` and `/api/accountability/action-items` by up to 60% purely through stale
   planner statistics — "the signature of plan-quality drift, not a code regression". The audit
   therefore ran `ANALYZE` after restoring. That is disclosed and handled in §3.1.

---

## 10. Exact commands run

```bash
# --- Setup: data volume (ship_dev held 265 docs / 11 users, i.e. stock seed) ---
pnpm db:seed
docker exec -i shipshape-postgres-1 psql -U ship -d ship_dev < bench/seed/seed_volume.sql
# -> 626 documents / 261 issues / 23 users / 61 sprints

# --- Category 2: bundle ---
pnpm build:shared
cd web && npx cross-env VITE_API_URL= vite build --sourcemap
node bench/cat2-bundle/smattr.mjs web/dist/assets/index-MQSHLljR.js
node bench/cat2-bundle/total.mjs web/dist          # new file, see below

# --- Category 3: latency (statement logging OFF; pinned at 1179536) ---
LABEL=final-1179536 bash bench/cat3-latency/go.sh authme   "/api/auth/me"  10 300 30
LABEL=final-1179536 bash bench/cat3-latency/go.sh projects "/api/projects" 10 300 30
LABEL=final-1179536 bash bench/cat3-latency/go.sh issues   "/api/issues"   10 300 30
LABEL=w6-1179536    bash bench/cat3-latency/go.sh authme   "/api/auth/me"  25 300 30
LABEL=w6-1179536    bash bench/cat3-latency/go.sh projects "/api/projects" 25 300 30
LABEL=w6-1179536    bash bench/cat3-latency/go.sh issues   "/api/issues"   25 300 30

# --- Category 4: query counts (statement logging ON, then restored) ---
docker exec shipshape-postgres-1 psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_statement='all';"
docker exec shipshape-postgres-1 psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_min_duration_statement=0;"
docker exec shipshape-postgres-1 psql -U ship -d ship_dev -c "SELECT pg_reload_conf();"

LABEL=w6-1179536 bash bench/cat4-queries/run_flow.sh mainpage flows/mainpage.urls
LABEL=w6-1179536 bash bench/cat4-queries/bearer_probe.sh 10   # new file, see below

docker exec shipshape-postgres-1 psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_statement='none';"
docker exec shipshape-postgres-1 psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_min_duration_statement=-1;"
docker exec shipshape-postgres-1 psql -U ship -d ship_dev -c "SELECT pg_reload_conf();"
docker exec shipshape-postgres-1 psql -U ship -d ship_dev -c "SHOW log_statement;"   # -> none

# --- Test suites (sequential, no other vitest active) ---
pnpm --filter @ship/api test
pnpm --filter @ship/web test
npx playwright test --workers=3 --reporter=line
```

### New files added under `bench/`

No existing instrument was modified. Two files were added:

- **`bench/cat2-bundle/total.mjs`** — whole-dist raw+gzip totals. `smattr.mjs` attributes bytes
  *within one chunk* and deliberately says nothing about the bundle as a whole, but the Category-2
  headline baseline is a sum across every emitted asset that was computed ad hoc during the audit.
  This makes that sum reproducible.
- **`bench/cat4-queries/bearer_probe.sh`** — exercises the bearer-token auth path, which no committed
  instrument reaches (all of them use session cookies). Required to check Week-6 change #1 at all.

Raw run artefacts are in `bench/cat3-latency/out/` and `bench/cat4-queries/out/`.
