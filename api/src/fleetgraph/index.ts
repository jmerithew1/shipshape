/**
 * FleetGraph wiring: bus subscription, sweep cron, run accounting.
 *
 * initFleetGraph() is called once from server startup. It is a no-op when
 * FLEETGRAPH_ENABLED=false or when no ANTHROPIC_API_KEY is configured —
 * except that detectors still run rule-based on the sweep (degraded mode is
 * a first-class behavior, not an error).
 */
import cron from 'node-cron';
import type { Pool } from 'pg';
import { buildFleetGraph } from './graph.js';
import { buildRealModels, llmConfigured, type FleetModels } from './models.js';
import { fleetBus } from './events.js';
import type { ShipData } from './ship-data.js';
import { PoolShipData } from './ship-data-pool.js';
import { SdkShipData } from './ship-data-sdk.js';
import type { FleetTrigger, RunPath } from './types.js';

export interface FleetRuntime {
  runTrigger: (trigger: FleetTrigger) => Promise<{ path: RunPath; chatResponse: string | null }>;
  enabled: boolean;
  /** Which `ShipData` implementation the detector stage is reading through. */
  dataSource: FleetDataSource;
}

export type FleetDataSource = 'pool' | 'sdk' | 'injected';

let runtime: FleetRuntime | null = null;

export function getFleetRuntime(): FleetRuntime | null {
  return runtime;
}

/**
 * Epic-7 feature flag. OFF (default) is the Week-5 path, unchanged; ON routes
 * the detector stage through Ship's public API as a first-party OAuth app.
 */
export function viaSdkEnabled(): boolean {
  return process.env.FLEETGRAPH_VIA_SDK === 'true';
}

/**
 * Resolve the port implementation for this process.
 *
 * The flag states an intent; credentials decide whether it can be honoured.
 * With the flag on but `SHIP_AGENT_CLIENT_ID` / `SHIP_AGENT_CLIENT_SECRET`
 * unset there is no OAuth identity to authenticate as, so this degrades to
 * the pool and says so loudly — the same shape as the LLM seam, which runs
 * rule-based when `ANTHROPIC_API_KEY` is missing rather than dying. Silently
 * reading nothing would look exactly like "no problems found", which is the
 * one failure mode a monitoring agent must never have.
 */
export function resolveShipData(pool: Pool): { data: ShipData; source: 'pool' | 'sdk' } {
  const fallback = new PoolShipData(pool);
  if (!viaSdkEnabled()) return { data: fallback, source: 'pool' };

  const clientId = process.env.SHIP_AGENT_CLIENT_ID;
  const clientSecret = process.env.SHIP_AGENT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn(
      '[fleetgraph] FLEETGRAPH_VIA_SDK=true but SHIP_AGENT_CLIENT_ID/SECRET are unset — ' +
        'falling back to direct database reads. Run `pnpm --filter @ship/api seed:agent-app`.',
    );
    return { data: fallback, source: 'pool' };
  }

  return {
    data: new SdkShipData({
      baseUrl: process.env.SHIP_AGENT_API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
      clientId,
      clientSecret,
      fallback,
    }),
    source: 'sdk',
  };
}

export function initFleetGraph(
  pool: Pool,
  modelsOverride?: FleetModels,
  /** Test seam, mirroring `modelsOverride`: inject a `ShipData` directly. */
  shipDataOverride?: ShipData,
): FleetRuntime {
  const enabled = process.env.FLEETGRAPH_ENABLED !== 'false';
  const models = modelsOverride ?? (llmConfigured() ? buildRealModels() : null);
  const resolved = resolveShipData(pool);
  const shipData: ShipData = shipDataOverride ?? resolved.data;
  const dataSource: FleetDataSource = shipDataOverride ? 'injected' : resolved.source;

  const runTrigger = async (
    trigger: FleetTrigger,
  ): Promise<{ path: RunPath; chatResponse: string | null }> => {
    const started = Date.now();
    const mode = trigger.kind === 'chat' ? 'on_demand' : 'proactive';
    try {
      if (!models) {
        // No LLM configured: still meaningless to run triage/chat, but the
        // deterministic half must not silently die. Run detectors directly.
        const {
          detectDueSoonIdle,
          detectOrphanIntake,
          detectStaleIssues,
          detectStuckReview,
          detectUrgentIdle,
          detectWeekSlip,
          autoResolveCleared,
        } = await import('./detectors.js');
        await autoResolveCleared(pool, trigger.workspaceId);
        const detected = await Promise.all([
          detectOrphanIntake(shipData, trigger.workspaceId),
          detectStaleIssues(shipData, trigger.workspaceId),
          detectStuckReview(shipData, trigger.workspaceId),
          detectUrgentIdle(shipData, trigger.workspaceId),
          detectDueSoonIdle(shipData, trigger.workspaceId),
          detectWeekSlip(shipData, trigger.workspaceId),
        ]);
        const all = detected.flat();
        for (const f of all) {
          await pool.query(
            `INSERT INTO agent_findings
               (workspace_id, project_id, document_id, detector, dedup_key,
                severity, title, body, evidence, notified_user_ids, rule_based_only,
                proposed_action)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, TRUE, $11)
             ON CONFLICT (workspace_id, dedup_key) WHERE resolved_at IS NULL DO NOTHING`,
            [
              f.workspaceId,
              f.projectId,
              f.documentId,
              f.detector,
              f.dedupKey,
              f.severity,
              `"${f.documentTitle}" needs attention (${f.detector.replace(/_/g, ' ')})`,
              'Rule-based (unranked) — no reasoning model is configured.',
              JSON.stringify(f.evidence),
              f.notifyUserIds,
              f.proposedAction ? JSON.stringify(f.proposedAction) : null,
            ],
          );
        }
        const path: RunPath = all.length > 0 ? 'degraded' : 'quiet';
        await logRun(pool, trigger, mode, path, null, Date.now() - started, all.length);
        return { path, chatResponse: null };
      }

      const graph = buildFleetGraph({ pool, models, shipData });
      const result = await graph.invoke({ trigger });
      const path = (result.path ?? 'error') as RunPath;
      await logRun(
        pool,
        trigger,
        mode,
        path,
        null,
        Date.now() - started,
        result.triaged?.length ?? 0,
      );
      return { path, chatResponse: result.chatResponse ?? null };
    } catch (err) {
      await logRun(pool, trigger, mode, 'error', String(err), Date.now() - started, 0).catch(
        () => undefined,
      );
      // Graceful degradation: a failed agent run never crashes the API.
      console.error('[fleetgraph] run failed:', err);
      return { path: 'error', chatResponse: null };
    }
  };

  if (enabled) {
    fleetBus.onRun((trigger) => {
      void runTrigger(trigger);
    });

    const intervalMin = Math.max(1, Number(process.env.FLEETGRAPH_SWEEP_MINUTES ?? 2));
    cron.schedule(`*/${intervalMin} * * * *`, async () => {
      const { rows } = await pool.query(`SELECT id FROM workspaces LIMIT 50`);
      for (const w of rows) {
        await runTrigger({ kind: 'sweep', workspaceId: w.id });
      }
    });
    console.log(
      `[fleetgraph] enabled — sweep every ${intervalMin}m, LLM ${models ? 'configured' : 'NOT configured (rule-based only)'}, reads via ${dataSource}`,
    );
  }

  runtime = { runTrigger, enabled, dataSource };
  return runtime;
}

async function logRun(
  pool: Pool,
  trigger: FleetTrigger,
  mode: 'proactive' | 'on_demand',
  path: RunPath,
  error: string | null,
  latencyMs: number,
  findingsCount: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_runs (workspace_id, trigger, mode, path, error, latency_ms, findings_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [trigger.workspaceId, trigger.kind, mode, path, error, latencyMs, findingsCount],
  );
}
