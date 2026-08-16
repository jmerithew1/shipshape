/**
 * Developer portal — the Replay button.
 *
 * Testing Scenario 8 in the brief ends with an instruction no other test in
 * this repo carries out: "Click 'Replay' against a now-healthy subscriber and
 * verify the replay succeeds with the original idempotency key intact."
 *
 * `drills/idempotency.drill.test.ts` proves that contract at the API layer, and
 * proves it well. What it cannot prove is that the portal is wired to it — and
 * the portal's webhook tabs were calling a 404 endpoint as recently as 5be3709,
 * with every unit test still green, because nothing clicked anything. This spec
 * closes that gap: it drives the actual button and asserts on the row the API
 * writes back.
 *
 * The dead-lettered delivery is seeded straight into Postgres rather than
 * produced by a real failing delivery. That is deliberate. The deliverer's SSRF
 * guard is pinned ON in production wiring (`webhooks/index.ts` passes
 * `allowPrivateTargets: false` explicitly, so no environment variable can
 * relax it), which means a subscription here cannot legally target a local
 * listener — and reaching a public URL would make this test depend on the
 * internet. Seeding the terminal state directly keeps the test hermetic and
 * still exercises everything this spec is about: the portal query, the button,
 * the replay endpoint, and the row it produces.
 */
import { test, expect } from './fixtures/isolated-env';
import { Pool } from 'pg';

const APP_CLIENT_ID = 'ship_app_portal_replay_spec';
const ORIGINAL_IDEMPOTENCY_KEY = 'idem_portal_replay_original';

test.describe('Developer portal — Replay', () => {
  test('clicking Replay re-sends a dead-lettered delivery with the original idempotency key', async ({
    page,
    dbContainer,
  }) => {
    const pool = new Pool({ connectionString: dbContainer.getConnectionUri() });

    let deliveryId!: string;
    let appId!: string;

    try {
      // ── Seed: an app, a subscription, and one dead-lettered delivery ──────
      // Owner/workspace are taken from the seeded dev user so the portal's
      // session-authed queries (which scope by workspace) can see them.
      const { rows: whoami } = await pool.query<{ id: string; workspace_id: string }>(
        `SELECT u.id, wm.workspace_id
           FROM users u
           JOIN workspace_memberships wm ON wm.user_id = u.id
          WHERE u.email = 'dev@ship.local'
          LIMIT 1`
      );
      expect(whoami.length, 'seeded dev user must exist').toBe(1);
      const { id: userId, workspace_id: workspaceId } = whoami[0]!;

      const app = await pool.query<{ id: string }>(
        `INSERT INTO oauth_apps
           (workspace_id, owner_user_id, name, client_id, client_secret_hash,
            client_secret_prefix, redirect_uris, requested_scopes, is_first_party)
         VALUES ($1, $2, 'Portal Replay Spec', $3, 'unused-hash', 'ship_sec',
                 ARRAY['https://example.com/cb'], ARRAY['webhooks:manage'], false)
         RETURNING id`,
        [workspaceId, userId, APP_CLIENT_ID]
      );
      appId = app.rows[0]!.id;

      const sub = await pool.query<{ id: string }>(
        `INSERT INTO webhook_subscriptions
           (app_id, workspace_id, event_type, target_url, signing_secret_hash,
            signing_secret_prefix, active, created_by)
         VALUES ($1, $2, 'document.created', 'https://example.com/hook',
                 'unused-hash', 'whsec', true, $3)
         RETURNING id`,
        [appId, workspaceId, userId]
      );
      const subscriptionId = sub.rows[0]!.id;

      // status 'dead_lettered' is what makes the button render at all —
      // DeliveriesTab only offers Replay on that status.
      const delivery = await pool.query<{ id: string }>(
        `INSERT INTO webhook_deliveries
           (subscription_id, event_id, event_type, payload, idempotency_key,
            status, attempt_number, response_status, last_error)
         VALUES ($1, gen_random_uuid(), 'document.created', '{"id":"doc-1"}'::jsonb,
                 $2, 'dead_lettered', 6, 500, 'subscriber returned 500 six times')
         RETURNING id`,
        [subscriptionId, ORIGINAL_IDEMPOTENCY_KEY]
      );
      deliveryId = delivery.rows[0]!.id;

      // ── Log in through the UI, exactly as a human operator would ──────────
      await page.goto('/login');
      await page.locator('#email').fill('dev@ship.local');
      await page.locator('#password').fill('admin123');
      await page.locator('button[type="submit"]').click();
      await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

      // The tab is a search param, so the deliveries view can be addressed
      // directly rather than clicked through.
      await page.goto('/devportal?tab=deliveries');

      // Select OUR app, and fail loudly if that does not happen. Swallowing a
      // failed selection here is how this spec first went green-adjacent: the
      // portal fell back to another app, a *different* dead-lettered row was
      // on screen, and the Replay click was aimed at somebody else's delivery.
      const appSelect = page.locator('select');
      await expect(appSelect, 'the portal must offer an app chooser').toBeVisible({
        timeout: 15_000,
      });
      await appSelect.selectOption({ label: 'Portal Replay Spec' });

      // Locate the row by the error text seeded above, not by status. "dead
      // lettered" matches any app's dead letter; this string matches exactly
      // the delivery this test created.
      const deadRow = page.locator('tr', { hasText: 'subscriber returned 500 six times' });
      await expect(deadRow, 'the seeded dead-lettered delivery should be listed').toBeVisible({
        timeout: 15_000,
      });

      // Record what the replay endpoint actually answers, so a failure here
      // reports the server's reason instead of just "no row appeared".
      const replayResponses: string[] = [];
      page.on('response', async (res) => {
        if (!res.url().includes('/replay')) return;
        const body = await res.text().catch(() => '<unreadable>');
        replayResponses.push(`${res.status()} ${body}`.slice(0, 300));
      });

      // ── The click this spec exists for ────────────────────────────────────
      await deadRow.getByRole('button', { name: 'Replay' }).click();

      // ── Assert on what the API actually wrote, not on the pixels ──────────
      // The database is the authority here. Asserting the rendered row first
      // would couple this test to the portal's refetch timing and turn a real
      // failure ("replay never happened") into the same red as a slow query
      // invalidation — two very different bugs.
      let replays: Array<{ idempotency_key: string; replay_of_id: string }> = [];
      await expect
        .poll(
          async () => {
            const r = await pool.query<{ idempotency_key: string; replay_of_id: string }>(
              `SELECT idempotency_key, replay_of_id
                 FROM webhook_deliveries
                WHERE replay_of_id = $1`,
              [deliveryId]
            );
            replays = r.rows;
            return r.rows.length;
          },
          {
            timeout: 15_000,
            message: 'clicking Replay should have inserted exactly one replay delivery',
          }
        )
        .toBe(1);

      expect(
        replays[0]!.idempotency_key,
        'the replay must carry the ORIGINAL idempotency key — that is what lets a ' +
          'subscriber dedupe it against the delivery it already processed'
      ).toBe(ORIGINAL_IDEMPOTENCY_KEY);

      // The endpoint must have ACCEPTED it, and we must have SEEN it answer.
      //
      // This was `replayResponses.every(r => r.startsWith('2'))`, which is
      // vacuously true on an empty array: if the response listener never fired —
      // wrong URL filter, listener deleted, body still pending — the assertion
      // passed while observing nothing. Requiring at least one recorded response
      // is what makes it capable of failing, which is the whole point of the
      // check. A 400 here is exactly the bug this spec was written to catch.
      expect(
        replayResponses.length,
        'the /replay response listener recorded nothing — it cannot vouch for anything'
      ).toBeGreaterThan(0);
      expect(
        replayResponses.filter((r) => !r.startsWith('2')),
        'every /replay response should be 2xx'
      ).toEqual([]);

      // ── And that the operator can see it ──────────────────────────────────
      // Reloaded rather than awaited in place: what matters is that the portal
      // renders the replay chain, not how quickly its cache notices.
      await page.reload();
      await expect(page.getByText('replay of').first()).toBeVisible({ timeout: 15_000 });
    } finally {
      // Clean up in FK order. The app cascade takes subscriptions and their
      // deliveries with it; deleting deliveries first keeps this readable if
      // the cascade is ever tightened.
      if (deliveryId) {
        await pool.query(`DELETE FROM webhook_deliveries WHERE replay_of_id = $1 OR id = $1`, [
          deliveryId,
        ]);
      }
      if (appId) {
        await pool.query(`DELETE FROM webhook_subscriptions WHERE app_id = $1`, [appId]);
        await pool.query(`DELETE FROM oauth_apps WHERE id = $1`, [appId]);
      }
      await pool.end();
    }
  });
});
