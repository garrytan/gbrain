import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { chunkText } from './chunkers/recursive.ts';
import { estimateTokenCount } from './embedding.ts';
import type { ChunkInput } from './types.ts';

export interface ImportResult {
  slug: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  error?: string;
}

const MAX_FILE_SIZE = 5_000_000; // 5MB

/**
 * Import content from a string. Core pipeline:
 * parse -> hash -> transaction(version + putPage + tags + chunks)
 *
 * Used by put_page operation and importFromFile.
 */
export async function importFromContent(
  engine: BrainEngine,
  slug: string,
  content: string,
): Promise<ImportResult> {
  const parsed = parseMarkdown(content, slug + '.md');

  // Hash includes ALL fields for idempotency (not just compiled_truth + timeline)
  const hash = createHash('sha256')
    .update(JSON.stringify({
      title: parsed.title,
      type: parsed.type,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags.sort(),
    }))
    .digest('hex');

  const existing = await engine.getPage(slug);
  if (existing?.content_hash === hash) {
    return { slug, status: 'skipped', chunks: 0 };
  }

  const chunks = buildPageChunks(parsed.compiled_truth, parsed.timeline);

  // Transaction wraps all DB writes
  await engine.transaction(async (tx) => {
    if (existing) await tx.createVersion(slug);

    await tx.putPage(slug, {
      type: parsed.type,
      title: parsed.title,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline || '',
      frontmatter: parsed.frontmatter,
      content_hash: hash,
    });

    // Tag reconciliation: remove stale, add current
    const existingTags = await tx.getTags(slug);
    const newTags = new Set(parsed.tags);
    for (const old of existingTags) {
      if (!newTags.has(old)) await tx.removeTag(slug, old);
    }
    for (const tag of parsed.tags) {
      await tx.addTag(slug, tag);
    }

    await tx.deleteChunks(slug);
    await tx.upsertChunks(slug, chunks);
  });

  return { slug, status: 'imported', chunks: chunks.length };
}

/**
 * Import from a file path. Validates size, reads content, delegates to importFromContent.
 */
export async function importFromFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
): Promise<ImportResult> {
  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `File too large (${stat.size} bytes)` };
  }

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseMarkdown(content, relativePath);
  return importFromContent(engine, parsed.slug, content);
}

// Backward compat
export const importFile = importFromFile;
export type ImportFileResult = ImportResult;

export function buildPageChunks(compiledTruth: string, timeline: string): ChunkInput[] {
  const chunks: ChunkInput[] = [];

  if (compiledTruth.trim()) {
    for (const chunk of chunkText(compiledTruth)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunk.text,
        chunk_source: 'compiled_truth',
        token_count: estimateTokenCount(chunk.text),
      });
    }
  }

  if (timeline.trim()) {
    for (const chunk of chunkText(timeline)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunk.text,
        chunk_source: 'timeline',
        token_count: estimateTokenCount(chunk.text),
      });
    }
  }

  return chunks;
}
