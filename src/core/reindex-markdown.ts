import type { BrainEngine } from './engine.ts';
import type { ChunkInput } from './types.ts';
import { chunkText, MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';
import { extractFencedChunks } from './import-file.ts';
import { resolveMaxChunkTokens } from './embedding-input-limit.ts';
import { isEmbedSkipped } from './embed-skip.ts';
import { isQuarantined } from './quarantine.ts';

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

  const chunks: ChunkInput[] = [];
  if (!isEmbedSkipped(page.frontmatter) && !isQuarantined(page.frontmatter)) {
    const chunkOpts = { maxTokens: resolveMaxChunkTokens() };
    for (const [body, source] of [
      [page.compiled_truth, 'compiled_truth'],
      [page.timeline ?? '', 'timeline'],
    ] as const) {
      // The upstream chunker sanitizes the full protected-fence body BEFORE
      // splitting. Never sanitize fragments or inherit an old chunk/vector.
      for (const chunk of chunkText(body, chunkOpts)) {
        chunks.push({ chunk_index: chunks.length, chunk_text: chunk.text, chunk_source: source });
      }
    }
    chunks.push(...await extractFencedChunks(page.compiled_truth, chunks.length));
  }

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
