# Failing E2E tests — reconciliation (2026-07-31)

The original version of this document (inherited with the codebase, committed 2026-01-07 in
`ce22898`, preserved verbatim below) listed **15 failing E2E tests across 6 categories**. It
predates the week-4 audit by six months and was written against a suite that has since changed
substantially. Reviewer feedback on the week-4 submission flagged it as still describing 15
failures, so on 2026-07-31 every listed test was traced to the current suite and every survivor
was re-run on this host.

**Result: 0 of the 15 documented failures exist today.** 10 of the 15 tests no longer exist in
the suite (removed or replaced in repo history, before and independent of the week-4 work);
the 5 that survive all pass.

Prerequisite: the suite could not run on this Windows host at all when the audit was taken
(AUDIT_REPORT.md Cat 5, "E2E does not run on this host — two repo defects"). Defect 1 (POSIX
inline-env in the web build script) was fixed in `ebd8f95`; defect 2 (`spawn('npx')` without a
Windows-runnable target in `e2e/fixtures/isolated-env.ts`) is fixed alongside this reconciliation
— the Vite preview server is now spawned as `node .../vite/bin/vite.js`, which is what made these
re-runs possible.

## Per-test disposition

Commands run 2026-07-31 (Docker testcontainers per worker, per `playwright.config.ts`):

```
pnpm exec playwright test e2e/programs.spec.ts e2e/issues-bulk-operations.spec.ts \
  e2e/security.spec.ts --workers=4
pnpm exec playwright test e2e/program-mode-week-ux.spec.ts --workers=1   # serial file
```

| # | Documented failing test | Disposition today |
| --- | --- | --- |
| 1–4 | `programs.spec` — Feedback-tab tests (×4) | **Test and feature no longer exist.** The program editor's tabs are now Overview / Issues / Weeks (`e2e/programs.spec.ts:62`); the Feedback tab and its four tests were removed in repo history. The replacement tab tests pass: `programs.spec.ts` **16/16**. |
| 5–7 | `issues-bulk-operations.spec` — context-menu tests (×3) | **Still exist; all pass.** The file is exactly these three tests: **3/3** (right-click opens menu, archive via menu, Change Status option). |
| 8–11 | `offline-07/08/11` — offline tests (×4) | **Specs deleted upstream** in `3f5ec31` "Delete offline E2E tests (functionality removed)". The offline feature itself was removed from the product; nothing to run. |
| 12 | `security.spec` — `authenticated routes require auth` | **Still exists; passes** (`e2e/security.spec.ts:435`). Whole file: **18/18**. |
| 13 | `race-conditions.spec` — `concurrent edits in same location converge` | **Test no longer exists** in `race-conditions.spec.ts`. Equivalent (stronger) coverage was added in week 4: `e2e/collab-convergence.spec.ts` asserts CRDT no-character-loss for same-position concurrent edits (Cat-5 evidence, `CHANGES.md`). |
| 14 | `accessibility-remediation.spec` — `draggable issues can be moved with keyboard` | **Test no longer exists** in the file. Keyboard access is covered by the week-4 `e2e/keyboard-traversal.spec.ts` (4/4, Cat-7 evidence). |
| 15 | `program-mode-sprint-ux.spec` — `issues table has checkbox column` | **File renamed** to `program-mode-week-ux.spec.ts` (sprint→week rename); the test exists at `:684` and **passes**. Whole file (serial): **66/66 passed** (6.2 m, `--workers=1`). |

## Flake note (disclosed, not hidden)

In the first 4-worker run, `program-mode-week-ux.spec.ts:369` ("clicking sprint card selects it
in the chart") failed twice (run + retry) and — because the file is `test.describe.configure({
mode: 'serial' })` — aborted the remaining 47 tests in that file. The same test passes in
isolation and in the single-worker re-run of the whole file (66/66). This is host-load flakiness of the
same class the audit measured (619 hard-coded `waitForTimeout` sleeps across the suite), not a
product defect; the serial file should be run with `--workers=1`, as its header comment implies.

---

## Original document (2026-01-07, inherited — preserved verbatim)

# Failing E2E Tests Analysis

Generated: $(date)

**Summary: 15 failing tests across 6 categories**

## Categories

### 1. Program Tabs - Feedback Tab Not Found (4 tests)
Tests expect a "Feedback" tab in program editor that may have been renamed/removed:
- programs.spec__program_editor_has_tabbed_navigation__Overview__Is
- programs.spec__can_switch_between_program_tabs
- programs.spec__can_give_feedback_from_program_Feedback_tab
- programs.spec__Feedback_tab_shows_filter_options

**Fix**: Check if Feedback tab exists or update tests to match current UI

### 2. Context Menu Tests (3 tests)
Right-click context menu not appearing:
- issues-bulk-operations.spec__can_right_click_to_open_context_menu
- issues-bulk-operations.spec__can_archive_an_issue_via_context_menu  
- issues-bulk-operations.spec__context_menu_shows_change_status_option

**Fix**: Verify context menu implementation and aria-label

### 3. Offline Tests (3 tests)
Offline functionality issues:
- offline-07-session-handling.spec__app_remains_usable_offline_even_with_expired_sessi
- offline-07-session-handling.spec__session_expiry_during_offline_does_not_lose_local_
- offline-08-websocket.spec__WebSocket_reconnects_automatically_when_online
- offline-11-multi-tab.spec__changes_in_one_offline_tab_appear_in_another_offli

**Fix**: Review offline implementation and sync status text ("SavedSaved" duplicate)

### 4. Security Test (1 test)
- security.spec__authenticated_routes_require_auth
Expected redirect to /login but got /projects - possible test isolation issue

**Fix**: Check test setup/teardown for session leakage

### 5. Race Conditions (1 test)
- race-conditions.spec__concurrent_edits_in_same_location_converge
Editor content empty when expected "Initial text" - timing issue

**Fix**: Add wait for content or increase timeout

### 6. UI Element Tests (2 tests)
- accessibility-remediation.spec__draggable_issues_can_be_moved_with_keyboard
- program-mode-sprint-ux.spec__issues_table_has_checkbox_column_for_bulk_selectio

**Fix**: Verify UI elements exist and have correct selectors
