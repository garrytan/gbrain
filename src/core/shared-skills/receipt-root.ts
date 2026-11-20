/**
 * C-7 (#6892): keep the shared-skills content receipt (`shared_skills.content.v1.<source>.<incarnation>`) on the
 * canonical root when a topology change moves it. A writer transfer accept and a `sources set-path` rebind call
 * `rebindContentReceipts` inside their own transaction, so the receipt commits and rolls back with the move.
 * Only an owned receipt of this brain and the source's current incarnation is rewritten: its `root` becomes the
 * realpath of the host binding's root joined with the source's `relative_path` (nested sources included) and its
 * `root_identity` that directory's device and inode. A root that cannot be read leaves the receipt as it is.
 */
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ContentReceiptStore } from '../engine-sql/writer-admin.ts';

export interface ContentReceiptRebind { source_id: string; source_incarnation: string; from: string | null; to: string }

/** The receipt's parsed JSON when it is an owned receipt of this brain and source incarnation, else null. */
export function ownedContentReceipt(raw: string | null | undefined, brainId: string, sourceId: string, incarnation: string): Record<string, unknown> | null {
  let receipt: unknown;
  try { receipt = JSON.parse(raw ?? ''); } catch { return null; }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const r = receipt as Record<string, unknown>;
  return r.version === 1 && r.brain_id === brainId && r.source_id === sourceId && r.source_incarnation === incarnation && r.owned_root === true ? r : null;
}

/** The directory's realpath with its device and inode, or null when it cannot be read. */
export function rootIdentity(path: string): { root: string; root_identity: { device: number; inode: number } } | null {
  try {
    const root = realpathSync(path);
    const stat = statSync(root);
    return stat.isDirectory() ? { root, root_identity: { device: stat.dev, inode: stat.ino } } : null;
  } catch { return null; }
}

/**
 * Rebinds the owned content receipts of the sources bound to `worktreeIds` (only `sourceIds` when given) to their
 * root under `hostId`'s binding; returns what moved. Runs on the caller's transaction, through its store: the writer-admin
 * store (an accept), or `sqlContentReceiptStore(tx)` (engine-sql/writer-admin.ts) for a SQL transaction.
 */
export async function rebindContentReceipts(store: ContentReceiptStore, worktreeIds: string[], hostId: string, sourceIds?: string[]): Promise<ContentReceiptRebind[]> {
  const rows = await store.contentReceiptRows(worktreeIds, hostId, sourceIds);
  const moved: ContentReceiptRebind[] = [];
  for (const row of rows) {
    const receipt = ownedContentReceipt(row.value, row.brain_id, row.source_id, row.incarnation);
    const next = receipt && rootIdentity(resolve(row.local_path, row.relative_path));
    if (!receipt || !next) continue;
    const identity = receipt.root_identity as { device?: number; inode?: number } | undefined;
    if (receipt.root === next.root && identity?.device === next.root_identity.device && identity?.inode === next.root_identity.inode) continue;
    await store.swapConfigValue(row.key, JSON.stringify({ ...receipt, ...next }), row.value);
    moved.push({ source_id: row.source_id, source_incarnation: row.incarnation, from: typeof receipt.root === 'string' ? receipt.root : null, to: next.root });
  }
  return moved;
}
