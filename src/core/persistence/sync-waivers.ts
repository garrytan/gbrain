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
import { startClaimPhase } from './claim-phase.ts';
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

/** `persistence.sync_preparation_ms` (preparation-budget.ts validates it): the budget a managed sync member's preparation gets; default 120 s. */
export const SYNC_PREPARATION_MS_KEY = 'persistence.sync_preparation_ms';
export const SYNC_PREPARATION_DEFAULT_MS = 120_000;
const BUDGET_TTL_MS = 5000;
let budgets = new WeakMap<object, { at: number; read: Promise<number> }>();
/** The sync preparation budget of `engine`'s brain, read at most every BUDGET_TTL_MS; a failed or malformed read is the default. */
export function syncPreparationBudgetMs(engine: Pick<BrainEngine, 'getConfig'>, now = Date.now()): Promise<number> {
  const held = budgets.get(engine);
  if (held && now - held.at < BUDGET_TTL_MS) return held.read;
  const read = engine.getConfig(SYNC_PREPARATION_MS_KEY).then(value => {
    const n = Number(value?.trim());
    return Number.isInteger(n) && n > 0 ? n : SYNC_PREPARATION_DEFAULT_MS;
  }, () => SYNC_PREPARATION_DEFAULT_MS);
  budgets.set(engine, { at: now, read });
  return read;
}
/** Test seam: the next read sees the current config. */
export function resetSyncPreparationBudget(): void { budgets = new WeakMap(); }

/** The error `raceSyncBudget` rejects with when the budget passes; callers treat it as "cannot decide" and fail open. */
export class SyncPreparationBudgetExceeded extends Error {
  constructor(readonly budgetMs: number) { super(`The sync preparation did not finish within ${budgetMs} ms.`); this.name = 'SyncPreparationBudgetExceeded'; }
}
/**
 * #6278 (1.10): a sync preparation run outside the consumer (a waiver screen or
 * the #5522 origin-equivalence check) runs on the feeder's event loop, where the
 * consumer's deadline cannot see a hang. This races `work` against the sync
 * budget and the run's signal: past the budget it rejects with
 * `SyncPreparationBudgetExceeded` (the caller fails open: nothing is waived,
 * the origin refusal stands, nothing is counted or held); an aborted signal
 * rejects with its reason, so run cancellation propagates. The late result is
 * dropped, never read.
 */
export function raceSyncBudget<T>(work: Promise<T>, budgetMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('The sync was cancelled.', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new SyncPreparationBudgetExceeded(budgetMs)); }, budgetMs);
    timer.unref?.();
    const onAbort = () => { cleanup(); reject(signal!.reason ?? new DOMException('The sync was cancelled.', 'AbortError')); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
const rethrowAbort = (error: unknown, signal?: AbortSignal) => { if (signal?.aborted) throw error; };

/** DX-A15: `GBRAIN_SYNC_WAIVE_NOOP=0` admits every entry, for triage. */
export function noopWaiversEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.GBRAIN_SYNC_WAIVE_NOOP !== '0'; }

const PAGE_MATCH = `r.source_id=$3 AND (r.slug=$4 OR r.page_id=$5::bigint OR r.intent->'renameFrom'->>'slug'=$4 OR r.intent->'renameFrom'->>'pageId'=$6
  OR ($7::text IS NOT NULL AND (r.intent->>'path'=$7 OR r.intent->>'sourcePath'=$8 OR r.intent->'renameFrom'->>'sourcePath'=$8)))`;
/**
 * CEO-A12/A34: an unfinished request for the page, by slug, page id or a rename
 * from it; #6278: also by the entry's file path or origin, or a rename from that
 * origin (`$7`, `$8`; null skips the path match). Each branch matches one
 * partial request index: worktree pending, worktree recovery, and
 * database-only pending by source incarnation.
 */
export const UNFINISHED_PAGE_REQUEST_SQL = `SELECT 1 FROM (
  (SELECT r.id FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running','recovering') AND ${PAGE_MATCH} LIMIT 1)
  UNION ALL (SELECT r.id FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.recovery IS NOT NULL AND ${PAGE_MATCH} LIMIT 1)
  UNION ALL (SELECT r.id FROM persistence_requests r WHERE r.source_incarnation=$2::uuid AND r.worktree_id IS NULL
    AND r.state IN ('queued','running','recovering') AND ${PAGE_MATCH} LIMIT 1)) unfinished LIMIT 1`;

/** The parameters of `UNFINISHED_PAGE_REQUEST_SQL` for one frozen entry (slug, page id, file path and origin). */
export function unfinishedPageRequestParams(cursor: Pick<WaiverCursor, 'sourceId' | 'incarnation' | 'binding'>, pending: Pick<WaiverEntry, 'slug' | 'pageId' | 'intent'>): unknown[] {
  return [cursor.binding.worktree_id, cursor.incarnation, cursor.sourceId, pending.slug, pending.pageId, String(pending.pageId),
    pending.intent.path ?? null, pending.intent.sourcePath ?? pending.intent.path ?? null];
}

/**
 * Screens a frozen, unadmitted entry. Returns null to admit, or the cursor that
 * `advance` (the waiver won) or `reread` (the cursor moved meanwhile) returns
 * inside the waiver transaction. A revoked sync authority throws before any
 * waiver decision.
 */
export async function waiveNoopEntry<C extends WaiverCursor>(engine: BrainEngine, cursor: C, pending: WaiverEntry, config: GBrainConfig, key: string,
  advance: (tx: BrainEngine, waived: NoopWaiver) => Promise<C>, reread: (tx: BrainEngine) => Promise<C>, signal?: AbortSignal): Promise<C | null> {
  const waived = await screenWaiver(engine, cursor, pending, config, signal);
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
    const unfinished = await tx.executeRaw(UNFINISHED_PAGE_REQUEST_SQL, unfinishedPageRequestParams(cursor, pending));
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
export async function screenWaiver(engine: BrainEngine, cursor: WaiverCursor, pending: WaiverEntry, config: GBrainConfig, signal?: AbortSignal): Promise<NoopWaiver | null> {
  if (!noopWaiversEnabled() || pending.pageId === null) return null;
  const intent = pending.intent;
  if (intent.kind === 'managed_sync_delete') {
    if (intent.unownedDeletion || intent.renameFrom || intent.rawHash !== null || typeof intent.path !== 'string' || typeof intent.sourcePath !== 'string') return null;
    const snapshot = await engine.readPageSnapshot(pending.slug, { sourceId: cursor.sourceId, includeDeleted: true });
    if (!softDeletedAt(snapshot, pending)) return null;
    await validateSyncAuthority(engine, cursor.authority, pending.slug);
    return { kind: 'delete', kernel: [] };
  }
  const kernel = await unchangedSyncImport(engine, cursor, pending, config, signal);
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
        () => tx.executeRaw(UNFINISHED_PAGE_REQUEST_SQL, unfinishedPageRequestParams(cursor, pending)),
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
export async function wouldWaiveEntry(engine: BrainEngine, cursor: WaiverCursor, pending: WaiverEntry, config: GBrainConfig, signal?: AbortSignal): Promise<boolean> {
  if (!noopWaiversEnabled() || pending.pageId === null) return false;
  const intent = pending.intent;
  if (intent.kind === 'managed_sync_delete') {
    if (intent.unownedDeletion || intent.renameFrom || intent.rawHash !== null || typeof intent.path !== 'string' || typeof intent.sourcePath !== 'string') return false;
    return softDeletedAt(await engine.readPageSnapshot(pending.slug, { sourceId: cursor.sourceId, includeDeleted: true }), pending);
  }
  return (await unchangedSyncImport(engine, cursor, pending, config, signal)) !== null;
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
 * #6278: the preparation races the sync budget (`raceSyncBudget`); past it
 * nothing is waived, and a cancelled run propagates.
 */
export async function unchangedSyncImport(engine: BrainEngine, cursor: WaiverCursor, pending: WaiverEntry, config: GBrainConfig, signal?: AbortSignal): Promise<NoopKernelWaiver[] | null> {
  const intent = pending.intent;
  if (intent.kind !== 'managed_sync_import' || intent.renameFrom || pending.pageId === null || typeof intent.path !== 'string' || typeof intent.content !== 'string') return null;
  try {
    const snapshot = await engine.readPageSnapshot(pending.slug, { sourceId: cursor.sourceId, includeDeleted: true });
    const row = screeningRequest({ source_id: cursor.sourceId, source_incarnation: cursor.incarnation, slug: pending.slug, page_id: pending.pageId,
      worktree_id: cursor.binding.worktree_id, authority: cursor.authority.writer, intent, request_id: pending.requestId });
    // #6278 (1.4): the clock carries the budget, so the preparation's lock-prone reads end on the server at it (boundedReads).
    const budgetMs = await syncPreparationBudgetMs(engine);
    const prepared = await raceSyncBudget(prepareManagedSyncMutation(engine, row, config, startClaimPhase(Date.now(), undefined, budgetMs)), budgetMs, signal);
    if (prepared.file || prepared.target === 'skill_bundle') return null;
    const file = { root: cursor.root, path: join(cursor.root, intent.path), content: intent.content };
    const inspected = await inspectUnchanged(engine, { prepared: { ...prepared, target: 'page', file }, snapshot, sourcePath: intent.sourcePath, databaseOnly: false,
      embeddingRequested: !prepared.deferEmbedding && !config.embedding_disabled && !!config.embedding_model?.trim(),
      waive: intent.working === true ? ['contextual_mode', 'canonical_file_differs'] : undefined });
    if (inspected.admitReason) return null;
    await prepared.validate?.(engine);
    return inspected.waived ?? [];
  } catch (error) {
    rethrowAbort(error, signal);
    return null;
  }
}
