# Discovery Write-up — 3 things this codebase taught me

Week-4 requirement: three things found in this codebase I did not know before — each with where it
lives, what it does and why it matters, and how I'd apply it in future work. All three were
discovered *the hard way*, mid-implementation, with the scars documented in the commit history.

## 1. An overloaded callback API can silently poison every mock's type — and `as any` is the symptom, not the disease

**Where:** `api/src/db/client.ts` (the `pg` Pool) meets `vi.mocked(pool.query)` across the API test
suite; the fix and full explanation live in `api/src/test/mock-query-result.ts:1-40` and the
`refactor(cat1)` commit `1e608ae`.

**What it does / why it matters:** `pg`'s `query` is heavily overloaded, and its *last* overload is
the Node-callback form returning `void`. TypeScript resolves an overloaded function's inferred
return type from the last overload, so `vi.mocked(pool.query).mockResolvedValue(...)` demands a
`void` argument and rejects every real `QueryResult`. That single quirk is why this codebase had
accumulated 32 `{ rows: [...] } as any` casts in one test file alone — each one looked like
laziness but was actually a rational response to an inference dead-end. The repair was a narrow
`QueryMock` interface pinning the resolved-value type, with exactly **one** cast in exactly one
file, restoring type-checking to every mock in the suite.

**How I'd apply it:** when a codebase shows a *pattern* of identical casts, treat it as one
inference failure with many symptoms, not many failures — find the single type that fixes the
inference and delete the casts wholesale. Also: prefer promise-only client wrappers over
callback-overloaded APIs at module boundaries, precisely so test tooling can infer types.

## 2. CRDT convergence is real, but "no data loss" and "no surprise" are different guarantees

**Where:** the Yjs room keying in `web/src/components/Editor.tsx` (~L285-500, room =
`{roomPrefix}:{documentId}`) and the collaboration server in `api/src/collaboration/index.ts`;
observed behaviour captured in `e2e/collab-convergence.spec.ts` and
`bench/cat5-collab/out/convergence-rebaseline-0bfc3d6.json`.

**What it does / why it matters:** two users editing the same document share a Yjs room keyed only
by document id; CRDT merge guarantees convergence without a server arbiter. Running two real
browser sessions concurrently (which the Phase-1 audit never did) confirmed convergence in
≤848 ms and zero character loss — but also surfaced something code-reading never predicted: two
users typing at the *same* position get their text interleaved **character by character**
(`alphbar-a1v7o8-…`). Mathematically correct, visually bizarre. It also taught me that each
editor renders the *other* user's cursor label into the DOM, so naive DOM comparison of "converged"
editors never matches.

**How I'd apply it:** never let "the CRDT guarantees convergence" end the conversation — test the
*user-visible* merge behaviour at conflict points, and design collaborative UX (cursor presence,
paragraph-level locking, or operational hints) around the interleaving reality. And when asserting
on collaborative DOM, strip presence artifacts first.

## 3. One enum import can pin 267 kB into your entry chunk — code splitting is a module-graph property, not a config option

**Where:** `web/src/components/EmojiPicker.tsx:1-12` (the fix, with the reasoning in comments);
before/after in `bench/cat2-bundle/out/rebaseline-8e69a59-attribution.txt` →
`after-c22fea4-totals.json`.

**What it does / why it matters:** the sidebar — mounted on every authenticated page — imported
`EmojiPicker` from `emoji-picker-react`, whose 266.7 kB rode in the entry chunk although the picker
only renders when a popover opens. Converting the component to `React.lazy` was *not enough*: the
file also imported `Theme`, a runtime **enum**, and any value import retains the whole module in
the static graph. The split only took effect after making the imports `import type` and supplying
the theme as a checked literal. Combined with lazy-loading the two editor-carrying routes, the
entry chunk fell from 2,025 kB to 808 kB (−60%), verified end-to-end by a real 3G cold-load
measurement (605 kB → 243 kB transferred).

**How I'd apply it:** treat bundle splitting as a graph-reachability exercise — `React.lazy` on a
component does nothing if a value import (an enum, a constant, a helper) keeps a static edge to the
module. Audit imports with `import type` discipline, verify with a sourcemap attributor rather than
trusting the config, and prove it with a network-level measurement, because the chunk list can lie
about what the first paint actually downloads.
