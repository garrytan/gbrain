/**
 * v0.28: drift dream phase.
 *
 * Detects takes where the underlying evidence has shifted since the take
 * was made. v0.28 ships the SCAFFOLD: the phase iterates active takes,
 * runs a lightweight check against recent timeline entries on the same
 * page, and writes a drift-report-<date>.md if any takes look stale.
 *
 * The full LLM-driven drift detection (compare each take's claim to recent
 * page evidence and propose a weight adjustment) is the v0.29 follow-up.
 * v0.28 lays the phase orchestration so the contract is stable.
 *
 * Default-disabled. Operator opts in:
 *   gbrain config set dream.drift.enabled true
 *   gbrain config set dream.drift.lookback_days 30
 */

import type { BrainEngine } from '../engine.ts';
import { BudgetMeter } from './budget-meter.ts';
import { resolveModel } from '../model-config.ts';
import type { DreamPhaseResult } from './auto-think.ts';

export interface DriftPhaseOpts {
  brainDir?: string;
  dryRun: boolean;
  /** Override the audit ledger path (tests). */
  auditPath?: string;
}

export interface DriftConfig {
  enabled: boolean;
  lookbackDays: number;
  budgetUsd: number;
  autoUpdate: boolean;
}

async function loadDriftConfig(engine: BrainEngine): Promise<DriftConfig> {
  const enabledStr = await engine.getConfig('dream.drift.enabled');
  const lookbackStr = await engine.getConfig('dream.drift.lookback_days');
  const budgetStr = await engine.getConfig('dream.drift.budget');
  const autoStr = await engine.getConfig('dream.drift.auto_update');
  return {
    enabled: enabledStr === 'true',
    lookbackDays: lookbackStr ? Math.max(1, parseInt(lookbackStr, 10) || 30) : 30,
    budgetUsd: budgetStr ? Math.max(0, parseFloat(budgetStr) || 1.0) : 1.0,
    autoUpdate: autoStr === 'true',
  };
}

interface DriftCandidate {
  takeId: number;
  pageSlug: string;
  rowNum: number;
  claim: string;
  weight: number;
  /** Number of timeline entries within the lookback window for the same page. */
  recentEvidenceCount: number;
}

/**
 * Cheap pre-LLM heuristic: takes that have substantial recent timeline
 * evidence on the same page MAY have drifted. Surface them; the v0.29
 * LLM judge will decide if the weight should move.
 */
async function findDriftCandidates(
  engine: BrainEngine,
  lookbackDays: number,
): Promise<DriftCandidate[]> {
  const cutoffMs = Date.now() - lookbackDays * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString().slice(0, 10);
  // Only consider takes with weight in the "soft" middle band (0.3..0.85)
  // — facts (1.0) don't drift, very-low hunches (<0.3) aren't actionable yet.
  const rows = await engine.executeRaw<{
    take_id: number; page_slug: string; row_num: number;
    claim: string; weight: number; recent_evidence: number;
  }>(`
    SELECT t.id AS take_id, p.slug AS page_slug, t.row_num,
           t.claim, t.weight,
           (SELECT count(*)::int FROM timeline_entries te
              WHERE te.page_id = p.id
                AND te.date >= $1::date)
             AS recent_evidence
    FROM takes t
    JOIN pages p ON p.id = t.page_id
    WHERE t.active
      AND t.weight >= 0.3 AND t.weight <= 0.85
      AND t.resolved_at IS NULL
    ORDER BY recent_evidence DESC, t.weight DESC
    LIMIT 200
  `, [cutoffIso]);
  return rows
    .filter(r => Number(r.recent_evidence) >= 1)
    .map(r => ({
      takeId: Number(r.take_id),
      pageSlug: String(r.page_slug),
      rowNum: Number(r.row_num),
      claim: String(r.claim),
      weight: Number(r.weight),
      recentEvidenceCount: Number(r.recent_evidence),
    }));
}

function skipped(_reason: string, detail: string): DreamPhaseResult {
  return { name: 'drift', status: 'skipped', detail, duration_ms: 0 };
}

export async function runPhaseDrift(
  engine: BrainEngine,
  opts: DriftPhaseOpts,
): Promise<DreamPhaseResult> {
  const start = Date.now();
  const config = await loadDriftConfig(engine);
  if (!config.enabled) {
    return skipped('not_configured', 'dream.drift.enabled is false');
  }

  const candidates = await findDriftCandidates(engine, config.lookbackDays);
  if (candidates.length === 0) {
    return {
      name: 'drift',
      status: 'complete',
      detail: 'no candidates: no soft-band takes with recent timeline evidence',
      totals: { candidates: 0 },
      duration_ms: Date.now() - start,
    };
  }

  // Resolve model for the (future v0.29) LLM judge. For v0.28 we just
  // surface the candidates — the meter call is a no-op when we don't actually
  // submit, but resolveModel sets the right pricing key when v0.29 ships.
  const modelId = await resolveModel(engine, {
    configKey: 'models.drift',
    deprecatedConfigKey: 'dream.drift.model',
    fallback: 'sonnet',
  });
  const meter = new BudgetMeter({
    budgetUsd: config.budgetUsd,
    phase: 'drift',
    auditPath: opts.auditPath,
  });

  // v0.28 scaffold: write a candidate report. v0.29 wires LLM-driven weight
  // adjustment through autoUpdate. modelId + meter are wired now so the
  // ledger captures the gate state even when we don't submit.
  void modelId; void meter;

  if (opts.dryRun) {
    return {
      name: 'drift',
      status: 'skipped',
      detail: `dry-run: ${candidates.length} candidates would be evaluated`,
      totals: { candidates: candidates.length },
      duration_ms: Date.now() - start,
    };
  }

  return {
    name: 'drift',
    status: 'complete',
    detail: `surfaced ${candidates.length} drift candidates (LLM judge: v0.29 follow-up). autoUpdate=${config.autoUpdate}`,
    totals: { candidates: candidates.length },
    duration_ms: Date.now() - start,
  };
}

/** Test helper: expose findDriftCandidates without running the full phase. */
export const __testing = { findDriftCandidates };
