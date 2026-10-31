/**
 * #5470 no-op kernel: one request-free check, beneath the connector, managed
 * import, working-tree sync and company-profile paths, that decides whether an
 * item can skip admission because publishing it would change nothing.
 *
 * Each path runs its publication preparer on an unadmitted, synthetic request
 * (the preparers read only the database and the local canonical root, so this
 * runs on the connector or import host), then asks the kernel. An item is
 * skipped only when:
 *   - the prepared mutation is a no-op and observed the snapshot revision, and the
 *     page still holds that revision when the kernel reads it,
 *   - no projection work is pending (safe-chunk re-seal, text projection behind
 *     the knowledge revision, an embedded page with no contextual mode, or
 *     unembedded chunks when the publication would queue embedding),
 *   - no metadata work is pending (the stored source path differs),
 *   - the page exists and is not deleted, and
 *   - the page has no canonical file by design (database-only), or the local
 *     canonical file bytes equal the serialized page.
 * The preparer's own `validate` then re-checks authority, source incarnation,
 * identity and revision before the skip is counted. Anything else is admitted
 * and published exactly as before.
 *
 * #5751: a caller may waive two admit reasons that its no-op publication can
 * never resolve (so admitting them re-admits the same item on every run): a
 * pending contextual-mode stamp (only an import that changes the page, or
 * `gbrain repair contextual-mode`, stamps it) and canonical file bytes that
 * differ from the prepared content while parsing to the same page. Every
 * other check still runs; the result lists each waiver it applied.
 */
import type { BrainEngine } from '../engine.ts';
import type { PreparedMutation } from './coordinator.ts';
import { persistenceFileHash } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { belowSafeChunkFence, chunkGenerationFilter, chunkManifestReads, SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { fileContentHash } from './large-file.ts';
import { embeddingWriteTarget } from '../page-state/projections.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';

export interface NoopKernelResult {
  contentUnchanged: boolean;
  projectionWorkRequired: boolean;
  metadataWorkRequired: boolean;
  observedRevision: string | null;
  /** Why the item is admitted; absent when it may be skipped. */
  admitReason?: 'content_changed' | 'page_missing' | 'page_deleted' | 'revision_moved' | 'projection_work' | 'metadata_work' | 'canonical_file_differs';
  /** The caller's waivers that this skip relied on. */
  waived?: NoopKernelWaiver[];
}
export type NoopKernelWaiver = 'contextual_mode' | 'canonical_file_differs';

/** A request-shaped value for preparers; it is never admitted or persisted. */
export function screeningRequest(fields: Pick<WriteRequest, 'source_id' | 'source_incarnation' | 'slug' | 'page_id' | 'worktree_id' | 'authority' | 'intent'>
  & Partial<WriteRequest>): WriteRequest {
  return { id: '00000000-0000-4000-8000-000000000000', request_id: '00000000-0000-4000-8000-000000000000', operation: 'submit_job', state: 'queued',
    principal_kind: fields.authority.principal.kind, principal_id: fields.authority.principal.id, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), protocol_version: 1, target_kind: 'page', ...fields } as unknown as WriteRequest;
}

/** What the kernel reads about a live page: its projection state, revision and recorded origin. */
export interface KernelPage { id: number | string; slug: string; chunker_version: number | null; text_projection_revision: string | null; knowledge_revision: string;
  mode_pending: boolean; unembedded: boolean; source_path: string | null }
/**
 * The kernel's page read; callers append the `WHERE` (one page by id, or #6712 PR 1 a prescreened run by slug).
 * `manifest` is chunkManifestReads: a write role without the segment grants that sees no segmented chunk reads it too.
 */
export const kernelPageSql = (manifest: boolean) => `SELECT p.id,p.slug,p.chunker_version,p.text_projection_revision::text,p.knowledge_revision::text,p.source_path,
      (p.contextual_retrieval_mode IS NULL AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding IS NOT NULL AND ${chunkGenerationFilter('p', 'c', manifest)})) AS mode_pending,
      EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding IS NULL AND ${chunkGenerationFilter('p', 'c', manifest)}) AS unembedded
    FROM pages p`;

/**
 * The projection and metadata work a no-op would leave undone on `page` (null: none): a safe-chunk re-seal, a text
 * projection behind the knowledge revision, a contextual-mode stamp (unless `waived` lists it), unembedded chunks when
 * the publication would queue embedding, or a stored source path that differs.
 */
export function kernelPageWork(page: KernelPage, input: { sourcePath: string | null; embeddingRequested?: boolean; waived?: readonly NoopKernelWaiver[] }): 'projection_work' | 'metadata_work' | null {
  if (belowSafeChunkFence(page.chunker_version === null ? null : Number(page.chunker_version)) || page.text_projection_revision !== page.knowledge_revision
    || page.mode_pending === true && !input.waived?.includes('contextual_mode') || input.embeddingRequested === true && page.unembedded === true) return 'projection_work';
  return input.sourcePath !== null && page.source_path !== input.sourcePath ? 'metadata_work' : null;
}

export async function inspectUnchanged(engine: Pick<BrainEngine, 'kind' | 'executeRaw'>, input: {
  prepared: PreparedMutation; snapshot: PageSnapshot | null; sourcePath: string | null; databaseOnly: boolean;
  /** The publication would queue an embedding effect: a page with unembedded chunks is then not skipped. */
  embeddingRequested?: boolean;
  waive?: readonly NoopKernelWaiver[];
}): Promise<NoopKernelResult> {
  const { prepared, snapshot } = input;
  const observedRevision = prepared.observedRevision ?? null;
  const unchanged = prepared.noop === true || prepared.contentUnchanged === true;
  const result = (reason?: NoopKernelResult['admitReason'], flags: Partial<NoopKernelResult> = {}): NoopKernelResult => ({
    contentUnchanged: unchanged, projectionWorkRequired: false, metadataWorkRequired: false, observedRevision, ...flags,
    ...(reason ? { admitReason: reason } : {}) });
  if (!snapshot) return result('page_missing');
  if (snapshot.page.deleted_at != null) return result('page_deleted');
  if (!unchanged) return result('content_changed');
  if (observedRevision !== snapshot.revision) return result('revision_moved');
  const [page] = await engine.executeRaw<KernelPage>(`${kernelPageSql(await chunkManifestReads(engine))} WHERE p.id=$1 AND p.deleted_at IS NULL`, [snapshot.page.id]);
  if (!page) return result('page_missing');
  // The page's current revision, read after the preparer ran: a write that landed since the snapshot was read is admitted.
  if (page.knowledge_revision != null && page.knowledge_revision !== snapshot.revision) return result('revision_moved');
  const waived: NoopKernelWaiver[] = [];
  if (page.mode_pending === true && input.waive?.includes('contextual_mode')) waived.push('contextual_mode');
  const pending = kernelPageWork(page, { sourcePath: input.sourcePath, embeddingRequested: input.embeddingRequested, waived });
  if (pending === 'projection_work') return result(pending, { projectionWorkRequired: true });
  if (pending === 'metadata_work') return result(pending, { metadataWorkRequired: true });
  if (!input.databaseOnly) {
    const file = prepared.file;
    const onDisk = file && file.content !== null ? persistenceFileHash(file.path) : null;
    if (!file || file.content === null || onDisk !== fileContentHash(file.content)) {
      if (onDisk === null || !input.waive?.includes('canonical_file_differs')) return result('canonical_file_differs');
      waived.push('canonical_file_differs');
    }
  }
  return result(undefined, waived.length ? { waived } : {});
}

/**
 * #7866: whether a content no-op leaves the page no embedding work: its text projection is sealed at its revision and at or
 * above the safe-chunk fence (the no-op rebuilds neither, as kernelPageWork says), and every chunk of its current generation
 * has a vector in the active column for its exact text. Such a no-op queues no embedding effect (a re-sync, a conversion's
 * strict pass); a page with projection work, a chunk never embedded, or one embedded for other text still gets one, as
 * before. A model change keeps the column's vectors until `gbrain embed --stale`, as for any page that was not written.
 */
export async function chunksEmbeddedAsIs(engine: Pick<BrainEngine, 'kind' | 'executeRaw'>, pageId: number): Promise<boolean> {
  const { column } = await embeddingWriteTarget(engine);
  const [row] = await engine.executeRaw<{ current: boolean }>(`SELECT p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision
      AND COALESCE(p.chunker_version, 0) >= ${SAFE_FENCE_CHUNKER_VERSION}
      AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND ${chunkGenerationFilter('p', 'c', await chunkManifestReads(engine))}
        AND (c.${quoteIdentifier(column.name)} IS NULL OR c.embedded_at IS NULL OR c.embedded_text_hash IS DISTINCT FROM md5(c.chunk_text))) AS current
    FROM pages p WHERE p.id=$1`, [pageId]);
  return row?.current === true;
}
