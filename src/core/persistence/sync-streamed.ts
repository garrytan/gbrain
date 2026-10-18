/**
 * Wave B: managed sync of a Markdown file over the single-string ceiling
 * (spec 3.1, 3.2). With `pages.segmented_storage` on, `freezeEntry`
 * (`sync-run.ts`) freezes such a file by reference (`body_ref`: its sha256,
 * size and Git blob id, hashed as a stream; no content in the journal) instead
 * of holding it by its size. A committed entry streams only when the working
 * tree holds exactly its pinned blob; otherwise it is held as before. The
 * owner's preparation streams the file through the segmented import
 * (`importStreamedMarkdownFile`), which verifies the sha256 on its first pass,
 * and the publication is database-only (the canonical file is never
 * rewritten). A file the streamed path refuses fails its request with the
 * refusal's code, and the run holds it (`holdFailedFenceRequest`). A rename
 * moves the page in the publication and applies the preparation made at the
 * new path. The import targets the admitted page (`row.slug`, the page that
 * records the file as its origin, as the inline import does), and the
 * publication records the origin through `bindOrigin`; several live pages
 * recording the file are held `origin_conflict` by discovery (#6948).
 */
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import type { RegistryCode } from '../error-registry.ts';
import type { ContentRefusal } from '../import-screen.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { sizeStateField } from '../page-embedding-budget.ts';
import { readPageBodyPolicy } from '../page-body/limits.ts';
import { importStreamedMarkdownFile, type StreamedPreparedImport } from '../page-body/streamed-import.ts';
import { ownerImportTrust } from '../trust/channel.ts';
import { pipelined } from '../page-state/transactions.ts';
import { sealSegmentedPage } from './segmented-apply.ts';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { syncFilePath, type SyncRename } from './sync-discovery.ts';
import { SYNC_READ_BOUND, type TreeBlob } from './sync-blobs.ts';
import { recordSyncImportProvenance, type SyncImportProvenanceBase } from './sync-holds.ts';
import type { WriteRequest } from './model.ts';
import type { SyncIntent, SyncPreparedMutation } from './sync-prepare.ts';
import { bindOrigin } from './origin-guard.ts';

/** A frozen Markdown file over the single-string ceiling: the bytes the owner streams and verifies. */
export interface SyncBodyRef { kind: 'git_blob' | 'input_file'; sha256: string; bytes: number; blob_oid: string }

/**
 * The reference a Markdown import over the sync read bound is frozen by, or
 * null when it is held by its size as before: the switch is off, the file is
 * over `pages.max_bytes`, or (a committed entry) the working tree does not hold
 * the pinned blob. `target` is the pinned commit id (its length names the
 * object format).
 */
export async function streamedSyncBodyRef(engine: BrainEngine, input: { root: string; path: string; target: string; working: boolean; blob: () => TreeBlob | null }): Promise<SyncBodyRef | null> {
  if (!/\.mdx?$/i.test(input.path)) return null;
  const policy = await readPageBodyPolicy(engine);
  if (!policy.segmented) return null;
  let absolute: string | null;
  try { absolute = syncFilePath(input.root, input.path, policy.maxBytes); }
  catch (error) { if (error instanceof OperationError && error.code === 'request_too_large') return null; throw error; }
  if (absolute === null) return null;
  const bytes = (await lstat(absolute)).size;
  const blob = input.working ? null : input.blob();
  if (bytes <= SYNC_READ_BOUND || (!input.working && blob?.size !== bytes)) return null;
  const sha256 = createHash('sha256'), oid = createHash(input.target.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes}\0`);
  let read = 0;
  for await (const part of createReadStream(absolute) as AsyncIterable<Buffer>) { sha256.update(part); oid.update(part); read += part.length; }
  const ref: SyncBodyRef = { kind: input.working ? 'input_file' : 'git_blob', sha256: sha256.digest('hex'), bytes, blob_oid: oid.digest('hex') };
  return read === bytes && (input.working || ref.blob_oid === blob?.oid) ? ref : null;
}

export interface StreamedSyncContext {
  root: string;
  /** The page at the admitted slug, and the page the import is prepared against (the rename source for a rename). */
  snapshot: PageSnapshot | null; base: PageSnapshot | null;
  renamed?: SyncRename;
  activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> };
  importProvenance: SyncImportProvenanceBase;
  validate: (tx: BrainEngine) => Promise<void>;
  releaseHold: (tx: BrainEngine) => Promise<void>;
  refuse: (code: RegistryCode, message: string, cause: string) => OperationError;
  contentRefusal: (refusal: ContentRefusal) => OperationError;
  clock?: ClaimPhaseClock;
  screening?: boolean;
}

const CHANGED = 'The imported file changed after sync admission.';

export async function prepareManagedSyncStreamed(engine: BrainEngine, row: WriteRequest, p: SyncIntent & { body_ref: SyncBodyRef; sourcePath: string; path: string },
  ctx: StreamedSyncContext): Promise<SyncPreparedMutation> {
  const { refuse, snapshot, base, renamed } = ctx;
  const ref = p.body_ref;
  const changed = () => refuse('source_changed', CHANGED, `The file of ${row.slug} changed on disk after this sync was admitted; review the change and commit it.`);
  // A screen without admission (an origin occupant, a waiver) never streams a page this size.
  if (ctx.screening) throw refuse('invalid_params', 'A streamed import is prepared only under its admitted request.',
    `${p.sourcePath} is over the single-string ceiling, so it is prepared only under its admitted request.`);
  const policy = await readPageBodyPolicy(engine);
  if (!policy.segmented || ref.bytes > policy.maxBytes) throw ctx.contentRefusal({ code: 'file_too_large',
    message: `File too large (${ref.bytes} bytes): segmented page storage (pages.segmented_storage) is off or the file is over pages.max_bytes (${policy.maxBytes}).` });
  const filePath = syncFilePath(ctx.root, p.path, policy.maxBytes);
  const stat = filePath === null ? null : await lstat(filePath);
  if (!filePath || !stat || stat.size !== ref.bytes) throw changed();
  let ready: StreamedPreparedImport | undefined;
  enterClaimStep(ctx.clock, 'import_content', undefined, 'fs');
  const result = await importStreamedMarkdownFile(engine, filePath, p.sourcePath, { sourceId: row.source_id, noEmbed: true, ...(ctx.activePack ? { activePack: ctx.activePack } : {}),
    coordinated: { snapshot: base, sha256: ref.sha256, slug: row.slug, moved: !!renamed, prepare: async value => { ready = value; return value.result; },
      owner: { kind: 'sync', principalKind: row.principal_kind, principalId: row.principal_id, baseRevision: base?.revision ?? null } } }, stat, policy)
    .catch(error => { throw error instanceof OperationError && error.code === 'source_changed' ? changed() : error; });
  if (!ready) throw result.refusal ? ctx.contentRefusal(result.refusal) : refuse('invalid_params', result.error ?? 'The sync file could not be prepared.',
    `The file could not be prepared as page ${row.slug}.`);
  const prepared: StreamedPreparedImport = ready;
  if (prepared.observedRevision !== (base?.revision ?? null)) throw refuse('revision_conflict', 'The page changed during sync preparation.',
    `Page ${renamed?.slug ?? row.slug} changed while this sync was being prepared.`);
  const source = { sourceId: row.source_id };
  const mutation: SyncPreparedMutation = { observedRevision: snapshot?.revision ?? null, importProvenance: ctx.importProvenance,
    trust: await ownerImportTrust(engine, row, prepared.frontmatter, p.sourcePath),
    contentUnchanged: prepared.noop && !renamed,
    ...(renamed ? { additionalPageKeys: [{ sourceId: row.source_id, slug: renamed.slug }] } : {}),
    validate: async tx => {
      await ctx.validate(tx);
      await prepared.validate(tx).catch(error => { throw error instanceof OperationError && error.code === 'source_changed' ? changed() : error; });
    },
    deferEmbedding: p.processingOptions?.noEmbed || p.embedDeferred === true,
    ...(prepared.afterCommit ? { afterCommit: prepared.afterCommit } : {}),
    apply: async tx => {
      // The page moves first, keeping its id, links and history; the import prepared at the new path then applies to it.
      if (renamed && await tx.updateSlug(renamed.slug, row.slug, source) !== 1) throw refuse('page_identity_changed', 'The renamed page could not move to its new slug.',
        `Page ${renamed.slug} could not move to ${row.slug}.`);
      await prepared.apply(tx);
      // An unchanged body keeps its chunks (the no-op required a sealed page), so the move's new revision is sealed here.
      if (renamed && prepared.noop) await sealSegmentedPage(tx, renamed.pageId);
      await bindOrigin(tx, { sourceId: row.source_id, slug: row.slug, sourcePath: p.sourcePath });
      await tx.executeRaw("UPDATE pages SET database_only_reason=NULL WHERE source_id=$1 AND slug=$2 AND database_only_reason='unbound_source'", [row.source_id, row.slug]);
      const final = await tx.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
      await pipelined(tx, [
        () => ctx.releaseHold(tx),
        async () => { if (final) await recordSyncImportProvenance(tx, { ...ctx.importProvenance, page_id: Number(final.page.id), revision: final.revision,
          disk_sha256: ref.sha256, disk_blob_oid: ref.blob_oid }); },
      ]);
      mutation.postimage = final;
      const live = final && final.page.deleted_at == null ? final.page : null;
      return { status: renamed ? 'renamed' : prepared.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
        chunks: prepared.result.chunks, noop: prepared.noop && !renamed, imported_file: true, ...(renamed ? { renamed_from: renamed.slug } : {}),
        ...(prepared.noop ? {} : await sizeStateField(tx, row.source_id, row.slug, live)) };
    } };
  return mutation;
}
