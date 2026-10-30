/**
 * #6712 PR 4b (design v3.2 §9): `sync status --json`'s live `convergence` block and the pass's status reason, read from
 * the pass row (one primary-key read) plus the withheld-delete record, the holds the status already read and
 * `sync.admission`'s status. Additive: no other status field changes meaning. A source with no pass row yet (or a
 * company-brain source) keeps PR 4a's shadow under `--detail`.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import type { SyncAdmissionStatus } from './sync-admission.ts';
import { digest } from './digest.ts';
import { fileDriftSide, type GitHoldRecord } from './sync-holds.ts';
import { readDeletesWithheld, type DeletesWithheld } from './sync-markers.ts';
import { ABANDONED_QUIET_MS, ABANDONED_REPORT_STREAK, MANAGED_SYNC_PASS_OP, NOT_CONVERGED_REPORT_STREAK, passHealth, type PassRoundSummary, type PassRow } from './sync-pass-row.ts';

/**
 * #7614: the sources whose pass row is still the open one a reader saw (same last write, still `open`, source not
 * archived). A reader that saw an open row and then no live drain lease reads it interrupted only through this: a pass
 * that ended and released its lease between the two reads changed its row, so it is not reported killed.
 */
export async function openPassRowsStill(engine: Pick<BrainEngine, 'executeRaw'>, seen: ReadonlyArray<{ source_id: string; row: PassRow }>): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ source_id: string; updated_at: Date | string; outcome: string | null }>(`SELECT s.id AS source_id, c.updated_at,
    c.completed_keys->0->'telemetry'->>'outcome' AS outcome FROM sources s JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text
    WHERE s.id=ANY($2::text[]) AND s.archived IS NOT TRUE`, [MANAGED_SYNC_PASS_OP, seen.map(entry => entry.source_id)]);
  const at = new Map(seen.map(entry => [entry.source_id, entry.row.updated_at]));
  return new Set(rows.filter(row => row.outcome === 'open' && new Date(row.updated_at).toISOString() === at.get(row.source_id)).map(row => row.source_id));
}

export interface PassConvergence {
  schema: 'convergence/1'; dry_run: false; source_id: string;
  /**
   * `target` is the commit the newest pass pinned (its telemetry), not a converged state. #7243: `converged_target` is the
   * commit the stored converged obligation records (the last stamp), null while no stamp backs one (a stuck source that never converged).
   */
  pass_id: string; kind: string; outcome: string; stop_reason: string | null; target: string; converged_target: string | null; converged_at: string | null;
  round: number; candidates: number; settled: number; remaining: number; eta_seconds: null; eta_reason: 'pass_round_local';
  counts: Record<string, number>;
  decisions: { both: number; unknown: number; deleted: number };
  db_ahead: PassRoundSummary['db_ahead']; full_skipped_db_ahead: number;
  legacy_unverified: number; legacy_pageless: number;
  keep_db_admitted: number; keep_db_pending: number;
  deletes_withheld: { count: number; ratio: number; set_hash: string; samples: string[] } | null;
  classes: Record<string, { count: number; action: 'none' | 'owner' | 'repair' }>;
  settle_mismatch: string[];
  episode: { full_id: string | null; opened_at: string; inherited: { noEmbed: boolean; noExtract: boolean; noSchemaPack: boolean; from: string }; selection_fp: string | null;
    reserved_usd: number | null; approved_usd: number | null } | null;
  admission: SyncAdmissionStatus;
  not_converged_streak: number;
  duration_ms: number | null; timings_ms: Record<string, number>; last_full_at: string | null;
}

/** The live block of one source's pass row (design §9's field table). `holds` are the incarnation's holds the status read. */
export async function passConvergence(engine: Pick<BrainEngine, 'executeRaw'>, input: { sourceId: string; incarnation: string; row: PassRow; holds: readonly GitHoldRecord[];
  admission: SyncAdmissionStatus; withheld?: DeletesWithheld | null }): Promise<PassConvergence> {
  const { telemetry: t, obligations: o } = input.row.value;
  const withheld = input.withheld !== undefined ? input.withheld : await readDeletesWithheld(engine, input.sourceId, input.incarnation);
  const decisions = { both: 0, unknown: 0, deleted: 0 };
  for (const hold of input.holds) if (hold.code === 'file_drift') { const side = fileDriftSide(hold.meta); if (side) decisions[side]++; }
  const summary = t.summary ?? { db_ahead: { pending: 0, db_only: 0, unproven: 0, by_prefix: {} }, full_skipped_db_ahead: 0, legacy_unverified: 0, legacy_pageless: 0 };
  const episode = o.episode;
  return { schema: 'convergence/1', dry_run: false, source_id: input.sourceId, pass_id: t.pass_id, kind: t.kind, outcome: t.outcome, stop_reason: t.stop_reason, target: t.target,
    converged_target: o.converged?.target ?? null, converged_at: o.converged?.at ?? null, round: t.round, candidates: t.candidates, settled: t.settled, remaining: t.remaining, eta_seconds: null, eta_reason: 'pass_round_local',
    counts: t.counts, decisions, db_ahead: summary.db_ahead, full_skipped_db_ahead: summary.full_skipped_db_ahead, legacy_unverified: summary.legacy_unverified,
    legacy_pageless: summary.legacy_pageless, keep_db_admitted: t.counts.keep_db_admitted ?? 0, keep_db_pending: t.counts.keep_db_pending ?? 0,
    deletes_withheld: withheld ? { count: withheld.count, ratio: withheld.ratio, set_hash: withheld.set_hash, samples: withheld.samples } : null,
    classes: t.classes ?? {}, settle_mismatch: Object.keys(o.mismatch ?? {}).sort(),
    episode: episode ? { full_id: episode.full_id ?? null, opened_at: episode.opened_at, inherited: episode.inherited, selection_fp: digest(episode.selection),
      reserved_usd: o.cost?.reserved_usd ?? null, approved_usd: o.cost?.approved_usd ?? null } : null,
    admission: input.admission, not_converged_streak: o.not_converged_streak ?? 0,
    duration_ms: t.duration_ms, timings_ms: t.timings_ms, last_full_at: o.converged?.last_full_at ?? null };
}

export type PassStatusReason = 'pass_unfinished' | 'pass_interrupted' | 'pass_abandoned' | 'not_converged' | 'settle_mismatch' | 'deletes_withheld' | 'selection_scoped' | 'admission_paused' | 'writeback_failed';

/**
 * #7355: passes in a row that never ended, the newest open one included once its row has been quiet past the no-progress
 * window. #7596: a caller that read the source's drain lease passes `interrupted` instead: the open pass counts when no process
 * holds the lease (its process was killed or crashed) and never while one does, since a pass writes its row only per batch.
 * #7611: nor does the streak an earlier pass stored while a live holder renews the lease: the open pass is running, and the
 * streak counts again once that holder stops renewing.
 */
export function abandonedPasses(row: PassRow, now = Date.now(), interrupted?: boolean): number {
  if (interrupted === false) return 0;
  const quiet = row.value.telemetry.outcome === 'open' && (interrupted ?? now - Date.parse(row.updated_at) >= ABANDONED_QUIET_MS);
  return row.value.telemetry.outcome === 'open' ? (row.value.obligations.abandoned_streak ?? 0) + (quiet ? 1 : 0) : 0;
}

/**
 * The state the newest pass puts the source in (design §9): never `synced` while it is open or ended unconverged, or while a
 * writeback its stamp recorded (`converged.writeback`) has a failed or parked Git effect (`writebackFailed`: that request). Null: nothing to add.
 * #7596 `interrupted`: no process holds the source's drain lease (`readDrainLease`), so an open pass is one whose process
 * stopped without ending it (killed or crashed), not one still running: `pass_interrupted`.
 */
export function passStatusState(row: PassRow, withheld: DeletesWithheld | null, writebackFailed: string | null = null, now = Date.now(), interrupted?: boolean): ['synced' | 'resumable' | 'blocked', PassStatusReason] | null {
  const t = row.value.telemetry;
  if (abandonedPasses(row, now, interrupted) >= ABANDONED_REPORT_STREAK) return ['blocked', 'pass_abandoned'];
  if (t.outcome === 'open' && interrupted) return ['resumable', 'pass_interrupted'];
  if (t.outcome === 'open' || (t.outcome === 'resumable' && t.stop_reason !== 'not_converged' && t.stop_reason !== 'admission_paused')) return ['resumable', 'pass_unfinished'];
  if (t.stop_reason === 'admission_paused') return ['resumable', 'admission_paused'];
  if (t.stop_reason === 'not_converged' || (row.value.obligations.not_converged_streak ?? 0) > 0) return ['resumable', 'not_converged'];
  if (passHealth(row, { now, stalledMs: Number.POSITIVE_INFINITY }).reason === 'settle_mismatch') return ['resumable', 'settle_mismatch'];
  if (writebackFailed) return ['blocked', 'writeback_failed'];
  if (withheld) return ['blocked', 'deletes_withheld'];
  if (t.outcome === 'synced' && t.stop_reason === 'selection_scoped') return ['synced', 'selection_scoped'];
  return null;
}

/** The next step for a pass reason (`resume`: the plain sync's arguments). */
export function passStatusNext(sourceId: string, reason: PassStatusReason, row: PassRow, resume: string[], writebackFailed: string | null = null, interrupted?: boolean): Action {
  const verify = { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] };
  const sync: Action = { argv: ['gbrain', 'sync', ...resume], consent: [], actor: 'agent', requires_exclusive: false, verify, why: '' };
  switch (reason) {
    case 'not_converged':
      return (row.value.obligations.not_converged_streak ?? 0) >= NOT_CONVERGED_REPORT_STREAK
        ? { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
          why: `The last ${row.value.obligations.not_converged_streak} passes of ${sourceId} ended not converged; another sync will not change that. Report what doctor shows with the gbrain version (read-only).` }
        : { ...sync, why: 'The last pass ran out of rounds before every path settled; the same sync continues from the current level.' };
    case 'deletes_withheld':
      // #7130: deleting pages is the user's decision, never an agent's: next is ask_user whatever the actor.
      return { ask_user: true, argv: ['gbrain', 'sync', '--source', sourceId, '--dry-run', '--json'], consent: [], actor: 'user', requires_exclusive: false, verify,
        user_message: `Sync of ${sourceId} withheld a bulk delete (over half of its file-backed pages, or over sync.max_deletes / sync.max_delete_ratio); nothing was deleted. Review the withheld set in the dry run. If the checkout is the wrong one or incomplete, restore it and sync again; if the deletion is intended, run GBRAIN_ALLOW_MASS_RECONCILE=1 gbrain sync --source ${sourceId} on the brain host.`,
        why: 'The dry run lists the withheld set and its hash (read-only); everything else of the source is synced.' };
    case 'admission_paused':
      return { argv: ['gbrain', 'config', 'set', 'sync.admission', 'normal'], consent: [], actor: 'user', requires_exclusive: false, verify,
        user_message: `sync.admission pauses what sync admits for ${sourceId}; restore it with gbrain config set sync.admission normal when the pause is over.`,
        why: 'The pause is the owner\'s setting; it is never lifted automatically.' };
    case 'writeback_failed':
      return { argv: ['gbrain', 'sources', 'writer', 'retry-effects', sourceId, '--request-id', writebackFailed ?? '<id>', '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false, verify,
        user_message: `The Git effect of a file sync rewrote in ${sourceId} (request ${writebackFailed}) failed and is parked, so the checkout does not hold what the brain holds. Fix the cause doctor's parked_effects names, then retry it with the same command without --dry-run.`,
        why: 'The preview names the parked effect and what a retry runs (read-only); until it commits, the source is never idle.' };
    case 'pass_abandoned':
      return { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `The last ${abandonedPasses(row, Date.now(), interrupted)} sync passes of ${sourceId} stopped before they ended (the drain abandoned them for making no progress, or their process was killed), so another plain sync is likely to stop the same way. Report what doctor shows, with the gbrain version and the newest sync run's drain.stall (read-only).` };
    case 'pass_interrupted':
      return { ...sync, why: `The newest pass of ${sourceId} stopped before it ended and no process holds its drain lease: its process was killed or crashed (an out-of-memory kill or a timeout), or stopped on an error it does not record (a dropped connection), so nothing recorded a failure. The plain sync continues it from the current level; if that pass stops the same way, status reads pass_abandoned.` };
    case 'selection_scoped':
      return { ...sync, why: 'The last pass converged at a narrower selection and did not advance last_commit; the plain sync runs the configured selection.' };
    default:
      return { ...sync, why: reason === 'settle_mismatch' ? 'A path keeps settling without reading settled; the next sync re-admits it once and holds it after three passes in a row.'
        : 'The newest pass did not finish; the plain sync continues it from the current level.' };
  }
}
