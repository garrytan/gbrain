/**
 * #5028: per-source evidence that extract_atoms actually ran. Freshness-only
 * autopilot cycles stamp `last_full_cycle_at` without running this phase, so
 * doctor judges the phase by its own `last_extract_atoms_at` stamp, written
 * here by both runners (the dream cycle and the extract-atoms drain).
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { runPhaseExtractAtoms, type ExtractAtomsOpts } from './extract-atoms.ts';

/** sources.config key stamped after a pass of extract_atoms that ran. */
export const LAST_EXTRACT_ATOMS_AT_KEY = 'last_extract_atoms_at';
/** A backlog source whose stamp is older than this is stale (the auto-drain opens one slot per UTC day). */
export const EXTRACT_ATOMS_PHASE_WARN_HOURS = 48;

/**
 * Stamp the source when the pass ran: status ok, or warn with at least one
 * item processed. A pass where every item failed, or a skip, does not count.
 * Best-effort: the stamp is evidence only and never fails the phase.
 */
export async function stampExtractAtomsRun(engine: BrainEngine, sourceId: string, result: PhaseResult): Promise<void> {
  const d = (result.details ?? {}) as Record<string, unknown>;
  const processed = Number(d.transcripts_processed ?? 0) + Number(d.pages_processed ?? 0);
  if (result.status !== 'ok' && !(result.status === 'warn' && processed > 0)) return;
  try { await engine.updateSourceConfig(sourceId, { [LAST_EXTRACT_ATOMS_AT_KEY]: new Date().toISOString() }); }
  catch { /* evidence only */ }
}

/** runPhaseExtractAtoms, then stamp the source unless it was a dry run. */
export async function runPhaseExtractAtomsStamped(engine: BrainEngine, opts: ExtractAtomsOpts = {}): Promise<PhaseResult> {
  const result = await runPhaseExtractAtoms(engine, opts);
  if (!opts.dryRun) await stampExtractAtomsRun(engine, opts.sourceId ?? 'default', result);
  return result;
}

/**
 * Backlog sources with no `last_extract_atoms_at` inside the warn window.
 * Fail-open: an unreadable sources table returns null (callers do not warn).
 */
export async function sourcesWithStaleExtractAtomsRun(
  engine: BrainEngine,
  bySource: Array<{ source_id: string; backlog: number }>,
  nowMs = Date.now(),
): Promise<Array<{ source_id: string; backlog: number; last_extract_atoms_at: string | null }> | null> {
  try {
    const rows = await engine.executeRaw<{ id: string; stamp: string | null }>(
      `SELECT id, config->>$2 AS stamp FROM sources WHERE id = ANY($1::text[])`,
      [bySource.map((row) => row.source_id), LAST_EXTRACT_ATOMS_AT_KEY],
    );
    const stamps = new Map(rows.map((r) => [r.id, r.stamp]));
    return bySource
      .map((row) => ({ ...row, last_extract_atoms_at: stamps.get(row.source_id) ?? null }))
      .filter((row) => {
        const t = row.last_extract_atoms_at ? new Date(row.last_extract_atoms_at).getTime() : NaN;
        return !Number.isFinite(t) || nowMs - t > EXTRACT_ATOMS_PHASE_WARN_HOURS * 3_600_000;
      });
  } catch {
    return null;
  }
}

/**
 * The `extract_atoms_backlog` warning for a brain whose cycles run but whose
 * backlog sources have no recent extract_atoms stamp, or null when every
 * backlog source ran the phase inside the window (or the read failed).
 */
export async function extractAtomsPhaseStaleWarning(
  engine: BrainEngine,
  backlog: number,
  bySource: Array<{ source_id: string; backlog: number }>,
  drainCommand: (rows: Array<{ source_id: string; backlog: number }>) => string,
  approx: string,
): Promise<{ message: string; details: Record<string, unknown> } | null> {
  const stale = await sourcesWithStaleExtractAtomsRun(engine, bySource);
  if (!stale || stale.length === 0) return null;
  const drain = drainCommand(stale);
  return {
    message:
      `${backlog} page(s) pending and cycles run, but extract_atoms has not run in the last ${EXTRACT_ATOMS_PHASE_WARN_HOURS}h ` +
      `for source(s) ${stale.map((r) => r.source_id).join(', ')} (routine autopilot cycles run only the freshness phases; ` +
      `the daily auto-drain needs autopilot on Postgres and a backlog above autopilot.auto_drain.threshold). Drain now: ${drain}`,
    details: {
      backlog, backlog_by_source: bySource, pack_declares_phase: true, cycle_evidence: 'fresh',
      phase_evidence: 'stale', phase_stale_sources: stale, fix_hint: drain, known_approximation: approx,
    },
  };
}
