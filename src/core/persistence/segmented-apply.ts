/**
 * Segmented page publication (Wave B, spec 3.4): the statements a segmented
 * write runs inside its publication transaction (managed: the coordinator's
 * `publicationTransaction`; unmanaged: the importer's own transaction), after
 * everything heavy was staged by `prepareSegmentedBody`.
 *
 * - Create: the page row (`createSegmentedPageShell`), its manifest rows and
 *   the flip 0 -> 1. A create within SEGMENTED_CREATE_SEAL_MAX_BYTES inserts
 *   the chunk rows its preparation held (`createChunks`) and the caller seals;
 *   a larger one stays unsealed (chunks of a page row that did not exist could
 *   not be staged) and `buildSegmentedProjection` chunks it after commit, or
 *   the projection queue does after a crash.
 * - Replace (and promotion from inline): the flip G -> G+1 over the staged
 *   rows, dropping chunk rows a dead preparation left under G+1; the caller
 *   seals as its last revision-changing step when every occurrence has chunks
 *   and the flip retired its rows in the transaction.
 * - Demotion (an inline write onto a segmented page): the page row becomes an
 *   inline row with an empty body in the same transaction as the inline write;
 *   the live manifest rows close (versions keep theirs) and the demotion
 *   deletes the segmented chunk rows before the inline write stages its own.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { JsonObject, SegmentedPageMeta } from '../page-body/types.ts';
import type { PreparedSegmentedBody, SegmentChunkingContext, SegmentedLivePage, SegmentedStagingOwner } from '../page-body/ingest.ts';
import { materializeSegmentedBody, prepareSegmentedBody, segmentWriteScope, stringBodyFlags, stringRegion } from '../page-body/ingest.ts';
import { buildSegmentedProjection } from '../page-body/projection.ts';
import { maintenanceAttribution } from './attribution.ts';
import { readPageBodyPolicy, chooseBodyStorage, SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES, type PageBodyPolicy } from '../page-body/limits.ts';
import { SEGMENTED_CHUNKER_VERSION } from '../page-body/segment-chunks.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { pageSearchVectorSql } from '../fts-language.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { overlayCanonicalBodies, readPageSnapshot } from '../page-state/snapshot.ts';
import { faultPoint } from './fault-points.ts';
import { bodyStagingGoneError, LIVE_STAGING_STATES } from '../engine-sql/page-body.ts';
import { segmentedPageSearchable } from './searchable.ts';
import { stableJson } from './digest.ts';
import { pageBodyOverCeilingError } from '../page-body/page-shape.ts';
import { assertOriginUnclaimed } from './origin-guard.ts';

const BODY_KEYS = new Set(['compiled_truth', 'timeline', 'content']);

/**
 * A page row's storage class without touching its (possibly throwing) body
 * getters. A row read without `body_storage` is segmented when its
 * `compiled_truth` is a stored NULL, which the storage CHECK allows only there.
 */
export function bodyStorageOf(page: object | null | undefined): 'inline' | 'segmented' | null {
  if (!page) return null;
  const storage = (page as { body_storage?: string }).body_storage;
  if (storage !== undefined) return storage === 'segmented' ? 'segmented' : 'inline';
  return Object.getOwnPropertyDescriptor(page, 'compiled_truth')?.value === null ? 'segmented' : 'inline';
}

/** The live page a segmented write diffs against, read by id (metadata only). */
export async function segmentedLivePage(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<SegmentedLivePage> {
  const [row] = await engine.executeRaw<{ id: number; body_generation: number | string; body_storage: string; title: string; type: string; body_flags: JsonObject | null }>(
    'SELECT id, body_generation, body_storage, title, type, body_flags FROM pages WHERE id=$1', [pageId]);
  if (!row) throw new Error(`Page ${pageId} not found.`);
  return { id: Number(row.id), generation: Number(row.body_generation), storage: row.body_storage === 'segmented' ? 'segmented' : 'inline', title: row.title, type: row.type,
    flags: row.body_flags };
}

/**
 * A copy of a segmented page with its body read back as strings, for the
 * single-string write paths (put_page, capture, coordinated sync and import of
 * files within the ceiling) that compare against or merge into the stored
 * body. A body above the single-string ceiling is returned as is: any step
 * that reads it refuses with `page_body_segmented` (its throwing getters), so
 * such a page is rewritten only by a streamed import.
 */
export async function materializedPage<T extends Page>(engine: BrainEngine, page: T): Promise<T>;
export async function materializedPage<T extends Page>(engine: BrainEngine, page: T | null): Promise<T | null>;
export async function materializedPage<T extends Page>(engine: BrainEngine, page: T | null): Promise<T | null> {
  if (!page || bodyStorageOf(page) !== 'segmented' || typeof Object.getOwnPropertyDescriptor(page, 'compiled_truth')?.value === 'string') return page;
  const bytes = (page as { body_bytes?: number | string | null }).body_bytes
    ?? (await engine.executeRaw<{ body_bytes: string }>('SELECT body_bytes::text AS body_bytes FROM pages WHERE id=$1', [page.id]))[0]?.body_bytes;
  if (Number(bytes ?? 0) > PAGE_MAX_BYTES) return page;
  const copy: Record<string, unknown> = { body_storage: 'segmented' };
  for (const key of Object.keys(page)) if (!BODY_KEYS.has(key)) copy[key] = (page as Record<string, unknown>)[key];
  Object.assign(copy, await materializeSegmentedBody(engine, Number(page.id), page.source_id));
  return copy as T;
}

/** A segmented page whose body is over the single-string ceiling: `materializedPage` leaves its throwing body fields as they are. */
export function segmentedOverCeiling(page: { body_storage?: string | null; body_bytes?: number | null }): boolean {
  return page.body_storage === 'segmented' && Number(page.body_bytes ?? 0) > PAGE_MAX_BYTES;
}

/**
 * `materializedPage` over a snapshot (null passes through), with the read-back body under the snapshot's withdrawal
 * ledger, as readPageSnapshot gives an inline page's body: a facts row the ledger withdraws is struck (or, purged,
 * dropped), so the body a write merges into or the drift check compares a file with is the one an inline page has.
 */
export async function materializedSnapshot(engine: BrainEngine, snapshot: PageSnapshot | null): Promise<PageSnapshot | null> {
  if (!snapshot || bodyStorageOf(snapshot.page) !== 'segmented') return snapshot;
  const page = await materializedPage(engine, snapshot.page);
  if (page === snapshot.page) return snapshot;
  Object.assign(page, await overlayCanonicalBodies(engine.executeRaw.bind(engine), page.compiled_truth, page.timeline ?? '', snapshot.withdrawals,
    { sourceId: page.source_id, marker: snapshot.globalPurges }));
  return { ...snapshot, page };
}

/**
 * The snapshot a whole-body write (a fence or timeline edit through the put path) reads and merges into: a segmented
 * page within PAGE_MAX_BYTES read back as strings, as `materializedSnapshot` gives it; one over it refuses with
 * `page_body_segmented` (`site` names the write) before anything is read or staged.
 */
export async function wholeBodySnapshot(engine: BrainEngine, snapshot: PageSnapshot | null, site: string): Promise<PageSnapshot | null> {
  if (snapshot && segmentedOverCeiling(snapshot.page)) throw pageBodyOverCeilingError(snapshot.page, site);
  return materializedSnapshot(engine, snapshot);
}

/**
 * The storage class of a string write: reads the policy only when the class
 * could be segmented (a body over the demote bound, or a segmented page), so
 * small inline writes issue no extra statement.
 */
export async function stringWriteStorage(engine: BrainEngine, bodyBytes: number, current: 'inline' | 'segmented' | null):
  Promise<{ storage: 'inline' | 'segmented'; policy: PageBodyPolicy | null }> {
  if (bodyBytes <= SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES && current !== 'segmented') return { storage: 'inline', policy: null };
  const policy = await readPageBodyPolicy(engine);
  return { storage: chooseBodyStorage({ policy, bodyBytes, current, pageKind: 'markdown' }), policy };
}

export interface SegmentedApplyInput {
  slug: string;
  sourceId: string;
  /** Null for create. */
  pageId: number | null;
  prepared: PreparedSegmentedBody;
  meta: SegmentedPageMeta;
  /** The page was inline before this write (promotion): its inline chunk rows retire. */
  promotion: boolean;
  retireMaxRows: number;
  /** The persistence request committing the staging, when the write is journaled. */
  requestId?: string | null;
}

/** `complete`: every occurrence has chunks and no retired occurrence's row is still stored, so the caller seals as its last step (`sealSegmentedPage`). */
export interface SegmentedApplied { pageId: number; complete: boolean; retireDeferred: boolean }

/**
 * Seal a segmented page's text projection at its current revision (chunks visible, title + timeline lead searchable).
 * The lead is indexed as the inline seal indexes a snapshot's timeline: after the page's withdrawal overlay, sanitized.
 */
export async function sealSegmentedPage(tx: Pick<BrainEngine, 'executeRaw'>, pageId: number, timelineLead?: string): Promise<void> {
  const [page] = await tx.executeRaw<{ slug: string; source_id: string; timeline_lead: string | null }>('SELECT slug, source_id, timeline_lead FROM pages WHERE id=$1', [pageId]);
  if (!page) return;
  const query = <T>(sql: string, params?: unknown[]) => tx.executeRaw<T>(sql, params);
  const ledger = await readPageSnapshot(query, page.slug, { sourceId: page.source_id, includeDeleted: true });
  const { timeline } = await overlayCanonicalBodies(query, '', timelineLead ?? page.timeline_lead ?? '', ledger?.withdrawals ?? [],
    { sourceId: page.source_id, marker: ledger?.globalPurges });
  await tx.executeRaw(`UPDATE pages SET text_projection_revision=knowledge_revision, chunker_version=$3,
    search_vector=${pageSearchVectorSql('title', '$2')} WHERE id=$1`, [pageId, sanitizeRemoteBody(timeline), SEGMENTED_CHUNKER_VERSION]);
}

/** The segmented branch of a page write's apply, inside the publication transaction. */
export async function applySegmentedBody(tx: BrainEngine, input: SegmentedApplyInput): Promise<SegmentedApplied> {
  const { prepared } = input;
  let pageId = input.pageId;
  await assertOriginUnclaimed(tx, { sourceId: input.sourceId, slug: input.slug, pageId, sourcePath: input.meta.source_path ?? null, revive: true });
  if (prepared.createRows) {
    // A create inserts its manifest rows before the flip checks its staging: a staging a fact purge aborted (and whose
    // claim-bearing texts it deleted) refuses here, not on the manifest's text foreign key.
    const [staging] = await tx.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id=$1::uuid FOR UPDATE', [prepared.stagingId]);
    if (!LIVE_STAGING_STATES.includes(staging?.state ?? '')) throw bodyStagingGoneError(input.slug, prepared.stagingId, staging?.state ?? null);
    pageId = (await tx.createSegmentedPageShell(input.slug, input.meta, { sourceId: input.sourceId })).id;
    await tx.stageManifestRows(prepared.createRows.map(row => ({ ...row, pageId: pageId! })));
  }
  if (pageId === null) throw new Error(`Segmented replace of ${input.slug} has no page id.`);
  const flip = await tx.flipBodyGeneration({ pageId, expectedGeneration: prepared.expectedGeneration, newGeneration: prepared.newGeneration,
    stagingId: prepared.stagingId, closeOccurrences: prepared.closeOccurrences, retireChunkOccurrences: prepared.retireChunkOccurrences,
    retireInlineChunks: input.promotion, retireMaxRows: input.retireMaxRows, body: prepared.body, meta: input.meta });
  if (!prepared.createRows) await tx.executeRaw('DELETE FROM content_chunks WHERE page_id=$1 AND body_generation=$2 AND NOT (chunk_index = ANY($3::int[]))',
    [pageId, prepared.newGeneration, prepared.stagedChunkIndexes]);
  const createChunks = prepared.createChunks?.slug === input.slug ? prepared.createChunks.chunks : null;
  if (createChunks?.length) await tx.stageSegmentChunks(pageId, prepared.newGeneration, createChunks);
  await faultPoint('segmented:flipped', { sourceId: input.sourceId });
  await tx.setBodyStagingState(prepared.stagingId, 'committed', { commitRequestId: input.requestId ?? null });
  const chunked = prepared.createRows ? createChunks !== null : prepared.unchunked === 0;
  // The flip retires only the occurrences this write closes: rows an earlier write's deferred retirement left keep the page
  // unsealed. Preparation read them (`priorStale`); while the generation it read is live no stale row is added, since a
  // projection chunks only occurrences without rows and this flip retires every occurrence the preparation chunked again.
  const complete = chunked && !flip.retireDeferred && !prepared.priorStale;
  return { pageId, complete, retireDeferred: flip.retireDeferred };
}

/**
 * Demotion: turn a segmented page row into an inline row with an empty body
 * (the caller's inline write fills it in the same transaction). The live
 * manifest rows close at the next generation, so versions that pin earlier
 * generations keep theirs; the page's segmented chunk rows are deleted here,
 * before the inline write stages its chunks. The write holds the page row FOR
 * UPDATE (lockPageKeys), so a chunk batch in flight (FOR KEY SHARE) commits
 * before this delete, and a later batch of a racing preparation refuses
 * (stageSegmentChunks: an inline page at the generation it targets).
 */
export async function demoteSegmentedPage(tx: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<void> {
  await tx.executeRaw(`UPDATE page_body_manifest SET gen_to=(SELECT body_generation+1 FROM pages WHERE id=$1)
    WHERE page_id=$1 AND gen_to IS NULL AND staging_id IS NULL`, [pageId]);
  await tx.executeRaw(`UPDATE pages SET body_storage='inline', compiled_truth='', timeline='', truth_lead=NULL, timeline_lead=NULL,
    body_bytes=NULL, truth_bytes=NULL, body_lines=NULL, segment_count=NULL, segmenter_version=NULL, body_flags=NULL,
    body_generation=body_generation+1 WHERE id=$1 AND body_storage='segmented'`, [pageId]);
  await tx.executeRaw('DELETE FROM content_chunks WHERE page_id=$1 AND occurrence_id IS NOT NULL', [pageId]);
}

/** Abort a staging whose write will not publish (best effort: expiry collects it anyway). */
export async function abortSegmentedStaging(engine: BrainEngine, prepared: PreparedSegmentedBody | null | undefined): Promise<void> {
  if (prepared) await engine.setBodyStagingState(prepared.stagingId, 'aborted').catch(() => undefined);
}

/** A string write staged as a segmented body: its apply runs in the write's transaction, its projection after commit. */
export interface SegmentedImport {
  prepared: PreparedSegmentedBody;
  /** What the staging was prepared from; a later preparation of the same write with equal inputs reuses it (`stageSegmentedImport`'s `reuse`). */
  stagedFrom: { title: string; type: string; compiled_truth: string; timeline: string; key: string };
  /** Set by apply. */
  applied: SegmentedApplied | null;
  apply(tx: BrainEngine, meta: SegmentedPageMeta, contextual: { mode: string; corpusGeneration: string | null }): Promise<SegmentedApplied>;
  /**
   * After commit: chunk and seal a page the apply left unsealed (a create over SEGMENTED_CREATE_SEAL_MAX_BYTES, a deferred
   * retirement); the projection queue retries a failure. Resolves to whether search sees the page now (undefined: not applied).
   */
  afterCommit(engine: BrainEngine): Promise<boolean | 'pending' | undefined>;
}

/**
 * Stage a parsed page (the string write paths, bodies within the
 * single-string ceiling) as a segmented body: the in-memory regions are the
 * seekable source, the existing page row (if any) is the diff base. `reuse`
 * is an earlier, unpublished staging of the same write (a managed rename
 * prepares where the page stands, then again at its new slug inside the
 * publication): when it was prepared from equal inputs against the same live
 * generation, its staged rows publish under this slug and nothing is staged again.
 */
export async function stageSegmentedImport(engine: BrainEngine, input: { slug: string; sourceId: string; existing: Page | null;
  page: { title: string; type: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown>; tags: readonly string[] };
  policy: PageBodyPolicy; owner?: SegmentedStagingOwner; chunking: SegmentChunkingContext; baseRevision: string | null; reuse?: SegmentedImport }): Promise<SegmentedImport> {
  const live = input.existing ? await segmentedLivePage(engine, Number(input.existing.id)) : null;
  const { title, type, compiled_truth, timeline } = input.page;
  const stagedFrom = { title, type, compiled_truth, timeline, key: stableJson({ sourceId: input.sourceId, page: live && { id: live.id, generation: live.generation,
    storage: live.storage, flags: live.flags }, frontmatter: input.page.frontmatter, tags: input.page.tags, chunking: input.chunking }) };
  const prior = input.reuse?.stagedFrom;
  const reused = !!prior && prior.key === stagedFrom.key && prior.title === title && prior.type === type && prior.compiled_truth === compiled_truth && prior.timeline === timeline;
  let owner = input.owner;
  if (!owner) {
    const { principal } = await maintenanceAttribution(engine);
    owner = { kind: 'import', principalKind: principal.kind, principalId: principal.id, baseRevision: input.baseRevision };
  }
  const prepared = reused ? input.reuse!.prepared : await prepareSegmentedBody(engine, { sourceId: input.sourceId, slug: input.slug, live, title, type,
    frontmatter: input.page.frontmatter, tags: input.page.tags, truth: stringRegion(compiled_truth), timeline: stringRegion(timeline),
    hasTimeline: timeline.length > 0, flags: stringBodyFlags(compiled_truth, timeline),
    declaredBytes: Buffer.byteLength(compiled_truth, 'utf-8') + Buffer.byteLength(timeline, 'utf-8'), owner, chunking: input.chunking });
  const staged: SegmentedImport = { prepared, stagedFrom, applied: null,
    apply: async (tx, meta, contextual) => {
      staged.applied = await applySegmentedBody(tx, { slug: input.slug, sourceId: input.sourceId, pageId: live?.id ?? null, prepared, meta,
        promotion: live?.storage === 'inline', retireMaxRows: input.policy.flipRetireMaxRows });
      await tx.updatePageContextualRetrievalState(input.slug, input.sourceId, contextual.mode, contextual.corpusGeneration);
      return staged.applied;
    },
    afterCommit: async target => {
      if (!staged.applied) return undefined;
      if (!staged.applied.complete) await buildSegmentedProjection(target, { sourceId: input.sourceId, slug: input.slug }).catch(() => undefined);
      const pageId = staged.applied.pageId;
      await segmentWriteScope(target, input.sourceId).then(writes => writes(exec => exec.sweepSegments({ pageId }))).catch(() => undefined);
      return input.chunking.quarantined ? false : segmentedPageSearchable(target, input.sourceId, input.slug);
    } };
  return staged;
}
