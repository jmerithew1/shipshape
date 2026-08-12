# Week 6 — Three Discoveries

Things this week actually taught me, each with the evidence that produced it.
Not summaries of what I built — the moments where I was wrong first.

---

## 1. A fitness test that reads your own registry proves nothing about your server

**The setup.** The public API's contract is enforced by a fitness test that
walks every `/api/v1` route and asserts four properties: it has an OpenAPI
entry, it declares a scope, it ships the `ApiError` envelope on failure, and it
paginates if it is a list. I wrote it, it passed, and I wrote in the ledger that
drift was "structurally impossible."

**What was actually true.** The test iterated `v1RouteCatalog` — an array that
only the route factory writes. Anything mounted directly on the router
(`router.get(...)`) was invisible to it. And the codebase *already did that*: the
spec endpoint itself is mounted that way. So a developer could add

```ts
router.get('/debug/config', (_req, res) => res.json({ db: process.env.DATABASE_URL }))
```

and get an unauthenticated, unscoped, undocumented route that leaks a secret —
with all four contract suites still green.

**The fix, and the part that mattered.** The test now walks the live Express
stack (`router.stack`) and requires it to equal the catalog plus an explicit
allowlist. But the fix wasn't the lesson. The lesson was that **I only believed
it once I planted a rogue route and watched the test fail.** A fitness test you
have never seen fail is a hypothesis, not a gate. I now treat "did I observe
this fail for the right reason?" as part of writing one.

*Evidence: `api/src/platform/api/v1/contract.fitness.test.ts` — the first
describe block, and the deliberate-failure check documented in its comment.*

---

## 2. Keyset pagination is only stable if the sort key can't move

**The setup.** The brief requires cursors "stable across reordering
operations." Keyset pagination is the textbook answer — a cursor names a
position in the ordering rather than an offset, so inserts elsewhere can't shift
it. I implemented keyset over `(updated_at, id)`, wrote a test, and marked the
requirement met.

**What was actually true.** Sorting by `updated_at` while paginating means the
sort key is the *mutation timestamp*. Edit a row that hasn't been returned yet
and it jumps above the cursor — and is then never delivered. A client walking
every page silently receives 29 of 30 documents. The SDK's `iterate()` inherits
it, so the loss is invisible at the highest level of abstraction.

**Why my test didn't catch it.** The test re-implemented the comparator in
JavaScript and asserted that the re-implementation agreed with itself. It never
executed the SQL and never mutated a row mid-walk. It was, precisely, a test of
my belief rather than my code.

**The fix.** Sort on immutable `created_at`; keep `updated_before` as a filter,
which is what the agent's detectors actually needed. The new test edits an
unreturned row in the middle of a real paginated walk against real Postgres and
asserts the row still arrives, exactly once.

*Evidence: `api/src/platform/api/v1/audit-fixes.test.ts` → "never skips a row
that is edited while the client is paging."*

---

## 3. The dangerous middleware is the middleware you didn't mount

**The setup.** Three separate defects, found across two audits, all with the
same shape — and I didn't see the shape until the third one.

- **Malformed JSON** on a public route returned an Express HTML error page.
  `express.json()` is mounted *above* the v1 router, so its `SyntaxError` never
  reached my error handler.
- **A 429** returned `{error: "..."}`, not the `ApiError` envelope. The rate
  limiter is mounted above the v1 router and writes its body directly instead of
  calling `next()`. Worse, the generated OpenAPI spec *documented* a
  `rate_limited` envelope — the published contract was lying, and no test could
  catch it because the test environment raises the limit so a 429 is
  unprovokable.
- **CSRF on the OAuth consent endpoints** matched `req.path` exactly, while
  Express routes case-insensitively and non-strictly. `POST /oauth/device/verify/`
  — one trailing slash — skipped the guard and still ran the handler. Only
  `SameSite=Strict` cookies were preventing a forged device approval, which is
  *not* the control the code claimed was protecting it.

**The pattern.** I reasoned carefully about everything inside my router and not
at all about what sits above it. Framework-level middleware — body parsers,
CORS, rate limiters, CSRF — runs before your code and can answer requests your
code never sees. Each of these was invisible to a test suite that only ever
entered through the front of the router.

**What changed in how I work.** I now ask, for any contract that says "every
request" or "every failure": *which layers can answer this request without
reaching my handler?* And I test at the app boundary, not the router boundary —
`envelope-edges.test.ts` exists purely to assert things about requests that die
before my code runs.

*Evidence: `api/src/platform/api/v1/envelope-edges.test.ts`,
`audit-fixes.test.ts` (five CSRF forgery shapes), and the rate-limiter handler
in `api/src/app.ts`.*
