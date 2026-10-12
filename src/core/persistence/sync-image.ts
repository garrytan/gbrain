/**
 * #6529: managed sync's image branch. With `GBRAIN_EMBEDDING_MULTIMODAL=true`
 * (`isMultimodalEnabled`, the predicate `embed --stale --images` and the import walker use), a frozen
 * image entry is imported through the coordinated image importer
 * (`importImageFile` with `prepare`, as `gbrain import` does in
 * import-prepare.ts) instead of being held as `managed_image_sync_unsupported`.
 * The frozen content is the image's bytes as base64 (never a UTF-8 decode);
 * `rawHash` stays the sha256 of the file bytes, so the publication's
 * working-tree check (`syncRawHash`) and the hash no-op work unchanged. OCR
 * and the multimodal vector are provider work the owner does at preparation,
 * inside the sync preparation budget; `--no-embed` skips both. The page's
 * `source_path` is recorded on every publication, a hash no-op included.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { importImageFile } from '../import-file.ts';
import type { OperationError } from '../ops/contract.ts';
import type { RegistryCode } from '../error-registry.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { ownerImportTrust } from '../trust/channel.ts';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { sha256 } from './digest.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import type { PreparedContentImport } from './prepared-import.ts';

/** The frozen intent fields of an image entry: the bytes as base64 and their hash (`rawHash` and `content` agree on a committed, clean file). */
export function frozenImageIntent(bytes: Buffer): { content: string; contentHash: string } {
  return { content: bytes.toString('base64'), contentHash: sha256(bytes) };
}

/** An image's "same content" is its byte hash: the preparer's no-op verdict would cost provider work. */
export function sameImageBytes(bytes: Buffer | null, page: { content_hash?: string | null } | undefined): boolean {
  return !!bytes && page?.content_hash === sha256(bytes);
}

export interface ManagedSyncImageContext {
  root: string;
  snapshot: PageSnapshot | null;
  /** A Git rename: the page at this slug (the old path's) is retired when the image publishes at the new slug. */
  renamedFrom?: { slug: string };
  noEmbed: boolean;
  companyApproval: boolean;
  /** The sync-wide validation (cursor, authority, file hash, origin); runs with the import's own under the apply transaction. */
  validate: (tx: BrainEngine) => Promise<void>;
  /** Clears the path's hold (if any) when the import commits. */
  releaseHold: (tx: BrainEngine) => Promise<void>;
  /** The caller's publication refusal, so the image branch names requests, retries and codes the way the text branch does. */
  refuse: (code: RegistryCode, message: string, cause: string) => OperationError;
  clock?: ClaimPhaseClock;
  /** A no-op screen without admission (`sameContentAtOrigin`, the waiver): never provider work. */
  screening?: boolean;
}

/**
 * Prepares one frozen image import: the coordinated importer decides a hash
 * no-op (the same bytes, a complete index) before any provider call, OCRs and
 * embeds otherwise, and hands back the guarded apply. The text embedding of
 * the image's caption chunk is deferred to `embed --stale`, as `gbrain import`
 * defers it. A renamed image publishes as a new page at the new slug and
 * soft-deletes the old one (its single chunk and file row are rebuilt from the
 * same bytes; an image page has no history worth carrying across the move).
 */
export async function prepareManagedSyncImage(engine: BrainEngine, row: WriteRequest, p: { content: string; sourcePath: string; path: string; rawHash: string | null; lineEndingOnly?: boolean },
  ctx: ManagedSyncImageContext): Promise<PreparedMutation> {
  const { snapshot, refuse } = ctx;
  if (ctx.companyApproval) throw refuse('profile_incompatible', 'Company source approval permits only committed Markdown content.',
    `A company-brain source imports only committed Markdown, and ${row.slug} is an image; remove it from the approved revision.`);
  if (ctx.screening) throw refuse('invalid_params', 'An image import is prepared only under its admitted request.',
    `${row.slug} is an image: its preparation does provider work, so it is never screened without admission.`);
  const bytes = Buffer.from(p.content, 'base64');
  const contentHash = sha256(bytes);
  if (snapshot && !p.lineEndingOnly && p.rawHash !== contentHash && snapshot.page.content_hash !== p.rawHash) {
    throw refuse('source_changed', 'Newer image bytes disagree with the pinned import.',
      `The working tree holds newer bytes for ${row.slug} than the pinned import; sync did not overwrite them. Preserve the local edit and commit it.`);
  }
  const filePath = join(ctx.root, p.path);
  if (!existsSync(filePath)) throw refuse('source_changed', 'The imported image left the working tree.',
    `${p.path} is no longer in the working tree of ${row.source_id}, so nothing was imported from it; commit the removal or restore the file, then sync again.`);
  let prepared: Omit<PreparedContentImport, 'parsedPage'> | undefined;
  enterClaimStep(ctx.clock, 'image_import', undefined, 'db');
  const result = await importImageFile(engine, filePath, p.sourcePath, { sourceId: row.source_id, noEmbed: ctx.noEmbed, bytes,
    prepare: async value => { prepared = value; return value.result; } });
  if (!prepared || prepared.slug !== row.slug) throw refuse('invalid_params', result.error ?? 'The image could not be prepared.',
    `${p.sourcePath} could not be prepared as page ${row.slug}${result.error ? ` (${result.error})` : ''}; fix the file, then sync again.`);
  const ready = prepared;
  if (ready.observedRevision !== (snapshot?.revision ?? null)) throw refuse('revision_conflict', 'The image page changed during preparation.',
    `Page ${row.slug} changed while this sync was being prepared.`);
  const mutation: PreparedMutation = { observedRevision: ready.observedRevision, trust: await ownerImportTrust(engine, row, null, p.sourcePath),
    validate: async tx => { await ctx.validate(tx); await ready.validate(tx); },
    noop: ready.noop && !ctx.renamedFrom, contentUnchanged: ready.noop && !ctx.renamedFrom, deferEmbedding: true, apply: async tx => {
      if (ctx.renamedFrom) { await tx.createVersion(ctx.renamedFrom.slug, { sourceId: row.source_id }); await tx.softDeletePage(ctx.renamedFrom.slug, { sourceId: row.source_id }); }
      await ready.apply(tx);
      await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND source_path IS DISTINCT FROM $3', [row.source_id, row.slug, p.sourcePath]);
      await ctx.releaseHold(tx);
      mutation.postimage = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      return { status: ctx.renamedFrom ? 'renamed' : ready.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
        chunks: ready.result.chunks, noop: ready.noop && !ctx.renamedFrom, imported_file: true, ...(ctx.renamedFrom ? { renamed_from: ctx.renamedFrom.slug } : {}) };
    } };
  return mutation;
}
