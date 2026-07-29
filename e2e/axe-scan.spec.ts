import { test, expect, Page } from './fixtures/dev-server'
import AxeBuilder from '@axe-core/playwright'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

/**
 * axe-core scan of the three most important pages — Cat 7 measurement +
 * regression guard.
 *
 * Risk mitigated: reintroducing Critical/Serious WCAG violations on the
 * login page, the document list, or the main dashboard would regress the
 * app for assistive-technology users and silently falsify the accessibility
 * claims in the README.
 *
 * Records ALL violations to bench/cat7-a11y/out/axe-<label>-<sha>.json.
 * Asserts zero Critical/Serious once the Cat-7 fixes land (the assertion is
 * against the improvement target: "fix all Critical/Serious violations on
 * the 3 most important pages"). Set AXE_RECORD_ONLY=1 to capture a baseline
 * without failing.
 */

const REPO_ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(REPO_ROOT, 'bench', 'cat7-a11y', 'out')
const SHA = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim()
const LABEL = process.env.BENCH_LABEL || 'run'
const RECORD_ONLY = process.env.AXE_RECORD_ONLY === '1'

async function devServersUp(webUrl: string): Promise<boolean> {
  try {
    const res = await fetch(webUrl, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function login(page: Page) {
  await page.addInitScript(() => localStorage.setItem('ship:disableActionItemsModal', 'true'))
  await page.goto('/login')
  await page.locator('#email').fill('dev@ship.local')
  await page.locator('#password').fill('admin123')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 })
}

interface PageResult {
  page: string
  critical: number
  serious: number
  moderate: number
  minor: number
  violations: { id: string; impact: string | null | undefined; nodes: number; help: string; targets: string[] }[]
}

const results: PageResult[] = []

async function scan(page: Page, name: string): Promise<PageResult> {
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 }
  for (const v of axe.violations) {
    if (v.impact && v.impact in counts) counts[v.impact as keyof typeof counts] += 1
  }
  const r: PageResult = {
    page: name,
    ...counts,
    violations: axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => String(n.target)),
    })),
  }
  results.push(r)
  return r
}

test.describe('axe-core: three most important pages', () => {
  test.beforeEach(async ({ webUrl }) => {
    test.skip(!(await devServersUp(webUrl)), 'Dev servers not running. Start them with: pnpm dev')
  })

  test.afterAll(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(OUT_DIR, `axe-${LABEL}-${SHA}.json`),
      JSON.stringify({ sha: SHA, label: LABEL, date: new Date().toISOString(), results }, null, 2)
    )
  })

  test('login page has no Critical/Serious violations', async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').waitFor({ state: 'visible' })
    const r = await scan(page, '/login')
    if (!RECORD_ONLY) {
      expect(r.critical + r.serious, JSON.stringify(r.violations, null, 1)).toBe(0)
    }
  })

  test('document list has no Critical/Serious violations', async ({ page }) => {
    test.setTimeout(120000)
    await login(page)
    await page.goto('/docs')
    await page.waitForLoadState('networkidle')
    const r = await scan(page, '/docs')
    if (!RECORD_ONLY) {
      expect(r.critical + r.serious, JSON.stringify(r.violations, null, 1)).toBe(0)
    }
  })

  test('main page (my-week) has no Critical/Serious violations', async ({ page }) => {
    test.setTimeout(120000)
    await login(page)
    await page.goto('/my-week')
    await page.waitForLoadState('networkidle')
    const r = await scan(page, '/my-week')
    if (!RECORD_ONLY) {
      expect(r.critical + r.serious, JSON.stringify(r.violations, null, 1)).toBe(0)
    }
  })
})
