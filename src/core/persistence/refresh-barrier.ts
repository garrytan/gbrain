/**
 * Convergence PR B (docs/designs/REFRESH_WRITE_BARRIER.md): the replay side of the refresh write barrier.
 *
 * A page write admitted while `gbrain sources refresh` held its worktree waits in state `deferred` (journal.ts) until the
 * refresh is released (completed or aborted). When it is claimed, before anything is published, two checks run here:
 * the write's durable authority against current grants (it may have waited minutes), and whether the refresh changed
 * any file the publication writes. A refresh that changed one ends the write `revision_conflict` (nothing applied), so
 * a page the refresh changed is never overwritten. The check reads git, not the page revision: a refresh completes even
 * when a member's sync is blocked, so git can hold the refreshed bytes before the database does.
 */
import { relative, sep } from 'node:path';
import { execFileBounded } from '../bounded-child-exec.ts';
import { gitChildEnv } from '../git-env.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeWrite } from './authority.ts';
import type { SqlEngine, WriteRequest } from './model.ts';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
const DIFF_TIMEOUT_MS = 30_000;
const CACHED_REFRESHES = 32;
/** The paths each refresh changed, per checkout root: one diff serves the whole drain behind it. */
const changed = new Map<string, Promise<ReadonlySet<string> | null>>();

/** Paths (repository-relative, forward slashes) refresh `refreshId` changed; empty for an aborted refresh; null when unreadable. */
async function refreshChangedPaths(engine: SqlEngine, refreshId: string, root: string): Promise<ReadonlySet<string> | null> {
  const key = `${refreshId}\0${root}`;
  const held = changed.get(key);
  if (held) return held;
  const read = (async () => {
    const [refresh] = await engine.executeRaw<{ state: string; old_head: string; target_head: string; released: boolean }>(
      'SELECT state,old_head,target_head,released_at IS NOT NULL AS released FROM persistence_worktree_refreshes WHERE id=$1::uuid', [refreshId]);
    if (!refresh?.released) return null;
    if (refresh.state === 'aborted' || refresh.old_head === refresh.target_head) return new Set<string>();
    const { error, stdout } = await execFileBounded('git', ['-C', root, '-c', 'core.quotepath=false', 'diff', '--name-only', '-z', '--no-renames',
      refresh.old_head, refresh.target_head], { timeout: DIFF_TIMEOUT_MS, maxBuffer: 64 * 1024 ** 2, env: gitChildEnv(GIT_ENV) });
    return error ? null : new Set(stdout.split('\0').filter(Boolean));
  })();
  changed.set(key, read);
  read.then(paths => { if (paths === null && changed.get(key) === read) changed.delete(key); }, () => { if (changed.get(key) === read) changed.delete(key); });
  while (changed.size > CACHED_REFRESHES) changed.delete(changed.keys().next().value!);
  return read;
}

export interface DeferredRefusal { state: 'conflict' | 'failed'; failure: { code: string; message: string } }

/**
 * Null when a claimed deferred write may publish `files` (its own page file and its companions'); otherwise the terminal
 * refusal to record. A row that was never deferred is not checked.
 */
export async function deferredReplayRefusal(engine: SqlEngine, row: WriteRequest, files: ReadonlyArray<{ path: string; root: string }>): Promise<DeferredRefusal | null> {
  const refreshId = row.deferred_refresh_id;
  if (!refreshId) return null;
  try { await authorizeWrite(engine, row.authority, row.operation, row.slug); } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return { state: 'failed', failure: { code: error.code, message: `Request ${row.request_id} waited behind refresh ${refreshId}, and its credential no longer grants this write: ${error.message}` } };
  }
  let unreadable = false;
  const touched: string[] = [];
  for (const file of files) {
    const paths = await refreshChangedPaths(engine, refreshId, file.root);
    const target = relative(file.root, file.path).split(sep).join('/');
    if (paths === null) unreadable = true;
    if (paths === null || paths.has(target)) touched.push(target);
  }
  if (!touched.length) return null;
  return { state: 'conflict', failure: { code: 'revision_conflict', message: unreadable
    ? `Request ${row.request_id} waited behind refresh ${refreshId}, and what that refresh changed could not be read, so nothing was applied. Read the page again and submit the change with a new request_id.`
    : `Refresh ${refreshId} changed ${touched.join(', ')} after request ${row.request_id} was accepted, so nothing was applied and no newer content was overwritten. Read the page again and submit the change with a new request_id.` } };
}

/** Test seam: forget every cached refresh diff. */
export function _resetRefreshBarrierCacheForTests(): void { changed.clear(); }
