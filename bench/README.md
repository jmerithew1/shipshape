# `bench/` — the audit measurement harness

Every baseline number in [`../AUDIT_REPORT.md`](../AUDIT_REPORT.md) was produced by an instrument in
this directory. They are committed so that **anyone can reproduce the measurements**, not just the
person who took them — which is what "before/after measurements are reproducible" requires.

## Reproduce the data volume first — this is not optional

`pnpm db:seed` produces **257 documents and 11 users**. Every Category 3 and 4 baseline was measured
against **557 documents, 254 issues, 23 users, 35 sprints, 551 associations**. Measuring "after"
against the stock seed compares two different databases and the comparison means nothing.

```bash
pnpm db:seed                                    # 257 docs / 11 users
docker exec -i shipshape-postgres-1 psql -U ship -d ship_dev < bench/seed/seed_volume.sql
# -> 557 documents · 254 issues · 23 users · 35 sprints
```

`seed_volume.sql` adds 150 issues, 120 wiki pages (half nested), 30 ICE-scored projects, 12 users and
150 project associations. It touches no application code and no schema.

## Conditions every measurement assumes

| | |
| --- | --- |
| Postgres | 16.x, container `shipshape-postgres-1`, host port **5433**, db `ship_dev` |
| API | `http://localhost:3000` — **dev mode** (`tsx watch`), single process, no clustering |
| Web | `http://localhost:5173` |
| Auth | `dev@ship.local` / `admin123` |

Absolute latencies are pessimistic versus a production build. **Relative rankings and saturation
behaviour are the durable findings.**

## Per category

| Category | Instrument | Command |
| --- | --- | --- |
| **1 — Type safety** | `cat1-types/count-types.mjs` | `node bench/cat1-types/count-types.mjs .` |
| **2 — Bundle size** | `cat2-bundle/smattr.mjs` | build with `--sourcemap`, then `node bench/cat2-bundle/smattr.mjs web/dist/assets/index-*.js` |
| **3 — API latency** | `cat3-latency/{go.sh,loadgen.js,baseline.sh,rtt.js}` | `bash bench/cat3-latency/go.sh issues "/api/issues" 10 300 30` |
| **4 — DB queries** | `cat4-queries/{run_flow.sh,parse.py,explain*.sql}` | enable `log_statement='all'`, run a flow, then `python bench/cat4-queries/parse.py` |
| **7 — Accessibility** | `cat7-a11y/{lh.sh,a11y_scan.py,contrast.js}` | `bash bench/cat7-a11y/lh.sh` · `node bench/cat7-a11y/contrast.js` |
| **8 — Terraform** | `cat8-terraform/drift-demo/` | `bash bench/cat8-terraform/drift-demo/run-drift-demo.sh` |
| Platform perf | `perf.py` | `python bench/perf.py` |

### Notes that will save you time

**Category 1** uses the TypeScript compiler API, not grep — deliberately. Naive grep reports 1,538
`as` and 2,051 `!`; the real figures are 618 and 329, because grep cannot separate `as const` from an
unsafe assertion, SQL `AS` inside a template string from a TS `as`, or `x!` from `!==`.

**Category 2** ships a hand-written VLQ sourcemap attributor because `source-map-explorer` cannot
read Vite 6 sourcemaps (`refers to generated column Infinity`). It measures post-minification bytes.

**Category 3** must respect two things or the numbers are garbage. A **rate limiter caps the API at
1000 req/60 s** (`api/src/app.ts:81-88`) — a naive `autocannon -d 10 -c 25` issues ~8000 requests and
benchmarks HTTP 429s. And **sessions expire 15 minutes after creation** regardless of activity, so
long runs silently start measuring 401s. `go.sh` re-authenticates before each run and sizes each run
to fit one rate-limit window. Always check the status distribution.

**Category 4** counts exact queries per flow on a quiet system. Do not run a load test at the same
time — during the audit these two corrupted each other, which is why they were serialised.

**Category 8**'s drift demo is fully executable and touches only files inside its own directory. It
never talks to AWS.

## Serialisation rule

Categories 3, 4, 6 and 7 all exercise the same running app. **Run them one at a time.** A load test
during query-counting inflates the counts; a browser session during a load test adds noise. This is
also why "after" measurements are taken as a single pass at the end rather than per-change — adding
an index (Cat 4) moves API latency (Cat 3), so mid-flight numbers are not comparable.
