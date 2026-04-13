import { readFileSync, statSync, lstatSync } from 'fs';
import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { chunkText } from './chunkers/recursive.ts';
import { embedBatch } from './embedding.ts';
import { isSyncable, slugifyPath } from './sync.ts';
import { desiredLinksForFile, OBSIDIAN_EMBED_TYPE, OBSIDIAN_LINK_TYPE, type VaultIndex } from './obsidian-links.ts';
import type { ChunkInput } from './types.ts';

export interface ImportResult {
  slug: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  error?: string;
  linksAdded?: number;
  linksUpdated?: number;
  linksRemoved?: number;
}

const MAX_FILE_SIZE = 5_000_000; // 5MB

interface ImportOpts {
  noEmbed?: boolean;
  obsidian?: {
    relativePath: string;
    index: VaultIndex;
  };
}

/**
 * Import content from a string. Core pipeline:
 * parse -> hash -> embed (external) -> transaction(version + putPage + tags + chunks)
 *
 * Used by put_page operation and importFromFile.
 *
 * Size guard: content is rejected if its UTF-8 byte length exceeds MAX_FILE_SIZE.
 * importFromFile already enforces this against disk size before calling here, but
 * the remote MCP put_page operation passes caller-supplied content straight in,
 * so the guard has to live on this function — otherwise an authenticated caller
 * can spend the owner's OpenAI budget at will by shipping a megabyte-sized page.
 */
export async function importFromContent(
  engine: BrainEngine,
  slug: string,
  content: string,
  opts: ImportOpts = {},
): Promise<ImportResult> {
  // Reject oversized payloads before any parsing, chunking, or embedding happens.
  // Uses Buffer.byteLength to count UTF-8 bytes the same way disk size would,
  // so the network path behaves identically to the file path.
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_FILE_SIZE) {
    return {
      slug,
      status: 'skipped',
      chunks: 0,
      error: `Content too large (${byteLength} bytes, max ${MAX_FILE_SIZE}). Split the content into smaller files or remove large embedded assets.`,
    };
  }

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

  // Chunk compiled_truth and timeline
  const chunks: ChunkInput[] = [];
  if (parsed.compiled_truth.trim()) {
    for (const c of chunkText(parsed.compiled_truth)) {
      chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
    }
  }
  if (parsed.timeline?.trim()) {
    for (const c of chunkText(parsed.timeline)) {
      chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'timeline' });
    }
  }

  // Embed BEFORE the transaction (external API call)
  if (!opts.noEmbed && chunks.length > 0) {
    try {
      const embeddings = await embedBatch(chunks.map(c => c.chunk_text));
      for (let i = 0; i < chunks.length; i++) {
        chunks[i].embedding = embeddings[i];
        chunks[i].token_count = Math.ceil(chunks[i].chunk_text.length / 4);
      }
    } catch (e: unknown) {
      console.warn(`[gbrain] embedding failed for ${slug} (${chunks.length} chunks): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let linksAdded = 0;
  let linksUpdated = 0;
  let linksRemoved = 0;
  const obsidianDesired = opts.obsidian && isSyncable(opts.obsidian.relativePath)
    ? desiredLinksForFile(opts.obsidian.relativePath, content, opts.obsidian.index)
    : null;

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

    if (obsidianDesired) {
      for (const linkType of [OBSIDIAN_LINK_TYPE, OBSIDIAN_EMBED_TYPE]) {
        const result = await tx.reconcileLinksForPage(slug, linkType, obsidianDesired.linksByType.get(linkType) || []);
        linksAdded += result.added;
        linksUpdated += result.updated;
        linksRemoved += result.removed;
      }
    }

    if (chunks.length > 0) {
      await tx.upsertChunks(slug, chunks);
    } else {
      // Content is empty — delete stale chunks so they don't ghost in search results
      await tx.deleteChunks(slug);
    }
  });

  return { slug, status: 'imported', chunks: chunks.length, linksAdded, linksUpdated, linksRemoved };
}

/**
 * Import from a file path. Validates size, reads content, delegates to importFromContent.
 *
 * Slug authority: the path on disk is the source of truth. `frontmatter.slug`
 * is only accepted when it matches `slugifyPath(relativePath)`. A mismatch is
 * rejected rather than silently honored — otherwise a file at `notes/random.md`
 * could declare `slug: people/elon` in frontmatter and overwrite the legitimate
 * `people/elon` page on the next `gbrain sync` or `gbrain import`. In shared
 * brains where PRs are mergeable, this is a silent page-hijack primitive.
 */
export async function importFromFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: ImportOpts = {},
): Promise<ImportResult> {
  // Defense-in-depth: reject symlinks before reading content.
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

  // Enforce path-authoritative slug. parseMarkdown prefers frontmatter.slug over
  // the path-derived slug, so a mismatch here means the frontmatter is trying
  // to rewrite a page whose filesystem location says something different.
  const expectedSlug = slugifyPath(relativePath);
  if (parsed.slug !== expectedSlug) {
    return {
      slug: expectedSlug,
      status: 'skipped',
      chunks: 0,
      error:
        `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expectedSlug}" ` +
        `(from ${relativePath}). Remove the frontmatter "slug:" line or move the file.`,
    };
  }

  // Pass the path-derived slug explicitly so that any future change to
  // parseMarkdown's precedence rules cannot re-introduce this bug.
  return importFromContent(engine, expectedSlug, content, {
    ...opts,
    obsidian: opts.obsidian ? { ...opts.obsidian, relativePath } : undefined,
  });
}

// Backward compat
export const importFile = importFromFile;
export type ImportFileResult = ImportResult;
