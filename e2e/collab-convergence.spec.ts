import { test, expect, Page } from './fixtures/dev-server'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

/**
 * Concurrent Two-User Editing — post-audit measurement + Cat-5 regression test
 *
 * The Phase-1 audit derived the CRDT behavior of concurrent editing from code
 * paths only; two simultaneous sessions were never exercised (AUDIT_REPORT.md
 * § Measurement limits, ★ Concurrent two-user editing). Real-time sync also has
 * zero test coverage (Cat 5). This spec runs two authenticated browser contexts
 * (dev@ship.local and bob.martinez@ship.local) in the SAME Yjs room — same
 * /documents/:id URL — and asserts:
 *   1. concurrent edits at different positions converge on both editors
 *   2. same-position concurrent edits lose no characters (CRDT guarantee)
 *
 * Risk this mitigates: a silent regression in the Yjs/WebSocket pipeline would
 * corrupt or drop collaborative edits — user-facing data loss.
 *
 * Runs against live dev servers (pnpm dev); self-skips when they are not up.
 * Evidence: bench/cat5-collab/out/convergence-<label>-<sha>.json
 */

const REPO_ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(REPO_ROOT, 'bench', 'cat5-collab', 'out')
const SHA = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim()
const LABEL = process.env.BENCH_LABEL || 'rebaseline'

async function devServersUp(webUrl: string): Promise<boolean> {
  try {
    const res = await fetch(webUrl, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function login(page: Page, email: string, password = 'admin123') {
  await page.goto('/login')
  await page.locator('#email').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 })
}

async function createDocument(page: Page): Promise<string> {
  await page.goto('/docs')
  await page.waitForLoadState('networkidle')
  const currentUrl = page.url()
  const sidebarButton = page.locator('aside').getByRole('button', { name: /new|create|\+/i }).first()
  const mainButton = page.getByRole('button', { name: 'New Document', exact: true })
  if (await sidebarButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sidebarButton.click()
  } else {
    await expect(mainButton).toBeVisible({ timeout: 5000 })
    await mainButton.click()
  }
  await page.waitForFunction(
    (oldUrl) => window.location.href !== oldUrl && /\/documents\/[a-f0-9-]+/.test(window.location.href),
    currentUrl,
    { timeout: 10000 }
  )
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10000 })
  return page.url()
}

const editorText = (page: Page) => page.locator('.ProseMirror').innerText()

const evidence: Record<string, unknown> = {
  sha: SHA,
  label: LABEL,
  date: new Date().toISOString(),
  method:
    'two Playwright contexts, two distinct users, same /documents/:id (same Yjs room) over live dev servers',
}

test.describe('concurrent two-user editing', () => {
  test.beforeEach(async ({ webUrl }) => {
    test.skip(
      !(await devServersUp(webUrl)),
      'Dev servers not running. Start them with: pnpm dev (see bench/README.md conditions)'
    )
  })

  test.afterAll(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR, `convergence-${LABEL}-${SHA}.json`)
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  })

  test('edits at different positions converge on both editors', async ({ browser, baseURL }) => {
    test.setTimeout(120000)
    const ctxA = await browser.newContext({ baseURL })
    const ctxB = await browser.newContext({ baseURL })
    try {
      const pageA = await ctxA.newPage()
      const pageB = await ctxB.newPage()

      await login(pageA, 'dev@ship.local')
      const docUrl = await createDocument(pageA)
      evidence.docUrl = docUrl

      await login(pageB, 'bob.martinez@ship.local')
      await pageB.goto(docUrl)
      await expect(pageB.locator('.ProseMirror')).toBeVisible({ timeout: 15000 })

      const stamp = Date.now()
      const textA = `alpha-${stamp}`
      const textB = `bravo-${stamp}`

      // A types at the start; B appends at the end — concurrently.
      const typingDone = Date.now()
      await Promise.all([
        (async () => {
          await pageA.locator('.ProseMirror').click()
          await pageA.keyboard.press('Control+Home')
          await pageA.keyboard.type(textA, { delay: 20 })
        })(),
        (async () => {
          await pageB.locator('.ProseMirror').click()
          await pageB.keyboard.press('Control+End')
          await pageB.keyboard.type(textB, { delay: 20 })
        })(),
      ])

      // Both editors must contain BOTH edits (cross-user delivery, both directions).
      await expect(async () => {
        const [a, b] = await Promise.all([editorText(pageA), editorText(pageB)])
        expect(a).toContain(textA)
        expect(a).toContain(textB)
        expect(b).toContain(textA)
        expect(b).toContain(textB)
      }).toPass({ timeout: 15000 })
      const convergedAt = Date.now()

      // And converge to identical content.
      await expect(async () => {
        const [a, b] = await Promise.all([editorText(pageA), editorText(pageB)])
        expect(a).toBe(b)
      }).toPass({ timeout: 10000 })

      evidence.differentPositions = {
        convergenceMsUpperBound: convergedAt - typingDone,
        finalText: await editorText(pageA),
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('same-position concurrent edits lose no characters', async ({ browser, baseURL }) => {
    test.setTimeout(120000)
    const ctxA = await browser.newContext({ baseURL })
    const ctxB = await browser.newContext({ baseURL })
    try {
      const pageA = await ctxA.newPage()
      const pageB = await ctxB.newPage()

      await login(pageA, 'dev@ship.local')
      const docUrl = await createDocument(pageA)

      await login(pageB, 'bob.martinez@ship.local')
      await pageB.goto(docUrl)
      await expect(pageB.locator('.ProseMirror')).toBeVisible({ timeout: 15000 })

      // Both users put their caret at the same position (start) and type at once.
      const aChars = 'AAAAAAAAAA'
      const bChars = 'BBBBBBBBBB'
      await pageA.locator('.ProseMirror').click()
      await pageA.keyboard.press('Control+Home')
      await pageB.locator('.ProseMirror').click()
      await pageB.keyboard.press('Control+Home')

      await Promise.all([
        pageA.keyboard.type(aChars, { delay: 30 }),
        pageB.keyboard.type(bChars, { delay: 30 }),
      ])

      // CRDT guarantee: no character from either user may be lost, and both
      // editors converge to the same interleaving.
      await expect(async () => {
        const [a, b] = await Promise.all([editorText(pageA), editorText(pageB)])
        expect(a).toBe(b)
        const countA = (a.match(/A/g) || []).length
        const countB = (a.match(/B/g) || []).length
        expect(countA, 'no A characters lost').toBeGreaterThanOrEqual(aChars.length)
        expect(countB, 'no B characters lost').toBeGreaterThanOrEqual(bChars.length)
      }).toPass({ timeout: 15000 })

      evidence.samePosition = {
        converged: true,
        finalText: await editorText(pageA),
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
