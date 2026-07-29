# NVDA Session Results — 2026-07-29

**Executed by:** James Merithew (manual session per [`docs/nvda-session-script.md`](../../../docs/nvda-session-script.md))
**Status:** NOT YET EXECUTED — template awaiting session results
**NVDA version:** ___
**Browser + version:** ___
**App:** local dev (`pnpm dev`), commit `___`
**Login:** dev@ship.local (super-admin)

Fill *Observed* with what NVDA actually announced (paste from Speech Viewer). Verdicts:
**Pass** (announced as expected) / **Partial** (announced but degraded) / **Fail** (silent, unnamed,
or wrong).

## Part A — Login page

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| A1 | Page load announcement | Title identifies the app | | |
| A2 | Form field labels | "Email, edit" / "Password, edit, protected" / "Sign in, button" | | |
| A3 | Error announcement | Login error announced via live region | | |
| A4 | Post-login transition | Route change produces some announcement | | |

## Part B — Landmarks and headings

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| B1 | `D` landmark navigation | Reaches a `main` landmark + nav landmark(s) | | |
| B2 | `H` heading navigation | Sensible heading outline | | |
| B3 | NVDA+F7 elements list | Landmarks + headings lists transcribed | | |

## Part C — Document list

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| C1 | Icon rail / sidebar names | Every control announces a name | | |
| C2 | Document list semantics | Entries announce titles with structure | | |
| C3 | Opening a document | Navigation announced, not silent | | |

## Part D — Editor

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| D1 | Editor discovery | Announces editable region | | |
| D2 | Typing echo | Characters/words echoed | | |
| D3 | Reading structure | Headings/lists announce roles | | |
| D4 | Toolbar control names | Named buttons with state | | |

## Part E — Dialogs and focus

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| E1 | Dialog announcement | "dialog" + title announced | | |
| E2 | Focus trap (10+ Tabs) | Focus stays inside dialog | | |
| E3 | Escape + focus return | Closes; focus returns to opener | | |

## Summary

- Pass: ___ / 17 · Partial: ___ · Fail: ___
- Findings confirmed from Phase-1 reasoning (cite finding): ___
- Findings revised by observation: ___
- New findings only NVDA could reveal: ___

## Raw transcript appendix

```
(paste Speech Viewer contents here, or reference nvda-transcript-2026-07-29.txt)
```
