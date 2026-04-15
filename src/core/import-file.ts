import { readFileSync, statSync, lstatSync } from 'fs';
import type { BrainEngine } from './engine.ts';
import { buildFrontmatterSearchText, parseMarkdown } from './markdown.ts';
import { chunkText } from './chunkers/recursive.ts';
import { estimateTokenCount } from './embedding.ts';
import { slugifyPath } from './sync.ts';
import type { ChunkInput } from './types.ts';
import { importContentHash, validateSlug } from './utils.ts';

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
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_FILE_SIZE) {
    return {
      slug,
      status: 'skipped',
      chunks: 0,
      error: `Content too large (${byteLength} bytes, max ${MAX_FILE_SIZE}).`,
    };
  }

  const parsed = parseMarkdown(content, slug + '.md');

  const hash = importContentHash(parsed);

  const existing = await engine.getPage(slug);
  if (existing?.content_hash === hash) {
    return { slug, status: 'skipped', chunks: 0 };
  }

  const chunks = buildPageChunks(parsed.compiled_truth, parsed.timeline, parsed.frontmatter);

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
  _options?: { noEmbed?: boolean },
): Promise<ImportResult> {
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `Skipping symlink: ${filePath}` };
  }

  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `File too large (${stat.size} bytes)` };
  }

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseMarkdown(content, relativePath);
  const expectedSlug = slugifyPath(relativePath);
  let canonicalParsedSlug: string;
  try {
    canonicalParsedSlug = slugifyPath(validateSlug(parsed.slug));
  } catch {
    canonicalParsedSlug = parsed.slug;
  }

  if (canonicalParsedSlug !== expectedSlug) {
    return {
      slug: expectedSlug,
      status: 'skipped',
      chunks: 0,
      error:
        `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expectedSlug}" ` +
        `(from ${relativePath}). Remove the frontmatter "slug:" line or move the file.`,
    };
  }

  return importFromContent(engine, expectedSlug, content);
}

// Backward compat
export const importFile = importFromFile;
export type ImportFileResult = ImportResult;

export function buildPageChunks(
  compiledTruth: string,
  timeline: string,
  frontmatter?: Record<string, unknown>,
): ChunkInput[] {
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

  const searchText = frontmatter ? buildFrontmatterSearchText(frontmatter) : '';
  if (searchText) {
    for (const chunk of chunkText(searchText)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunk.text,
        chunk_source: 'frontmatter',
        token_count: estimateTokenCount(chunk.text),
      });
    }
  }

  return chunks;
}
