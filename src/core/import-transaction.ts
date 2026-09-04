import type { BrainEngine, FileSpec } from './engine.ts';
import type { ChunkInput, PageInput } from './types.ts';
import { setPageImageHead } from './page-image-storage.ts';

/** Shared atomic page/chunk/file write used by Markdown and image imports. */
export interface ImportTransactionSpec {
  slug: string;
  hadExisting: boolean;
  sourceId?: string;
  page: PageInput;
  /** When undefined, no chunk write happens. When empty, prior chunks are deleted. */
  chunks?: ChunkInput[];
  file?: FileSpec;
  /** Remove a stale native-image head when an imported image is not MCP-readable. */
  removeImageHeadFilename?: string;
  /** Only authoritative-file imports may intentionally replace a body with empty content. */
  allowEmptyOverwrite?: boolean;
  after?: (tx: BrainEngine) => Promise<void>;
}

export async function withImportTransaction(
  engine: BrainEngine,
  spec: ImportTransactionSpec,
): Promise<void> {
  const sourceId = spec.sourceId ?? 'default';
  const txOpts = spec.sourceId ? { sourceId: spec.sourceId } : undefined;
  await engine.transaction(async tx => {
    if (spec.hadExisting) await tx.createVersion(spec.slug, txOpts);
    await tx.putPage(
      spec.slug,
      spec.page,
      spec.allowEmptyOverwrite === true ? { ...txOpts, allowEmptyOverwrite: true } : txOpts,
    );
    if (spec.file) {
      const stored = await tx.getPage(spec.slug, txOpts);
      const file = await tx.upsertFile({
        ...spec.file,
        source_id: sourceId,
        page_slug: spec.slug,
        page_id: stored?.id ?? null,
      });
      if (stored && spec.file.metadata?.kind === 'page_image') {
        await setPageImageHead(tx, stored.id, sourceId, spec.file.filename, file.id);
      }
    } else if (spec.removeImageHeadFilename) {
      const stored = await tx.getPage(spec.slug, txOpts);
      if (stored) {
        await tx.executeRaw(
          `DELETE FROM page_image_heads WHERE page_id = $1 AND source_id = $2 AND filename = $3`,
          [stored.id, sourceId, spec.removeImageHeadFilename],
        );
      }
    }
    if (spec.chunks !== undefined) {
      if (spec.chunks.length > 0) await tx.upsertChunks(spec.slug, spec.chunks, txOpts);
      else await tx.deleteChunks(spec.slug, txOpts);
    }
    if (spec.after) await spec.after(tx);
  });
}

/** Repair file/head metadata on an unchanged Git image without re-embedding. */
export async function reconcileImportedPageImage(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  file: FileSpec,
): Promise<void> {
  await engine.transaction(async tx => {
    const page = await tx.getPage(slug, { sourceId });
    if (!page) throw new Error(`cannot reconcile image metadata for missing page: ${slug}`);
    const stored = await tx.upsertFile({
      ...file,
      source_id: sourceId,
      page_slug: slug,
      page_id: page.id,
    });
    await setPageImageHead(tx, page.id, sourceId, file.filename, stored.id);
  });
}

export async function clearImportedPageImageHead(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  filename: string,
): Promise<void> {
  await engine.executeRaw(
    `DELETE FROM page_image_heads h
     USING pages p
     WHERE h.page_id = p.id AND p.slug = $1 AND p.source_id = $2
       AND h.source_id = $2 AND h.filename = $3`,
    [slug, sourceId, filename],
  );
}
