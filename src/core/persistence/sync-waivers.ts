/**
 * #5470 / #5984: no-op screens for a frozen managed-sync entry. An entry whose
 * publication would change nothing advances the cursor without an admission.
 * The decision commits in one transaction that takes the page guard and then the
 * cursor row (the fixed order), re-reads the page and refuses while any
 * unfinished request names the page, so a waiver never overtakes queued work.
 */
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { prepareManagedSyncMutation, type SyncIntent } from './sync-prepare.ts';
import { inspectUnchanged, screeningRequest, type NoopKernelWaiver } from './noop-kernel.ts';
import { validateSyncAuthority, type SyncAuthority } from './sync-authority.ts';
import { readSyncFile } from './sync-discovery.ts';
import { assertSyncPageOrigin, syncOriginScope } from './sync-origin.ts';
import { faultPoint } from './fault-points.ts';
import { pipelined } from '../page-state/transactions.ts';
import { REVISION_BACKFILL_PENDING } from '../page-state/types.ts';

export interface WaiverCursor { sourceId: string; incarnation: string; root: string; gitRoot: string; slugMode: 'git-root' | 'source-root';
  binding: { worktree_id: string }; authority: SyncAuthority; runId: string; index: number }
export interface WaiverEntry { requestId: string; slug: string; pageId: number | null; intent: SyncIntent }
export interface NoopWaiver { kind: 'import' | 'delete'; kernel: NoopKernelWaiver[] }

/** DX-A15: `GBRAIN_SYNC_WAIVE_NOOP=0` admits every entry, for triage. */
export function noopWaiversEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.GBRAIN_SYNC_WAIVE_NOOP !== '0'; }

const PAGE_MATCH = "r.source_id=$3 AND (r.slug=$4 OR r.page_id=$5::bigint OR r.intent->'renameFrom'->>'slug'=$4 OR r.intent->'renameFrom'->>'pageId'=$6)";
/**
 * CEO-A12/A34: an unfinished request for the page, by slug, page id or a rename
 * from it. Each branch matches one partial request index: worktree pending,
 * worktree recovery, and database-only pending by source incarnation.
 */
export const UNFINISHED_PAGE_REQUEST_SQL = `SELECT 1 FROM (
  (SELECT r.id FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running','recovering') AND ${PAGE_MATCH} LIMIT 1)
  UNION ALL (SELECT r.id FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.recovery IS NOT NULL AND ${PAGE_MATCH} LIMIT 1)
  UNION ALL (SELECT r.id FROM persistence_requests r WHERE r.source_incarnation=$2::uuid AND r.worktree_id IS NULL
    AND r.state IN ('queued','running','recovering') AND ${PAGE_MATCH} LIMIT 1)) unfinished LIMIT 1`;

/**
 * Screens a frozen, unadmitted entry. Returns null to admit, or the cursor that
 * `advance` (the waiver won) or `reread` (the cursor moved meanwhile) returns
 * inside the waiver transaction. A revoked sync authority throws before any
 * waiver decision.
 */
export async function waiveNoopEntry<C extends WaiverCursor>(engine: BrainEngine, cursor: C, pending: WaiverEntry, config: GBrainConfig, key: string,
  advance: (tx: BrainEngine, waived: NoopWaiver) => Promise<C>, reread: (tx: BrainEngine) => Promise<C>): Promise<C | null> {
  const waived = await screenWaiver(engine, cursor, pending, config);
  if (!waived) return null;
  const intent = pending.intent;
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: cursor.sourceId, slug: pending.slug }]);
    const [held] = await tx.executeRaw<{ run_id: string | null; index: number | string | null; request_id: string | null }>(`SELECT completed_keys->0->>'runId' AS run_id,
      completed_keys->0->'index' AS index,completed_keys->0->'pending'->>'requestId' AS request_id FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR UPDATE`, [key]);
    if (held?.run_id !== cursor.runId || Number(held.index) !== cursor.index || held.request_id !== pending.requestId) return reread(tx);
    const snapshot = await tx.readPageSnapshot(pending.slug, { sourceId: cursor.sourceId, includeDeleted: true });
    if (waived.kind === 'delete') {
      if (!softDeletedAt(snapshot, pending) || readSyncFile(cursor.root, intent.path!) !== null) return null;
      try { await assertSyncPageOrigin(tx, cursor.sourceId, intent.sourcePath!, pending.pageId, true, syncOriginScope(cursor)); }
      catch { return null; }
    } else if (snapshot?.page.id !== pending.pageId || snapshot.page.deleted_at != null || snapshot.revision !== intent.expected_revision) return null;
    const unfinished = await tx.executeRaw(UNFINISHED_PAGE_REQUEST_SQL, [cursor.binding.worktree_id, cursor.incarnation, cursor.sourceId, pending.slug, pending.pageId, String(pending.pageId)]);
    if (unfinished.length) return null;
    return advance(tx, waived);
  });
}

/**
 * The screen half of a waiver, before its transaction: whether this frozen,
 * unadmitted entry's publication would change nothing (a delete of a page
 * already soft-deleted at its frozen revision, or an unchanged import). A
 * revoked sync authority throws.
 */
export async function screenWaiver(engine: BrainEngine, cursor: WaiverCursor, pending: WaiverEntry, config: GBrainConfig): Promise<NoopWaiver | null> {
  if (!noopWaiversEnabled() || pending.pageId === null) return null;
  const intent = pending.intent;
  if (intent.kind === 'managed_sync_delete') {
    if (intent.unownedDeletion || intent.renameFrom || intent.rawHash !== null || typeof intent.path !== 'string' || typeof intent.sourcePath !== 'string') return null;
    const snapshot = await engine.readPageSnapshot(pending.slug, { sourceId: cursor.sourceId, includeDeleted: true });
    if (!softDeletedAt(snapshot, pending)) return null;
    await validateSyncAuthority(engine, cursor.authority, pending.slug);
    return { kind: 'delete', kernel: [] };
  }
  const kernel = await unchangedSyncImport(engine, cursor, pending, config);
  if (!kernel) return null;
  await validateSyncAuthority(engine, cursor.authority, pending.slug);
  return { kind: 'import', kernel };
}

/** #5984: `GBRAIN_SYNC_WAIVE_BATCH=0` (or `sync.waive_batch=false`) waives one entry per transaction, as before. */
export async function waiverBatchEnabled(engine: BrainEngine, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const value = env.GBRAIN_SYNC_WAIVE_BATCH ?? await engine.getConfig('sync.waive_batch').catch(() => null);
  return !(value === '0' || value === 'false');
}
export interface WaiverRunEntry { pending: WaiverEntry; waived: NoopWaiver }
/**
 * #5984 Phase 3: commits a run of consecutive screened waivers at the cursor
 * head in one transaction. It takes every page guard (in the engine's key
 * order) and then the cursor row, which must still be at the run's first entry
 * with nothing pending; it re-validates each entry inside the transaction
 * (page identity, revision and deleted state, file absence and origin for a
 * delete, no unfinished request for the page) and advances only past the
 * contiguous validated prefix. Returns null when not even the first entry
 * holds, or on a lock or statement timeout, so the caller takes the per-entry
 * path; `next` is the frozen entry that stopped the prefix, for that path to
 * screen again without re-freezing; `reread` answers when another run moved
 * the cursor.
 */
export async function waiveNoopRun<C extends WaiverCursor>(engine: BrainEngine, cursor: C, run: readonly WaiverRunEntry[], key: string,
  advance: (tx: BrainEngine, prefix: readonly WaiverRunEntry[]) => Promise<C>, reread: (tx: BrainEngine) => Promise<C>): Promise<{ cursor: C; waived: number; next?: WaiverEntry } | null> {
  if (!run.length) return null;
  try {
    return await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','2s',true),set_config('statement_timeout','10s',true)");
      await tx.lockPageKeys(run.map(entry => ({ sourceId: cursor.sourceId, slug: entry.pending.slug })));
      const [held] = await tx.executeRaw<{ run_id: string | null; index: number | string | null; request_id: string | null }>(`SELECT completed_keys->0->>'runId' AS run_id,
        completed_keys->0->'index' AS index,completed_keys->0->'pending'->>'requestId' AS request_id FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR UPDATE`, [key]);
      if (held?.run_id !== cursor.runId || Number(held.index) !== cursor.index || held.request_id != null) return { cursor: await reread(tx), waived: 0 };
      await faultPoint('sync:mid_waiver_run', { sourceId: cursor.sourceId });
      const pages = await tx.executeRaw<{ id: number | string; slug: string; deleted: boolean; knowledge_revision: string | number | null }>(
        'SELECT id,slug,deleted_at IS NOT NULL AS deleted,knowledge_revision FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])', [cursor.sourceId, run.map(entry => entry.pending.slug)]);
      const bySlug = new Map(pages.map(page => [page.slug, page]));
      const scope = syncOriginScope(cursor);
      const checks = await pipelined(tx, run.flatMap(({ pending, waived }) => [
        () => tx.executeRaw(UNFINISHED_PAGE_REQUEST_SQL, [cursor.binding.worktree_id, cursor.incarnation, cursor.sourceId, pending.slug, pending.pageId, String(pending.pageId)]),
        () => waived.kind === 'delete'
          ? assertSyncPageOrigin(tx, cursor.sourceId, pending.intent.sourcePath!, pending.pageId, true, scope).then(() => true, () => false)
          : Promise.resolve(true),
      ])) as Array<unknown[] | boolean>;
      let valid = 0;
      for (const [i, { pending, waived }] of run.entries()) {
        const page = bySlug.get(pending.slug);
        const revision = page ? page.knowledge_revision == null ? REVISION_BACKFILL_PENDING : String(page.knowledge_revision) : null;
        if (!page || Number(page.id) !== pending.pageId || revision !== pending.intent.expected_revision) break;
        if (waived.kind === 'delete' ? !page.deleted || readSyncFile(cursor.root, pending.intent.path!) !== null : page.deleted) break;
        if ((checks[2 * i] as unknown[]).length || checks[2 * i + 1] !== true) break;
        valid++;
      }
      if (!valid) return null;
      return { cursor: await advance(tx, run.slice(0, valid)), waived: valid, ...(valid < run.length ? { next: run[valid]!.pending } : {}) };
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '55P03' || code === '57014') return null;
    throw error;
  }
}

/** #5984: whether `waiveNoopEntry` would waive this frozen entry now (read-only; the bulk group stops before such an entry). */
export async function wouldWaiveEntry(engine: BrainEngine, cursor: WaiverCursor, pending: WaiverEntry, config: GBrainConfig): Promise<boolean> {
  if (!noopWaiversEnabled() || pending.pageId === null) return false;
  const intent = pending.intent;
  if (intent.kind === 'managed_sync_delete') {
    if (intent.unownedDeletion || intent.renameFrom || intent.rawHash !== null || typeof intent.path !== 'string' || typeof intent.sourcePath !== 'string') return false;
    return softDeletedAt(await engine.readPageSnapshot(pending.slug, { sourceId: cursor.sourceId, includeDeleted: true }), pending);
  }
  return (await unchangedSyncImport(engine, cursor, pending, config)) !== null;
}

function softDeletedAt(snapshot: Awaited<ReturnType<BrainEngine['readPageSnapshot']>>, pending: WaiverEntry): boolean {
  return snapshot?.page.id === pending.pageId && snapshot.page.deleted_at != null && snapshot.revision === pending.intent.expected_revision;
}

/**
 * #5470 no-op screen for working-tree and company-profile sync: runs the sync
 * preparer on the frozen, unadmitted entry. A rename or a canonical overlay is
 * always admitted. Returns null to admit, or the kernel waivers the skip used.
 * #5751: a managed working-tree entry waives the two admit reasons its no-op
 * publication can never resolve (a pending contextual-mode stamp, and file
 * bytes that differ from the prepared content yet parse to the same page), so
 * an unchanged legacy file stops taking a request ID on every run.
 */
export async function unchangedSyncImport(engine: BrainEngine, cursor: WaiverCursor, pending: WaiverEntry, config: GBrainConfig): Promise<NoopKernelWaiver[] | null> {
  const intent = pending.intent;
  if (intent.kind !== 'managed_sync_import' || intent.renameFrom || pending.pageId === null || typeof intent.path !== 'string' || typeof intent.content !== 'string') return null;
  try {
    const snapshot = await engine.readPageSnapshot(pending.slug, { sourceId: cursor.sourceId, includeDeleted: true });
    const row = screeningRequest({ source_id: cursor.sourceId, source_incarnation: cursor.incarnation, slug: pending.slug, page_id: pending.pageId,
      worktree_id: cursor.binding.worktree_id, authority: cursor.authority.writer, intent, request_id: pending.requestId });
    const prepared = await prepareManagedSyncMutation(engine, row, config);
    if (prepared.file || prepared.target === 'skill_bundle') return null;
    const file = { root: cursor.root, path: join(cursor.root, intent.path), content: intent.content };
    const inspected = await inspectUnchanged(engine, { prepared: { ...prepared, target: 'page', file }, snapshot, sourcePath: intent.sourcePath, databaseOnly: false,
      embeddingRequested: !prepared.deferEmbedding && !config.embedding_disabled && !!config.embedding_model?.trim(),
      waive: intent.working === true ? ['contextual_mode', 'canonical_file_differs'] : undefined });
    if (inspected.admitReason) return null;
    await prepared.validate?.(engine);
    return inspected.waived ?? [];
  } catch {
    return null;
  }
}
