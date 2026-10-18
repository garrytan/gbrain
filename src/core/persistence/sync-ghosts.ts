/**
 * #6712 PR 2 (L4): after a managed sync, count the source's ghost pages (live pages whose canonical file is gone) with the
 * one classifier, `scanGhostSource` (ghost-pages.ts), and name the read-only `gbrain repair ghost-pages` preview. Sync never
 * deletes or tombstones such a page on its own: a file missing from the checkout but not deleted in Git is either an edit
 * in progress or a mistake, and only a person decides which. A path that holds a sync hold (a held deletion) is the hold's
 * to settle and is not counted. Bounded by the scan's own limits; off the owner host, or when the scan cannot tell, there
 * is no count. Best effort: a failed scan never fails the sync.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { scanGhostSource } from '../ghost-pages.ts';
import { GIT_HOLD_OP, gitHoldFingerprint } from './sync-holds.ts';

/** Full checks per sync: the count is exact up to this many candidates, `truncated` past it. */
export const SYNC_GHOST_CHECK_LIMIT = 50;

export interface SyncGhostPages { count: number; truncated: boolean; samples: string[]; fix: Action }

export async function countSyncGhosts(engine: BrainEngine, sourceId: string): Promise<SyncGhostPages | null> {
  const scan = await scanGhostSource(engine, sourceId, { candidateLimit: SYNC_GHOST_CHECK_LIMIT }).catch(() => null);
  if (!scan || scan.status !== 'known' || (!scan.ghosts.length && !scan.truncated)) return null;
  const incarnation = scan.owner?.source_incarnation ?? '';
  const held = new Set(scan.ghosts.length ? (await engine.executeRaw<{ path: string }>(`SELECT completed_keys->0->>'path' AS path FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])`,
    [GIT_HOLD_OP, scan.ghosts.map(ghost => gitHoldFingerprint(sourceId, incarnation, ghost.path))])).map(row => row.path) : []);
  const ghosts = scan.ghosts.filter(ghost => !held.has(ghost.path));
  if (!ghosts.length && !scan.truncated) return null;
  return { count: ghosts.length, truncated: scan.truncated, samples: ghosts.slice(0, 5).map(ghost => ghost.slug),
    fix: { argv: ['gbrain', 'repair', 'ghost-pages', '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false, docs: 'docs/guides/repair.md#ghost-pages',
      why: `Lists the live pages of ${sourceId} whose canonical file is missing and writes nothing. Sync never deletes them: restore a file and sync to keep its page, `
        + 'or apply the printed removal only after the user agrees.',
      verify: { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] } } };
}
