# NVDA Screen-Reader Session — Execution Script

**Purpose.** The Phase-1 audit disclosed that screen-reader testing was never performed
(AUDIT_REPORT.md § Measurement limits). This script executes it for real. It is a ~30-minute manual
session; a human runs NVDA and records what it announces. Results go in
[`bench/cat7-a11y/out/nvda-session-2026-07-29.md`](../bench/cat7-a11y/out/nvda-session-2026-07-29.md)
(template already in place — fill the *Observed* and *Pass/Fail* columns).

**Why these steps:** each probes a specific Phase-1 finding made with axe-core/static analysis
(landmarks, unlabeled controls, dialog focus behavior, the editor). The session tests whether those
reasoned findings hold under a real assistive technology.

---

## Setup (10 min, once)

1. **Install NVDA** (free): https://www.nvaccess.org/download/ — run the installer, defaults are fine.
2. **Start NVDA**: `Ctrl+Alt+N`. It starts talking; that's normal.
   - Silence the voice if you prefer reading: NVDA menu (`NVDA+N` — the `NVDA` key is `Insert` or
     `CapsLock`) → Preferences → Settings → Speech → set Rate high, or just turn your volume down.
     Do NOT quit NVDA.
3. **Open Speech Viewer** (this is your transcript): NVDA menu (`NVDA+N`) → Tools → **Speech
   Viewer**. Everything NVDA says appears there as text. Keep this window visible on one side.
4. **Start the app** (Git Bash):
   ```bash
   cd "C:/Users/merit/OneDrive/Desktop/shipshape" && pnpm dev
   ```
   Note the web port it prints (default http://localhost:5173).
5. Open **Chrome or Edge** at that URL. Log in later per the script — don't log in yet.

**Recording convention:** after each numbered step, copy the relevant Speech Viewer lines into the
results file's *Observed* column (select text in Speech Viewer → `Ctrl+C`). Then mark Pass/Fail
against the *Expected* column. When in doubt, paste more transcript rather than less.

**Key legend:** `NVDA` = Insert (or CapsLock). Browse-mode single-key navigation only works when
NVDA is in browse mode (it says "browse mode" on page load; if it says "focus mode", press
`NVDA+Space` to toggle).

---

## Part A — Login page (5 min)

1. **A1 — Page load announcement.** Go to `http://localhost:5173/login` (adjust port). Listen.
   *Expected:* NVDA announces the page title and lands in the document; the title should identify
   the app (not blank, not "localhost").
2. **A2 — Form field labels.** Press `Tab` repeatedly through the form.
   *Expected:* each field announces a real label — "Email, edit", "Password, edit, protected" — and
   the submit announces "Sign in, button". *Fail if:* any field reads as just "edit" with no name.
3. **A3 — Error announcement.** Enter a wrong password (`dev@ship.local` / `wrongpass`), submit.
   *Expected:* the error message is announced automatically (live region), not just displayed
   silently. *Fail if:* you hear nothing and only see the error visually.
4. **A4 — Log in.** `dev@ship.local` / `admin123`, submit. Note what NVDA announces during the
   transition (route changes in SPAs are often silent — record whether anything is said).

## Part B — Landmarks and headings on the main app (7 min)

5. **B1 — Landmark navigation.** On the main page after login, press `D` repeatedly (browse mode:
   next landmark).
   *Expected:* you can reach a **main** landmark plus navigation landmark(s).
   *Fail if:* "no next landmark" or you cycle without ever hearing "main" — this is the
   `landmark-one-main` axe finding; record exactly which landmarks were announced.
6. **B2 — Heading navigation.** Press `H` repeatedly.
   *Expected:* a sensible heading outline (page title as H1 or H2, sections below). Record the
   sequence of headings and levels as announced.
7. **B3 — Elements list.** Press `NVDA+F7` (elements list) → Landmarks, then Headings. Screenshot
   or transcribe both lists into the results file.

## Part C — Document list and navigation (5 min)

8. **C1 — Sidebar/icon rail.** Tab from the top of the page through the icon rail and sidebar.
   *Expected:* every icon announces a name ("Documents, link/button" etc.).
   *Fail if:* you hear "button" or "link" with no accessible name — count and note each.
9. **C2 — Document list.** Navigate to the Docs area, arrow/Tab through the document list.
   *Expected:* each entry announces its title; the list has a sensible structure (list/table
   semantics or labeled links).
10. **C3 — Open a document.** Press `Enter` on a document.
    *Expected:* some announcement of the navigation/new content (title, heading, or focus move).
    Record silence if silent.

## Part D — Editor (7 min)

11. **D1 — Editor discovery.** In an open document, Tab until you reach the editor body.
    *Expected:* the editor announces itself as an editable region ("edit multi line" or similar),
    ideally with a name.
12. **D2 — Typing echo.** Type a short sentence in the editor.
    *Expected:* NVDA echoes characters/words as you type (per its echo settings).
13. **D3 — Reading back.** Move the caret through existing content with arrow keys, including over
    a heading and a list item you create with `#` + space and `-` + space.
    *Expected:* line-by-line reading announces content and role changes ("heading level 1", "list
    item"). *Fail if:* structural elements read as plain text.
14. **D4 — Toolbar/formatting controls.** If a toolbar or bubble menu is reachable, Tab/arrow
    through it.
    *Expected:* each control has a name ("Bold, button, pressed/not pressed"). *Fail if:* unnamed
    buttons — this cross-checks the ~30 ARIA findings.

## Part E — Dialogs and focus (5 min)

15. **E1 — Open a dialog.** Trigger any modal (e.g. a delete confirmation, share dialog, or the
    Action Items modal if it appears).
    *Expected:* NVDA announces "dialog" and reads its title.
16. **E2 — Focus trap.** With the dialog open, Tab repeatedly (10+ times).
    *Expected:* focus cycles **within** the dialog.
    *Fail if:* focus escapes into the page behind — this is the Phase-1 "aria-modal without focus
    trap" finding; note which dialog.
17. **E3 — Escape and focus return.** Press `Escape`.
    *Expected:* dialog closes and focus returns to the control that opened it (NVDA re-announces
    it). Record where focus actually landed.

## Wrap-up

- Save/copy the full Speech Viewer text into the results file's *Raw transcript* appendix (or into
  `bench/cat7-a11y/out/nvda-transcript-2026-07-29.txt` if it's long).
- Fill every row's Pass/Fail. **Partial and Fail rows are the valuable ones** — describe exactly
  what was announced vs. expected.
- Note NVDA version (NVDA menu → Help → About) and browser version in the results header.

*After the Cat-7 fixes land (focus ring, landmarks, contrast), a 10-minute re-run of Parts B and E
gives before/after evidence — optional but high-value.*
