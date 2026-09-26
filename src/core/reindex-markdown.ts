import type { BrainEngine } from './engine.ts';
import type { ChunkInput } from './types.ts';
import { MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';
import { prepareMarkdownChunks } from './markdown-chunks.ts';
import { resolveMaxChunkTokens } from './embedding-input-limit.ts';

interface StoredMarkdown {
  id: number;
  compiled_truth: string;
  timeline: string | null;
  frontmatter: Record<string, unknown>;
}

/**
 * Rebuild derived chunks from the canonical stored body, without a Markdown
 * serialization/parser round trip. Reindexing must not reinterpret legacy
 * frontmatter, change page dates, or invalidate extraction provenance hashes.
 * The CLI's --no-embed path uses this; embedding remains a separate stale pass.
 */
export async function reindexStoredMarkdownChunks(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<boolean> {
  const query = `SELECT id, compiled_truth, timeline, frontmatter FROM pages
    WHERE source_id = $1 AND slug = $2 AND page_kind = 'markdown' AND deleted_at IS NULL`;
  const page = await engine.getPage(slug, { sourceId });
  if (!page) return false;

  const chunks: ChunkInput[] = await prepareMarkdownChunks(page, resolveMaxChunkTokens());

  await engine.transaction(async tx => {
    const [current] = await tx.executeRaw<StoredMarkdown>(query + ' FOR UPDATE', [sourceId, slug]);
    if (!current || current.id !== page.id ||
        current.compiled_truth !== page.compiled_truth || (current.timeline ?? '') !== (page.timeline ?? '') ||
        JSON.stringify(current.frontmatter ?? {}) !== JSON.stringify(page.frontmatter ?? {})) {
      throw new Error('Page changed during chunk rebuild; retry reindex');
    }
    const scope = { sourceId };
    await tx.deleteChunks(slug, scope);
    if (chunks.length) await tx.upsertChunks(slug, chunks, scope);
    // This is the same completion seal as the importer: certify ONLY after
    // every derived row was replaced by the corrected upstream chunkers, in
    // the same transaction. Failure rolls back both replacement and seal.
    await tx.executeRaw(
      'UPDATE pages SET chunker_version = $1 WHERE source_id = $2 AND slug = $3',
      [MARKDOWN_CHUNKER_VERSION, sourceId, slug],
    );
  });
  return true;
}
