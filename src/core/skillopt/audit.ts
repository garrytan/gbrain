/**
 * SkillOpt audit JSONL writer. Built on the v0.40.4.0 audit-writer cathedral.
 *
 * Events land at `~/.gbrain/audit/skillopt-YYYY-Www.jsonl` (ISO-week rotated;
 * honors `GBRAIN_AUDIT_DIR`).
 *
 * Per codex C5 free-fix: skill_name is in clear. Skill names are public in
 * the repo (live on GitHub); hashing them is over-privacy and would make
 * doctor's paste-ready hints unactionable. Task TEXT remains SHA-256-prefix
 * hashed (8 hex) because task content can carry private benchmark inputs.
 */

import { createHash } from 'node:crypto';
import { createAuditWriter, type AuditWriter } from '../audit/audit-writer.ts';
import type { EditOp } from './types.ts';

/** Discriminated union of every event kind emitted to the audit trail. */
export type SkilloptEvent =
  | { kind: 'run_start'; run_id: string; skill: string; skill_sha8: string;
      benchmark_sha8: string; target_model: string; optimizer_model: string;
      judge_model: string; epochs: number; batch_size: number; lr: number;
      lr_schedule: string; max_cost_usd: number; ts: string }
  | { kind: 'step'; run_id: string; skill: string; epoch: number; step: number;
      sel_score_median: number; sel_score_runs: number[]; accepted: boolean;
      edits_attempted: number; edits_applied: number; delta: number;
      reason?: string; cumulative_cost_usd: number; ts: string }
  | { kind: 'edit_rejected'; run_id: string; skill: string; epoch: number;
      step: number; edit_kind: EditOp['op']; rejection_reason: string;
      ts: string }
  | { kind: 'slow_update'; run_id: string; skill: string; epoch: number;
      meta_edit_proposed: boolean; meta_edit_accepted: boolean; ts: string }
  | { kind: 'run_end'; run_id: string; skill: string; outcome: 'accepted' |
      'no_improvement' | 'aborted' | 'errored'; epochs_completed: number;
      total_steps: number; baseline_sel_score?: number; best_sel_score?: number;
      baseline_test_score?: number; test_score?: number; final_cost_usd: number;
      ts: string }
  | { kind: 'abort'; run_id: string; skill: string; reason: 'budget_exhausted' |
      'runtime_exhausted' | 'dirty_tree' | 'lock_busy' | 'sentinel_pending' |
      'bundled_skill_no_flag' | 'd_sel_too_small' | 'sigint'; detail?: string;
      ts: string };

let _writer: AuditWriter<SkilloptEvent> | null = null;

function getWriter(): AuditWriter<SkilloptEvent> {
  if (_writer === null) {
    _writer = createAuditWriter<SkilloptEvent>({
      featureName: 'skillopt',
      errorLabel: 'skillopt-audit',
      errorTrailer: '; run continues',
    });
  }
  return _writer;
}

/**
 * Test seam — reset the cached writer so tests with mocked GBRAIN_AUDIT_DIR
 * see writes land in the right tempdir.
 */
export function _resetAuditWriterForTests(): void {
  _writer = null;
}

/** Append an event to the SkillOpt audit JSONL. Best-effort; never throws. */
export function logEvent(event: Omit<SkilloptEvent, 'ts'> & { ts?: string }): void {
  getWriter().log(event as Omit<SkilloptEvent, 'ts'> & { ts?: string });
}

/** Read events from current + previous ISO week, filtered by N-day window. */
export function readRecentEvents(days = 7, now: Date = new Date()): SkilloptEvent[] {
  return getWriter().readRecent(days, now);
}

/** Compute the SHA-256-prefix-8 of a string (for privacy-hashing task text). */
export function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/** Resolve audit dir (honors GBRAIN_AUDIT_DIR). */
export function resolveAuditDir(): string {
  return getWriter().resolveDir();
}

/** Compute the current ISO-week filename (for tests + doctor surface). */
export function currentAuditFilename(now: Date = new Date()): string {
  return getWriter().computeFilename(now);
}
