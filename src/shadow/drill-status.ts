/**
 * The `drills` part of the shadow status document: the two booleans swap criterion 10 reads
 * (`backup_restore_passed`, `eval_gates_e1_e3`; src/core/engine-swap/readiness.ts `ShadowStatus`) and the reasons behind
 * them. Built only from files under `<shadow dir>/drills/` and the evidence epoch: it opens no store and no network, so
 * the status and the swap can run anywhere, any time, and read the same answer.
 *
 * The backup half passes only for a record that passed in the CURRENT evidence epoch, with its scratch space deleted
 * and no pending cleanup. The eval half is `readEvalGatesVerdict` (eval-gates.ts) re-decided on every call.
 */
import { existsSync, readFileSync } from 'node:fs';
import { detectAddonTarget } from '../core/rust-engine/addon-target.ts';
import { join } from 'node:path';
import type { DrillRecord } from './drill.ts';
import { readEvalGatesVerdict, readLastFetch } from './eval-gates.ts';
import { readEpoch, type EpochManifest } from './evidence-epoch.ts';

export const DRILL_VERSION = 1;
export const DRILL_METHOD = 'online_logical';
export const drillsDir = (dir: string): string => join(dir, 'drills');
export const backupRecordPath = (dir: string): string => join(drillsDir(dir), 'backup.json');
export const pendingPath = (dir: string): string => join(drillsDir(dir), 'pending.json');

export interface DrillsStatus {
  backup_restore_passed: boolean;
  eval_gates_e1_e3: boolean;
  /** Why the backup half is not a pass (a code); absent on a pass. */
  backup_reason?: string;
  /** Why the eval half is not a pass (a code, `eval_gates_target_mismatch: ...` names both targets); absent on a pass. */
  eval_gates_reason?: string;
  backup_state?: 'passed' | 'failed' | 'missing' | 'stale' | 'cleanup_pending';
  /** The last `drill --evals` attempt: when, and the code it ended with (null: it cached a file). */
  eval_gates_last_fetch?: { at: string; reason: string | null };
}

function readRecord(dir: string): DrillRecord | null | 'unreadable' {
  let raw: string;
  try { raw = readFileSync(backupRecordPath(dir), 'utf8'); } catch { return null; } // silent-read-ok: no record is `missing`, which fails closed
  try {
    const v = JSON.parse(raw) as DrillRecord;
    return v && v.version === DRILL_VERSION && v.method === DRILL_METHOD && typeof v.epoch_id === 'string' && typeof v.pass === 'boolean' && typeof v.scratch_deleted === 'boolean' ? v : 'unreadable';
  } catch { return 'unreadable'; } // silent-read-ok: an unparseable record is `unreadable`, which fails closed
}

export function buildDrillStatus(dir: string, epoch: EpochManifest | null = readEpoch(dir), hostTarget: string | null = detectAddonTarget()): { drills: DrillsStatus } {
  const drills: DrillsStatus = { backup_restore_passed: false, eval_gates_e1_e3: false };
  const record = readRecord(dir);
  if (existsSync(pendingPath(dir))) { drills.backup_state = 'cleanup_pending'; drills.backup_reason = 'cleanup_pending'; }
  else if (record === null) { drills.backup_state = 'missing'; drills.backup_reason = 'backup_drill_missing'; }
  else if (record === 'unreadable') { drills.backup_state = 'failed'; drills.backup_reason = 'backup_drill_unreadable'; }
  else if (!record.pass) { drills.backup_state = 'failed'; drills.backup_reason = `backup_drill_failed:${record.reason ?? 'unknown'}`; }
  else if (!epoch || record.epoch_id !== epoch.epoch_id) { drills.backup_state = 'stale'; drills.backup_reason = 'backup_drill_other_epoch'; }
  else if (!record.scratch_deleted) { drills.backup_state = 'cleanup_pending'; drills.backup_reason = 'cleanup_pending'; }
  else { drills.backup_state = 'passed'; drills.backup_restore_passed = true; }

  const evals = readEvalGatesVerdict(dir, epoch, hostTarget);
  drills.eval_gates_e1_e3 = evals.passed;
  if (evals.reason) drills.eval_gates_reason = evals.reason;
  const last = readLastFetch(dir);
  if (last) drills.eval_gates_last_fetch = last;
  return { drills };
}
