/**
 * #6188 (T2): "uncommitted fence repair" notices. A legacy (unmanaged)
 * source has no Git effect, so when the fence repair rewrites one of its
 * files it backs the file up, imports it, and records a notice here naming
 * the path, the backup and the exact `git add` / `git commit` step. The
 * notice stays until that path is committed: every read checks
 * `git status --porcelain -- <path>` and drops the notices whose path is
 * clean. `gbrain sources status` and doctor `fence_integrity` show them.
 *
 * One row per (source, incarnation, path) in `op_checkpoints`
 * (`fence-repair-uncommitted`); the record carries source_id and
 * incarnation, so the checkpoint purge keeps it while the source lives.
 * Location, hashes and the fix classes only, never a cell value.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { shellQuote } from '../agent-output.ts';
import type { FenceRepairReceipt } from './receipt.ts';
import { fenceRepairCommitSubject } from './receipt.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export const FENCE_UNCOMMITTED_OP = 'fence-repair-uncommitted';

export interface UncommittedFenceRepair {
  source_id: string;
  incarnation: string;
  path: string;
  root: string;
  repaired_at: string;
  backup: string | null;
  /** The exact command that commits the repaired file. */
  commit_step: string;
  receipt: FenceRepairReceipt;
}

const fingerprint = (sourceId: string, incarnation: string, path: string) => `${sourceId}:${incarnation}:${path}`;

/** The commit step printed for a legacy repair: stage only this path and commit it with the fence-repair subject and the `gbrain-repair:` trailer the Git effect would write. */
export function legacyCommitStep(root: string, path: string, classes: readonly string[], tier: FenceRepairReceipt['tier'] = 'deterministic'): string {
  return `git -C ${shellQuote([root])} add -- ${shellQuote([path])} && git -C ${shellQuote([root])} commit -m ${shellQuote([fenceRepairCommitSubject(path, classes)])} -m ${shellQuote([`gbrain-repair: invalid_fence ${tier} high`])} -- ${shellQuote([path])}`;
}

export async function recordUncommittedFenceRepair(engine: Exec, notice: UncommittedFenceRepair): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [FENCE_UNCOMMITTED_OP, fingerprint(notice.source_id, notice.incarnation, notice.path), JSON.stringify([notice])]);
}

/** True when the path has no uncommitted change in its checkout (a path outside Git is never "committed"). */
function committed(root: string, path: string): boolean {
  if (!existsSync(root)) return true;
  try {
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (status.trim()) return false;
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Outstanding notices of the scoped sources (all when unscoped); a notice whose path is now committed is dropped on read. */
export async function readUncommittedFenceRepairs(engine: Exec, sourceIds?: readonly string[]): Promise<UncommittedFenceRepair[]> {
  const rows = await engine.executeRaw<{ fingerprint: string; record: UncommittedFenceRepair }>(`SELECT fingerprint, completed_keys->0 AS record FROM op_checkpoints
    WHERE op=$1 AND ($2::text[] IS NULL OR completed_keys->0->>'source_id'=ANY($2::text[])) ORDER BY fingerprint`, [FENCE_UNCOMMITTED_OP, sourceIds ? [...sourceIds] : null]);
  const out: UncommittedFenceRepair[] = [];
  for (const row of rows) {
    if (committed(row.record.root, row.record.path)) {
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [FENCE_UNCOMMITTED_OP, row.fingerprint]);
      continue;
    }
    out.push(row.record);
  }
  return out;
}

/** What `gbrain sources status` shows per source (JSON `fence_repairs_uncommitted`); a read error shows nothing. */
export interface UncommittedFenceRepairView { path: string; repaired_at: string; backup: string | null; commit_step: string; classes: string[] }

export async function uncommittedFenceRepairsBySource(engine: Exec, sourceIds: readonly string[]): Promise<Map<string, UncommittedFenceRepairView[]>> {
  const out = new Map<string, UncommittedFenceRepairView[]>();
  for (const notice of await readUncommittedFenceRepairs(engine, sourceIds).catch(() => [])) {
    out.set(notice.source_id, [...(out.get(notice.source_id) ?? []),
      { path: notice.path, repaired_at: notice.repaired_at, backup: notice.backup, commit_step: notice.commit_step, classes: notice.receipt.classes }]);
  }
  return out;
}

export function uncommittedFenceRepairLines(sourceId: string, notices: readonly UncommittedFenceRepairView[]): string[] {
  return [`  ${sourceId}: ${notices.length} uncommitted fence repair(s); gbrain rewrote and imported them (backups kept), commit each when you are ready:`,
    ...notices.map(notice => `    ${notice.path} (${notice.classes.join(', ')}): ${notice.commit_step}`)];
}
