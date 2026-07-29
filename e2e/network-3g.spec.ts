import { test, expect, Page } from './fixtures/dev-server'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

/**
 * 3G / Throttled-Network Behaviour — post-audit measurement
 *
 * The Phase-1 audit found 15 silent failures via code paths and induced API
 * errors, but never degraded the connection; hanging spinners under slow
 * networks were unmeasured (AUDIT_REPORT.md § Measurement limits,
 * ★ 3G / throttled-network behaviour). This spec throttles via CDP
 * Network.emulateNetworkConditions to Regular-3G and Slow-3G and measures the
 * cold login render plus the authenticated docs → editor flow, recording load
 * timings and whether every loading indicator eventually resolves.
 *
 * Hard assertions are generous eventual-progress bounds (the page must become
 * usable); exact timings and spinner counts land in the JSON evidence and feed
 * the Cat-2 before/after once code splitting ships.
 *
 * Runs against live dev servers (pnpm dev); self-skips when they are not up.
 * Evidence: bench/cat2-bundle/out/3g-<label>-<sha>.json
 */

const REPO_ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(REPO_ROOT, 'bench', 'cat2-bundle', 'out')
const SHA = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim()
const LABEL = process.env.BENCH_LABEL || 'rebaseline'

// Chrome DevTools' canonical presets (bytes/second).
const PROFILES = {
  'regular-3g': { latency: 100, downloadThroughput: (750 * 1024) / 8, uploadThroughput: (250 * 1024) / 8 },
  'slow-3g': { latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 },
} as const

type ProfileName = keyof typeof PROFILES

async function devServersUp(webUrl: string): Promise<boolean> {
  try {
    const res = await fetch(webUrl, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function throttle(page: Page, profile: ProfileName) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    ...PROFILES[profile],
  })
  return cdp
}

async function login(page: Page, email = 'dev@ship.local', password = 'admin123') {
  await page.goto('/login')
  await page.locator('#email').waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 })
}

/** Count loading indicators still visible right now. */
async function visibleSpinners(page: Page): Promise<number> {
  return page.evaluate(() => {
    const candidates = document.querySelectorAll(
      '[role="progressbar"], [class*="spinner" i], [class*="loading" i], [aria-busy="true"]'
    )
    let visible = 0
    candidates.forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      const style = getComputedStyle(el as HTMLElement)
      if (r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
        visible++
      }
    })
    return visible
  })
}

const evidence: Record<string, unknown> = {
  sha: SHA,
  label: LABEL,
  date: new Date().toISOString(),
  method: 'CDP Network.emulateNetworkConditions (Chrome DevTools 3G presets) over live dev servers',
  profiles: PROFILES,
  runs: {} as Record<string, unknown>,
}

test.describe('3G throttled-network behaviour', () => {
  test.beforeEach(async ({ webUrl }) => {
    test.skip(
      !(await devServersUp(webUrl)),
      'Dev servers not running. Start them with: pnpm dev (see bench/README.md conditions)'
    )
  })

  test.afterAll(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR, `3g-${LABEL}-${SHA}.json`)
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  })

  for (const profile of Object.keys(PROFILES) as ProfileName[]) {
    test(`cold login page renders under ${profile}`, async ({ page }) => {
      test.setTimeout(180000)
      await page.context().clearCookies()
      await throttle(page, profile)

      const t0 = Date.now()
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 120000 })
      const domContentLoadedMs = Date.now() - t0
      await page.locator('#email').waitFor({ state: 'visible', timeout: 120000 })
      const formVisibleMs = Date.now() - t0

      const transferred = await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .reduce((sum, e) => sum + ((e as PerformanceResourceTiming).transferSize || 0), 0)
      )

      ;(evidence.runs as Record<string, unknown>)[`login-${profile}`] = {
        domContentLoadedMs,
        formVisibleMs,
        resourceBytesTransferred: transferred,
      }

      // The form must become usable — a hard eventual-progress bound.
      expect(formVisibleMs, 'login form visible within 120s under throttle').toBeLessThan(120000)
    })

    test(`authenticated docs → editor flow completes under ${profile}`, async ({ page }) => {
      test.setTimeout(300000)
      // Login at full speed (session setup is not the measurement), then throttle.
      await page.context().clearCookies()
      await login(page)
      await throttle(page, profile)

      const t0 = Date.now()
      await page.goto('/docs', { waitUntil: 'domcontentloaded', timeout: 180000 })
      const docLink = page.locator('a[href*="/documents/"]').first()
      await docLink.waitFor({ state: 'visible', timeout: 180000 })
      const listVisibleMs = Date.now() - t0

      const t1 = Date.now()
      await docLink.click()
      await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 180000 })
      const editorVisibleMs = Date.now() - t1

      // After the editor is up, every loading indicator must resolve within 60s
      // — this is the "hanging spinner" probe from the audit's silent-failure set.
      let spinners = -1
      const spinnerDeadline = Date.now() + 60000
      do {
        spinners = await visibleSpinners(page)
        if (spinners === 0) break
        await page.waitForTimeout(2000)
      } while (Date.now() < spinnerDeadline)

      ;(evidence.runs as Record<string, unknown>)[`flow-${profile}`] = {
        listVisibleMs,
        editorVisibleMs,
        spinnersRemainingAfterSettle: spinners,
      }

      expect(listVisibleMs, 'document list usable within 180s').toBeLessThan(180000)
      expect(editorVisibleMs, 'editor usable within 180s').toBeLessThan(180000)
      expect(spinners, 'all loading indicators resolve within 60s of editor load').toBe(0)
    })
  }
})
