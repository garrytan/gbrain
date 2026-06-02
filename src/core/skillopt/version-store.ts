/**
 * SkillOpt version store with history-intent-first atomic write ordering (D8).
 *
 * Each accepted candidate write touches 4 files. We do them in this order
 * so a crash mid-sequence can be cleanly recovered:
 *
 *   1. history.json  — append `{status: 'pending', ...}`
 *   2. versions/vNNNN_eE_sS.md  — snapshot of the candidate
 *   3. best.md  — pointer copy of the candidate (always = current best)
 *   4. SKILL.md  — canonical (THIS is the commit step)
 *   5. history.json  — flip pending → committed
 *
 * Crash-resume logic: if a pending row exists with no committed counterpart,
 * remove the pending row, delete the snapshot, and revert best.md to the
 * prior version (or initial baseline if no prior version exists).
 *
 * Concurrency: a per-skill DB lock (`lock.ts`) prevents two SkillOpt runs
 * from racing on this directory. Within a single run we hold the lock for
 * the full optimization, so the in-process logic doesn't need additional
 * synchronization.
 *
 * Layout under `skills/<name>/skillopt/`:
 *
 *   history.json
 *   best.md
 *   versions/
 *     v0001_e1_s1.md
 *     v0002_e1_s2.md
 *     ...
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWrite } from './apply-edits.ts';
import type { EditOp, HistoryRow } from './types.ts';

// ─── Path helpers ────────────────────────────────────────────────────────

export function skilloptDir(skillsDir: string, skillName: string): string {
  return path.join(skillsDir, skillName, 'skillopt');
}

export function versionsDir(skillsDir: string, skillName: string): string {
  return path.join(skilloptDir(skillsDir, skillName), 'versions');
}

export function historyPath(skillsDir: string, skillName: string): string {
  return path.join(skilloptDir(skillsDir, skillName), 'history.json');
}

export function bestPath(skillsDir: string, skillName: string): string {
  return path.join(skilloptDir(skillsDir, skillName), 'best.md');
}

export function skillPath(skillsDir: string, skillName: string): string {
  return path.join(skillsDir, skillName, 'SKILL.md');
}

export function versionPath(
  skillsDir: string,
  skillName: string,
  versionN: number,
  epoch: number,
  step: number,
): string {
  const n = String(versionN).padStart(4, '0');
  return path.join(versionsDir(skillsDir, skillName), `v${n}_e${epoch}_s${step}.md`);
}

// ─── History I/O ─────────────────────────────────────────────────────────

interface HistoryFile {
  schema: 1;
  rows: HistoryRow[];
}

export function loadHistory(skillsDir: string, skillName: string): HistoryRow[] {
  const p = historyPath(skillsDir, skillName);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    const obj = parsed as Record<string, unknown>;
    if (obj.schema !== 1 || !Array.isArray(obj.rows)) return [];
    return obj.rows as HistoryRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[skillopt] history.json unreadable for ${skillName} (${msg})\n`);
    return [];
  }
}

function writeHistory(skillsDir: string, skillName: string, rows: HistoryRow[]): void {
  const p = historyPath(skillsDir, skillName);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWrite(p, JSON.stringify({ schema: 1, rows } satisfies HistoryFile, null, 2) + '\n');
}

// ─── D8 two-phase commit ─────────────────────────────────────────────────

export interface AcceptInput {
  skillsDir: string;
  skillName: string;
  runId: string;
  epoch: number;
  step: number;
  edits: EditOp[];
  candidateText: string;
  selScore: number;
  delta: number;
}

export interface AcceptResult {
  versionN: number;
  versionFilePath: string;
}

/**
 * Commit a candidate via D8's history-intent-first ordering.
 *
 * Returns the version number assigned + the path to the snapshot file.
 * On any thrown error during steps 2-4, the caller's outer try/finally
 * should invoke `revertPending(run_id)` to clean up.
 */
export function acceptCandidate(input: AcceptInput): AcceptResult {
  const { skillsDir, skillName, runId, epoch, step, edits, candidateText, selScore, delta } = input;

  // Ensure dir exists.
  fs.mkdirSync(versionsDir(skillsDir, skillName), { recursive: true });

  // Compute version_n (next sequence after the highest committed row).
  const history = loadHistory(skillsDir, skillName);
  const maxCommitted = history
    .filter((r) => r.status === 'committed')
    .reduce((m, r) => Math.max(m, r.version_n), 0);
  const versionN = maxCommitted + 1;

  // Step 1: append history row (pending).
  const ts = new Date().toISOString();
  const pendingRow: HistoryRow = {
    status: 'pending',
    run_id: runId,
    version_n: versionN,
    ts,
    edits,
    sel_score: selScore,
    delta,
  };
  writeHistory(skillsDir, skillName, [...history, pendingRow]);

  // Step 2: write snapshot.
  const verPath = versionPath(skillsDir, skillName, versionN, epoch, step);
  atomicWrite(verPath, candidateText);

  // Step 3: write best.md pointer.
  atomicWrite(bestPath(skillsDir, skillName), candidateText);

  // Step 4: write SKILL.md (THIS is the commit step).
  atomicWrite(skillPath(skillsDir, skillName), candidateText);

  // Step 5: flip pending → committed.
  const updated = loadHistory(skillsDir, skillName).map((r) =>
    r.run_id === runId && r.version_n === versionN && r.status === 'pending'
      ? { ...r, status: 'committed' as const }
      : r,
  );
  writeHistory(skillsDir, skillName, updated);

  return { versionN, versionFilePath: verPath };
}

/**
 * Crash-recovery: walk history.json, find any row with `status: 'pending'`
 * whose committed counterpart doesn't exist, and revert:
 *  - Delete the snapshot file.
 *  - Remove the pending row from history.json.
 *  - Restore best.md to the most-recent COMMITTED version (or delete it
 *    if no committed version exists).
 *
 * Does NOT touch SKILL.md — the ordering invariant is that SKILL.md only
 * gets rewritten AFTER best.md, so if SKILL.md never got rewritten then
 * it still matches the prior committed state.
 *
 * Returns the number of pending rows that were reverted.
 */
export function revertAllPending(skillsDir: string, skillName: string): number {
  const history = loadHistory(skillsDir, skillName);
  const pending = history.filter((r) => r.status === 'pending');
  if (pending.length === 0) return 0;

  for (const row of pending) {
    // Delete the snapshot. We don't know epoch/step from the history row
    // alone, so we search the versions dir for files matching `vNNNN_*.md`.
    const verN = String(row.version_n).padStart(4, '0');
    const dir = versionsDir(skillsDir, skillName);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(`v${verN}_`)) {
          try { fs.unlinkSync(path.join(dir, entry)); } catch { /* ignore */ }
        }
      }
    }
  }

  // Restore best.md to the most-recent COMMITTED version (or remove it if
  // no committed version exists).
  const committed = history.filter((r) => r.status === 'committed');
  const bestP = bestPath(skillsDir, skillName);
  if (committed.length === 0) {
    if (fs.existsSync(bestP)) {
      try { fs.unlinkSync(bestP); } catch { /* ignore */ }
    }
  } else {
    const highest = committed.reduce((m, r) => (r.version_n > m.version_n ? r : m), committed[0]!);
    const dir = versionsDir(skillsDir, skillName);
    const verN = String(highest.version_n).padStart(4, '0');
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(`v${verN}_`)) {
          const src = path.join(dir, entry);
          atomicWrite(bestP, fs.readFileSync(src, 'utf8'));
          break;
        }
      }
    }
  }

  // Trim pending rows out of history.
  const kept = history.filter((r) => r.status !== 'pending');
  writeHistory(skillsDir, skillName, kept);
  return pending.length;
}
