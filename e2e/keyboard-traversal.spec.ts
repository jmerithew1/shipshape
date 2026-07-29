import { test, expect, Page } from './fixtures/dev-server'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

/**
 * Real Keyboard Traversal — post-audit measurement + Cat-7 regression guard
 *
 * The Phase-1 audit's keyboard results were programmatic (tabbable-set analysis);
 * no key was ever pressed (AUDIT_REPORT.md § Measurement limits, ★ Real keyboard
 * traversal). This spec delivers real Tab/Shift+Tab/Enter keystrokes and records
 * the observed focus order as evidence.
 *
 * Hard assertions cover behavior that must hold: login form reachable by Tab,
 * no keyboard trap on the document list, editor reachable, Enter activates.
 * Focus-visibility per stop is RECORDED (not asserted) — the 2.89:1 focus ring
 * is a known Cat-7 finding; after the fix lands this data is the before/after.
 *
 * Runs against live dev servers (pnpm dev). Self-skips if they are not up so
 * the isolated e2e suite stays green without them.
 *
 * Evidence: bench/cat7-a11y/out/keyboard-traversal-<label>-<sha>.json
 * (label from BENCH_LABEL, default "rebaseline")
 */

const REPO_ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(REPO_ROOT, 'bench', 'cat7-a11y', 'out')
const SHA = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim()
const LABEL = process.env.BENCH_LABEL || 'rebaseline'

interface FocusStop {
  step: number
  tag: string
  role: string | null
  name: string
  id: string | null
  focusVisible: boolean
}

async function devServersUp(webUrl: string): Promise<boolean> {
  try {
    const res = await fetch(webUrl, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function login(page: Page, email = 'dev@ship.local', password = 'admin123') {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 })
}

async function captureActiveElement(page: Page, step: number): Promise<FocusStop> {
  return page.evaluate((s) => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) {
      return { step: s, tag: 'BODY', role: null, name: '', id: null, focusVisible: false }
    }
    const style = getComputedStyle(el)
    const focusVisible =
      (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow !== 'none'
    const name =
      el.getAttribute('aria-label') ||
      (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
      el.textContent?.trim().slice(0, 60) ||
      ''
    return {
      step: s,
      tag: el.tagName,
      role: el.getAttribute('role'),
      name,
      id: el.id || null,
      focusVisible,
    }
  }, step)
}

async function tabWalk(page: Page, maxSteps: number): Promise<FocusStop[]> {
  const stops: FocusStop[] = []
  for (let i = 0; i < maxSteps; i++) {
    await page.keyboard.press('Tab')
    stops.push(await captureActiveElement(page, i + 1))
  }
  return stops
}

/** A trap = the same element holding focus for 5 consecutive real Tab presses. */
function findTrap(stops: FocusStop[]): FocusStop | null {
  let runStart = 0
  for (let i = 1; i <= stops.length; i++) {
    const same =
      i < stops.length &&
      stops[i].tag === stops[runStart].tag &&
      stops[i].id === stops[runStart].id &&
      stops[i].name === stops[runStart].name &&
      stops[i].tag !== 'BODY'
    if (!same) {
      if (i - runStart >= 5) return stops[runStart]
      runStart = i
    }
  }
  return null
}

const evidence: Record<string, unknown> = {
  sha: SHA,
  label: LABEL,
  date: new Date().toISOString(),
  method: 'real page.keyboard.press Tab/Shift+Tab/Enter via Playwright + CDP against live dev servers',
}

test.describe('real keyboard traversal', () => {
  test.beforeEach(async ({ webUrl }) => {
    test.skip(
      !(await devServersUp(webUrl)),
      'Dev servers not running. Start them with: pnpm dev (see bench/README.md conditions)'
    )
  })

  test.afterAll(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR, `keyboard-traversal-${LABEL}-${SHA}.json`)
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  })

  test('login form is fully reachable with real Tab keys', async ({ page }) => {
    await page.context().clearCookies()
    await page.goto('/login')
    await page.locator('#email').waitFor({ state: 'visible' })

    const stops = await tabWalk(page, 15)
    evidence.loginTraversal = stops

    const reached = (pred: (s: FocusStop) => boolean) => stops.some(pred)
    // Real keystrokes must reach email, password, and the submit button.
    expect(reached(s => s.id === 'email'), 'email field reachable by Tab').toBe(true)
    expect(reached(s => s.id === 'password'), 'password field reachable by Tab').toBe(true)
    expect(
      reached(s => s.tag === 'BUTTON' && /sign in/i.test(s.name)),
      'Sign in button reachable by Tab'
    ).toBe(true)

    // Shift+Tab must reverse (no one-way traversal).
    const before = await captureActiveElement(page, -1)
    await page.keyboard.press('Shift+Tab')
    const after = await captureActiveElement(page, -1)
    expect(after.tag !== before.tag || after.id !== before.id || after.name !== before.name,
      'Shift+Tab moves focus backwards').toBe(true)
  })

  test('Enter submits the login form from the keyboard alone', async ({ page }) => {
    await page.context().clearCookies()
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    // Focus the button with keys, then activate with Enter — no mouse.
    await page.locator('#password').focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 })
    evidence.enterActivatesLogin = true
  })

  test('document list has no keyboard trap in 100 real Tab presses', async ({ page }) => {
    test.setTimeout(120000)
    await login(page)
    await page.goto('/docs')
    await page.waitForLoadState('networkidle')

    const stops = await tabWalk(page, 100)
    evidence.docsTraversal = stops
    evidence.docsFocusVisibleRatio =
      stops.filter(s => s.tag !== 'BODY').length === 0
        ? null
        : stops.filter(s => s.tag !== 'BODY' && s.focusVisible).length /
          stops.filter(s => s.tag !== 'BODY').length

    const trap = findTrap(stops)
    expect(trap, `keyboard trap at ${trap ? `${trap.tag}#${trap.id} "${trap.name}"` : ''}`).toBeNull()

    // Traversal must actually visit interactive elements, not stay on BODY.
    const interactive = stops.filter(s => s.tag !== 'BODY')
    expect(interactive.length, 'Tab reaches interactive elements').toBeGreaterThan(10)

    // Unnamed interactive stops are the Cat-7 ARIA finding — recorded, not asserted.
    evidence.docsUnnamedStops = interactive.filter(s => !s.name && !s.id)
  })

  test('editor is reachable from the keyboard on a document page', async ({ page }) => {
    test.setTimeout(120000)
    await login(page)
    await page.goto('/docs')
    await page.waitForLoadState('networkidle')

    // Open the first document in the list via keyboard-visible navigation.
    const docLink = page.locator('a[href*="/documents/"]').first()
    await expect(docLink).toBeVisible({ timeout: 10000 })
    await docLink.click()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15000 })

    // Walk Tab until the editor (or contenteditable) takes focus.
    let editorFocused = false
    const stops: FocusStop[] = []
    for (let i = 0; i < 60 && !editorFocused; i++) {
      await page.keyboard.press('Tab')
      const stop = await captureActiveElement(page, i + 1)
      stops.push(stop)
      editorFocused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        return !!el && (el.isContentEditable || el.closest('.ProseMirror') !== null)
      })
    }
    evidence.editorTraversal = stops
    evidence.editorReachableByTab = editorFocused
    expect(editorFocused, 'editor focusable via real Tab presses').toBe(true)
  })
})
