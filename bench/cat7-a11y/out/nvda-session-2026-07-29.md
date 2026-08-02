# NVDA Session Results — 2026-07-30

> Filename note: the file keeps its scheduled-date name (`-2026-07-29`) because other documents
> link it; the session itself ran 2026-07-30, as dated below.

**Executed by:** James Merithew (manual session per [`docs/nvda-session-script.md`](../../../docs/nvda-session-script.md));
Speech Viewer transcripts dictated live and transcribed verbatim.
**Status:** EXECUTED 2026-07-30 — 13 pass / 2 partial / 0 fail / 1 not exercised. Environment
note: initial Chrome session produced no landmark/heading announcements until the page window was
properly focused ("Chrome Legacy Window" announcements in raw transcripts are the assistant window
on a second monitor, not the app).
**NVDA version:** 2026.1.1 (not noted during the session; read from the session machine's
registry 2026-07-31, one day after — no NVDA update in between)
**Browser + version:** Chrome 150.0.7871.187 (same machine-inspected caveat as above)
**App:** local dev (`pnpm dev`); exact checked-out commit not recorded at session time — the
session results were committed the same day in `00f2e0c`
**Login:** dev@ship.local (super-admin)

Verdict vocabulary: **Pass** (announced as expected) / **Partial** (announced but degraded) /
**Fail** (silent, unnamed, or wrong). *Observed* cells are pasted from NVDA's Speech Viewer.

## Part A — Login page

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| A1 | Page load announcement | Title identifies the app | "Ship - Project Management & Documentation, document" — a real identifying title (contrast with the in-app generic title, see C3) | **Pass** |
| A2 | Form field labels | "Email, edit" / "Password, edit, protected" / "Sign in, button" | Captured: "form landmark" · "**Password, edit, protected, required**" · "Sign in, button". The Email field's own announcement was not captured in the transcript, so it is not claimed | **Partial** (password + submit verified; email announcement uncaptured) |
| A3 | Error announcement | Login error announced via live region | "**alert** — Invalid email or password" — spoken automatically on submit | **Pass** |
| A4 | Post-login transition | Route change produces some announcement | Not separately captured; SPA route announcement behaviour assessed at C3 (generic title spoken, document name not) | **See C3** |

## Part B — Landmarks and headings

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| B1 | `D` landmark navigation | Reaches a `main` landmark + nav landmark(s) | "link Skip to main content · Primary navigation, navigation landmark · Document list, complementary landmark · **main landmark** · Document properties, complementary landmark · no next landmark" | **Pass** |
| B2 | `H` heading navigation | Sensible heading outline | "Dashboard heading level 2 (sidebar) · **Week 14 heading level 1** · ASSIGNED PROJECTS level 2 · WEEKLY PLAN level 2 · WEEKLY RETRO level 2 · DAILY UPDATES level 2 · no next heading" | **Pass** |
| B3 | NVDA+F7 elements list | Landmarks + headings lists transcribed | Covered by the full `D`/`H` sweeps above (equivalent data; both sweeps ran to "no next…" exhaustion from `Ctrl+Home`) | **Pass** |

## Part C — Document list

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| C1 | Icon rail / sidebar names | Every control announces a name | All named: "2 accountability items are due today · View items, button" · "S, button, Ship Workspace" · Dashboard/Docs/Programs/Projects/"Teams (standup due)"/Settings buttons · "D, button, Dev User – Click to logout" · "Collapse sidebar, button". No anonymous button/link in the pass | **Pass** |
| C2 | Document list semantics | Entries announce titles with structure | "Documents, tree view, level 1"; each entry: "Untitled, visited, link" + "Delete document, button" + "Add sub-document, button". Structure and per-item actions fully announced. Observation: many test-created docs share the literal title "Untitled", indistinguishable by ear — content issue, not markup | **Pass** |
| C3 | Opening a document | Navigation announced, not silent | Announced via document change: "Ship \| Ship — document". Not silent, but the page title is the generic app title — the opened document's own name is never spoken, so the user cannot tell *which* document loaded | **Partial** — finding: route changes should update `document.title` to the document name |

## Part D — Editor

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| D1 | Editor discovery | Announces editable region | "section, multi line, editable" — exposed as an editable multiline region, but with no accessible name (nothing identifies it as the document body) | **Pass** (note: unnamed region) |
| D2 | Typing echo | Characters/words echoed | Full per-character echo ("H, e, l, l, o, space, … number" for `#`); full-line readback on arrow ("Hello I am a dog # dog") | **Pass** |
| D3 | Reading structure | Headings/lists announce roles | `#`-shortcut heading announced as "**heading, level 1**, dog" when arrowed onto | **Pass** |
| D4 | Toolbar control names | Named buttons with state | Not exercised in this session (formatting bubble menu not tested) | **Not exercised** |

## Part E — Dialogs and focus

| # | Probe | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| E1 | Dialog announcement | "dialog" + title announced | Delete confirmation: "localhost:5173 says, dialog, Are you sure you want to delete this document? OK, button, 1 of 2". **Caveat:** this is the browser-native `confirm()` — accessible by default; not the app's custom modal code | **Pass** (native dialog) |
| E2 | Focus trap (10+ Tabs) | Focus stays inside dialog | 10+ Tabs cycled strictly OK (1 of 2) ↔ Cancel (2 of 2); never left the dialog | **Pass** (native dialog) |
| E3 | Escape + focus return | Closes; focus returns to opener | Escape closed it; focus returned to and re-announced "Delete document, button" | **Pass** (native dialog) |
| E4 | Custom modal (View items) — the audit's aria-modal finding | Announced as dialog; focus trapped; Escape returns focus | "Action Items, **dialog**, You have 2 pending items (1 overdue)"; 3+ full Tab cycles stayed strictly within POST STANDUP → WRITE RETRO → Got it → Close; Escape closed and re-announced the opening banner button | **Pass** — **revises the Phase-1 reasoned finding**: the statically-predicted "aria-modal without focus trap" did not reproduce on this modal under real NVDA; observed behavior is a working trap with correct focus return (other flagged dialogs not exercised) |

## Summary

- **Pass: 13** (A1, A3, B1, B2, B3, C1, C2, D1, D2, D3, E1, E2, E3, plus E4) · **Partial: 2** (A2 —
  evidence gap only; C3 — real finding) · **Fail: 0** · **Not exercised: 1** (D4 toolbar)
- **Findings confirmed from Phase-1 reasoning:** landmark structure and skip link work as the
  markup suggested (B1); axe's clean login-form results hold under real AT (A1–A3).
- **Findings revised by observation:** the Phase-1 static claim that dialogs declare `aria-modal`
  but never trap focus **did not reproduce** on the Action Items modal — E4 observed a working trap
  over 3+ Tab cycles with correct Escape/focus-return (other flagged dialogs not exercised). The
  audit-era "Escape does not close the modal" withdrawal is likewise confirmed correct: Escape works.
- **New findings only NVDA could reveal:** (1) opening a document announces only the generic app
  title — the document's name is never spoken (C3): `document.title` should update per document;
  (2) the editor region carries no accessible name (D1); (3) many test-created documents share the
  audible title "Untitled" — indistinguishable by ear (C2, content-level).

## Raw transcript appendix

Transcripts were dictated live in-session and transcribed verbatim into the Observed column above;
the environment note in the header explains the "Chrome Legacy Window" lines (assistant window on a
second monitor). NVDA + Chrome on Windows 11, app served by `pnpm dev`. No separate transcript
file was kept — the Observed column above is the record.
