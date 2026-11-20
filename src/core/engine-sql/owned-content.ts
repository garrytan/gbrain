/**
 * The owned-content reads of shared-skills/content-freshness.ts and repair/content-receipt-root.ts, moved here verbatim
 * so the Rust engine can serve them as typed members. PGLite and Postgres run the same statements as before: reads
 * unscoped through executeRaw, the locked config read on the engine's own executor, so it runs inside the caller's
 * transaction. The Rust engine keeps no writer bindings and answers as an unmanaged brain
 * (rust/docs/store/repair-bookkeeping.md, "Owned content").
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import type { StoredWorktreeManifest } from '../persistence/worktree-manifest.ts';

/** One active gbrain-owned content source with its content receipt, owner binding and open work counts. */
export interface OwnedContentRow {
  id: string; incarnation: string; local_path: string; config: unknown; last_commit: string | null;
  brain_id: string; receipt: string; owner_root: string; relative_path: string; pending: number; recovering: number;
}

/**
 * Each active source with a local path, a content receipt and an active owner binding, outside company brains.
 * `sourceIds` narrows to those sources (null: all); `inheritsPersistence` reads a disabled persistence brain too
 * (graduation verify, persistence/ownership.ts).
 */
export function listOwnedContentRows(exec: LegacyUnscopedRead, sourceIds: readonly string[] | null, inheritsPersistence: boolean): Promise<OwnedContentRow[]> {
  return exec.executeRaw<OwnedContentRow>(`SELECT s.id,s.incarnation,s.local_path,s.config,s.last_commit,p.brain_id,c.value AS receipt,
      h.local_path AS owner_root,b.relative_path,
      ((SELECT COUNT(*) FROM persistence_requests r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation
        AND r.state IN ('queued','running') AND r.recovery IS NULL)
       +(SELECT COUNT(*) FROM persistence_effects e WHERE e.source_id=s.id AND e.source_incarnation=s.incarnation
        AND e.kind='withdrawal-mirror' AND e.state IN ('queued','running') AND e.recovery IS NULL))::integer AS pending,
      ((SELECT COUNT(*) FROM persistence_requests r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation
        AND (r.state='recovering' OR r.recovery IS NOT NULL))
       +(SELECT COUNT(*) FROM persistence_effects e WHERE e.source_id=s.id AND e.source_incarnation=s.incarnation
        AND e.recovery IS NOT NULL))::integer AS recovering
    FROM sources s JOIN persistence_brain p ON p.singleton=1 AND (p.enabled OR $2::boolean)
    JOIN config c ON c.key='shared_skills.content.v1.'||s.id||'.'||s.incarnation::text
    JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
    JOIN persistence_worktrees w ON w.id=b.worktree_id AND w.state='active' AND w.owner_host_id IS NOT NULL
    JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=w.owner_host_id
    WHERE NOT s.archived AND s.local_path IS NOT NULL AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS (SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain')`,
    [sourceIds ? [...sourceIds] : null, inheritsPersistence]);
}

/** A source's content receipt with its owner binding: the worktree's owner host, manifest and root. */
export interface ContentReceiptBinding {
  incarnation: string; brain_id: string; key: string; value: string; owner_host_id: string;
  manifest: StoredWorktreeManifest | null; worktree_root: string; relative_path: string;
}

/** The source's content receipt and owner binding (any worktree state), or null when it has none. */
export async function readContentReceiptBinding(exec: LegacyUnscopedRead, sourceId: string): Promise<ContentReceiptBinding | null> {
  const [row] = await exec.executeRaw<ContentReceiptBinding>(
    `SELECT s.incarnation::text AS incarnation,p.brain_id,c.key,c.value,w.owner_host_id::text AS owner_host_id,w.manifest,h.local_path AS worktree_root,b.relative_path
       FROM sources s JOIN persistence_brain p ON p.singleton=1
       JOIN config c ON c.key='shared_skills.content.v1.'||s.id||'.'||s.incarnation::text
       JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
       JOIN persistence_worktrees w ON w.id=b.worktree_id
       JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=w.owner_host_id
      WHERE s.id=$1`, [sourceId]);
  return row ?? null;
}

/** The config value under `key`, its row locked `FOR UPDATE` for the caller's transaction; null when no row. */
export async function readConfigForUpdate(exec: SqlExecutor, key: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1 FOR UPDATE', [key]);
  return row?.value ?? null;
}
