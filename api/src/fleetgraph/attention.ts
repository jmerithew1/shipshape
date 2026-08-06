/**
 * E1 credibility-weighted alerting + K1 safe disclosure.
 *
 * E1 (repeated-game mechanism against crying wolf — DECISIONS.md
 * 2026-08-03): per (user × finding_type) the agent keeps a discounted Beta
 * posterior on "was this finding useful" (updated on dispositions in
 * routes/agent.ts). Before notifying, it Thompson-samples p̃ ~ Beta(α, β)
 * and interrupts only when severity clears `θ0 + c·(1 − p̃)` — users the
 * agent has been wasting get a higher bar; sampling keeps exploration alive
 * so there is no death spiral. Critical severity always interrupts, and a
 * forced probe fires if a user has heard nothing for PROBE_DAYS.
 *
 * The finding row is ALWAYS written (panel visibility is not gated) —
 * `notified_user_ids` is what's gated, and that drives toast/pulse.
 *
 * K1 (incentive-compatible disclosure): if the same document already has a
 * recent self-reported disposition (Still-on-it), the new finding is demoted
 * one severity step, the project-owner escalation is dropped, and triage is
 * told to frame it as a proactive update — reporting bad news early must
 * always beat hiding it.
 *
 * RNG is injectable so regression tests are deterministic (plan/E1 testing
 * constraint).
 */
import type { Pool } from 'pg';
import type { CandidateFinding, Severity } from './types.js';

export type Rng = () => number;

export const THETA_0 = 1; // base rank threshold (low=0, medium=1, high=2, critical=3)
export const CRED_WEIGHT = 2; // c: a fully-wasted user needs severity ≥ θ0 + c
export const PROBE_DAYS = 5; // forced probe: never fully silent longer than this

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const DEMOTE: Record<Severity, Severity> = {
  low: 'low',
  medium: 'low',
  high: 'medium',
  critical: 'high',
};

/** Marsaglia–Tsang via two gammas is overkill for two-figure α/β; the
 *  standard sum-of-uniforms Beta approximation is wrong — use the
 *  Jöhnk-style inverse method valid for our small α/β via gamma sampling
 *  with Ahrens-Dieter for shape < 1 and Marsaglia-Tsang for shape ≥ 1. */
function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    // Ahrens-Dieter boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    return sampleGamma(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Marsaglia–Tsang squeeze
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box–Muller normal from two uniforms
      const u1 = rng() || 1e-12;
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u || 1e-12) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const a = sampleGamma(alpha, rng);
  const b = sampleGamma(beta, rng);
  return a / (a + b);
}

export interface CredibilityRow {
  user_id: string;
  finding_type: string;
  alpha: number;
  beta: number;
  last_notified_at: Date | null;
}

/**
 * Decide, per candidate recipient, whether this finding earns an interrupt.
 * Pure given the credibility rows + rng — the DB read/write wrappers below
 * keep this testable.
 */
export function gateRecipients(params: {
  finding: Pick<CandidateFinding, 'detector' | 'severity' | 'notifyUserIds'>;
  credibility: Map<string, CredibilityRow>; // key: userId
  rng: Rng;
  now?: Date;
}): { notify: string[]; suppressed: string[] } {
  const { finding, credibility, rng } = params;
  const now = params.now ?? new Date();
  const rank = SEVERITY_RANK[finding.severity];
  const notify: string[] = [];
  const suppressed: string[] = [];

  for (const userId of finding.notifyUserIds) {
    if (finding.severity === 'critical') {
      notify.push(userId); // critical always interrupts
      continue;
    }
    const row = credibility.get(userId);
    if (!row) {
      notify.push(userId); // no history → default to interrupting (cold start)
      continue;
    }
    // Forced probe: never let adaptation become permanent silence. A row
    // with no notification timestamp means this user has never been
    // interrupted for this finding type — probe-eligible immediately.
    const last = row.last_notified_at ? new Date(row.last_notified_at) : null;
    if (!last || (now.getTime() - last.getTime()) / 86_400_000 > PROBE_DAYS) {
      notify.push(userId);
      continue;
    }
    const pTilde = sampleBeta(Math.max(row.alpha, 0.01), Math.max(row.beta, 0.01), rng);
    const threshold = THETA_0 + CRED_WEIGHT * (1 - pTilde);
    if (rank >= threshold) notify.push(userId);
    else suppressed.push(userId);
  }
  return { notify, suppressed };
}

/**
 * K1 + E1 applied to a batch of candidates before triage/notify.
 * - K1: recent self-report on the same document → demote severity, drop the
 *   escalation recipients beyond the assignee, mark evidence.selfReported.
 * - E1: gate notifyUserIds through credibility; record suppressed users in
 *   evidence so the card can explain itself.
 * Also stamps last_notified_at for users who will be interrupted.
 */
export async function applyDisclosureAndCredibility(
  pool: Pool,
  workspaceId: string,
  candidates: CandidateFinding[],
  rng: Rng = Math.random,
): Promise<CandidateFinding[]> {
  if (candidates.length === 0) return candidates;

  // K1: documents with a self-reported (still_on_it) disposition in the last
  // 2 days — early honesty buys calmer treatment.
  const docIds = candidates.map((c) => c.documentId);
  const selfReported = await pool.query(
    `SELECT DISTINCT document_id FROM agent_findings
      WHERE workspace_id = $1 AND document_id = ANY($2)
        AND self_reported = TRUE
        AND updated_at > NOW() - INTERVAL '2 days'`,
    [workspaceId, docIds],
  );
  const selfReportedDocs = new Set(selfReported.rows.map((r) => r.document_id));

  // E1: load credibility for every candidate recipient in one query.
  const userIds = [...new Set(candidates.flatMap((c) => c.notifyUserIds))];
  const credRows =
    userIds.length > 0
      ? await pool.query(
          `SELECT user_id, finding_type, alpha, beta, last_notified_at
             FROM agent_credibility WHERE user_id = ANY($1)`,
          [userIds],
        )
      : { rows: [] as CredibilityRow[] };

  const out: CandidateFinding[] = [];
  const interrupted = new Set<string>();

  for (const c of candidates) {
    let candidate = { ...c, evidence: { ...c.evidence } };

    if (selfReportedDocs.has(c.documentId)) {
      candidate = {
        ...candidate,
        severity: DEMOTE[candidate.severity],
        // Drop escalation targets: keep only the first (the doer), not the owner.
        notifyUserIds: candidate.notifyUserIds.slice(0, 1),
        evidence: { ...candidate.evidence, selfReported: true },
      };
    }

    const credibility = new Map<string, CredibilityRow>(
      credRows.rows
        .filter((r: CredibilityRow) => r.finding_type === candidate.detector)
        .map((r: CredibilityRow) => [r.user_id, r]),
    );
    const { notify, suppressed } = gateRecipients({ finding: candidate, credibility, rng });

    out.push({
      ...candidate,
      notifyUserIds: notify,
      evidence: {
        ...candidate.evidence,
        ...(suppressed.length > 0 ? { interruptSuppressedFor: suppressed } : {}),
      },
    });
    notify.forEach((u) => interrupted.add(u));
  }

  // Stamp last_notified_at for interrupted users (probe-clock bookkeeping).
  if (interrupted.size > 0) {
    const detectors = [...new Set(out.filter((c) => c.notifyUserIds.length > 0).map((c) => c.detector))];
    await pool.query(
      `INSERT INTO agent_credibility (user_id, finding_type, last_notified_at)
       SELECT u, d, NOW() FROM unnest($1::uuid[]) u, unnest($2::text[]) d
       ON CONFLICT (user_id, finding_type)
       DO UPDATE SET last_notified_at = NOW()`,
      [[...interrupted], detectors],
    );
  }

  return out;
}
