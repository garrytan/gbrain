import { readFileSync, statSync, lstatSync } from 'fs';
import type { BrainEngine } from './engine.ts';
import { buildFrontmatterSearchText, parseMarkdown } from './markdown.ts';
import { chunkText } from './chunkers/recursive.ts';
import { estimateTokenCount } from './embedding.ts';
import { buildNoteManifestEntry, DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './services/note-manifest-service.ts';
import { buildNoteSectionEntries } from './services/note-section-service.ts';
import { pathToSlug, slugifyPath } from './sync.ts';
import type { ChunkInput, Page } from './types.ts';
import { importContentHash, validateSlug } from './utils.ts';

export interface ImportResult {
  slug: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  error?: string;
  deferred_derived?: boolean;
  content_hash?: string;
}

export const MAX_MARKDOWN_IMPORT_BYTES = 5_000_000; // 5MB

export interface ImportFromContentOptions {
  path?: string;
  deferDerived?: boolean;
}

export interface RefreshDerivedStorageOptions {
  path?: string;
  expectedContentHash?: string | null;
}

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
  options?: ImportFromContentOptions,
): Promise<ImportResult> {
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_MARKDOWN_IMPORT_BYTES) {
    return {
      slug,
      status: 'skipped',
      chunks: 0,
      error: `Content too large (${byteLength} bytes, max ${MAX_MARKDOWN_IMPORT_BYTES}).`,
    };
  }

  const parsed = parseMarkdown(content, slug + '.md');

  const hash = importContentHash(parsed);

  const manifestPath = options?.path ?? `${validateSlug(slug)}.md`;
  const deferDerived = options?.deferDerived === true;
  const existing = await engine.getPage(slug);
  if (existing?.content_hash === hash) {
    const existingManifest = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug);
    if (existingManifest?.path === manifestPath || !canRefreshDerivedStorage(existing)) {
      return { slug, status: 'skipped', chunks: 0, content_hash: hash };
    }

    if (deferDerived) {
      return {
        slug,
        status: 'skipped',
        chunks: 0,
        deferred_derived: true,
        content_hash: hash,
      };
    }

    await engine.transaction(async (tx) => {
      const tags = await tx.getTags(slug);
      await replacePageDerivedStorage(tx, existing, tags, manifestPath);
    });
    return { slug, status: 'skipped', chunks: 0, content_hash: hash };
  }

  const chunks = deferDerived
    ? []
    : buildPageChunks(parsed.compiled_truth, parsed.timeline, parsed.frontmatter);

  // Transaction wraps all DB writes
  await engine.transaction(async (tx) => {
    if (existing) await tx.createVersion(slug);

    const storedPage = await tx.putPage(slug, {
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

    if (deferDerived) {
      await invalidatePageDerivedStorage(tx, storedPage.slug);
    } else {
      await replacePageDerivedStorage(tx, storedPage, parsed.tags, manifestPath, chunks);
    }
  });

  return {
    slug,
    status: 'imported',
    chunks: chunks.length,
    ...(deferDerived ? { deferred_derived: true } : {}),
    content_hash: hash,
  };
}

export async function refreshDerivedStorageForPage(
  engine: BrainEngine,
  slug: string,
  options: RefreshDerivedStorageOptions = {},
): Promise<ImportResult> {
  const normalizedSlug = validateSlug(slug);
  const manifestPath = options.path ?? `${normalizedSlug}.md`;
  let chunkCount = 0;
  let contentHash: string | undefined;

  await engine.transaction(async (tx) => {
    const page = await tx.getPageForUpdate(normalizedSlug);
    if (!page) {
      throw new Error(`Cannot refresh derived storage for missing page: ${normalizedSlug}`);
    }
    contentHash = page.content_hash;

    if (
      options.expectedContentHash !== undefined
      && options.expectedContentHash !== null
      && page.content_hash !== options.expectedContentHash
    ) {
      chunkCount = -1;
      return;
    }

    const tags = await tx.getTags(normalizedSlug);
    chunkCount = await replacePageDerivedStorage(tx, page, tags, manifestPath);
  });

  if (chunkCount === -1) {
    return {
      slug: normalizedSlug,
      status: 'skipped',
      chunks: 0,
      deferred_derived: false,
      content_hash: contentHash,
      error: 'Skipped derived refresh because content hash changed before the background job ran.',
    };
  }

  return {
    slug: normalizedSlug,
    status: 'imported',
    chunks: chunkCount,
    deferred_derived: false,
    content_hash: contentHash,
  };
}

async function replacePageDerivedStorage(
  engine: BrainEngine,
  page: Page,
  tags: string[],
  manifestPath: string,
  chunks = buildPageChunks(page.compiled_truth, page.timeline, page.frontmatter),
): Promise<number> {
  await engine.deleteChunks(page.slug);
  await engine.upsertChunks(page.slug, chunks);
  const manifest = await engine.upsertNoteManifestEntry(buildNoteManifestEntry({
    page_id: page.id,
    slug: page.slug,
    path: manifestPath,
    tags,
    content_hash: page.content_hash,
    page,
  }));
  await engine.replaceNoteSectionEntries(
    manifest.scope_id,
    manifest.slug,
    buildNoteSectionEntries({
      scope_id: manifest.scope_id,
      page_id: page.id,
      page_slug: page.slug,
      page_path: manifest.path,
      page,
      manifest,
    }),
  );
  return chunks.length;
}

async function invalidatePageDerivedStorage(
  engine: BrainEngine,
  slug: string,
): Promise<void> {
  await engine.deleteChunks(slug);
  await engine.deleteNoteSectionEntries(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug);
  await engine.deleteNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug);
}

function canRefreshDerivedStorage(page: unknown): page is {
  id: number;
  slug: string;
  type: ReturnType<typeof parseMarkdown>['type'];
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash: string;
} {
  if (!page || typeof page !== 'object') return false;
  const candidate = page as Record<string, unknown>;
  return typeof candidate.id === 'number'
    && typeof candidate.slug === 'string'
    && typeof candidate.type === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.compiled_truth === 'string'
    && typeof candidate.timeline === 'string'
    && typeof candidate.frontmatter === 'object'
    && candidate.frontmatter !== null
    && typeof candidate.content_hash === 'string';
}

/**
 * Import from a file path. Validates size, reads content, delegates to importFromContent.
 */
export async function importFromFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  options?: { noEmbed?: boolean; slugPrefix?: string; deferDerived?: boolean },
): Promise<ImportResult> {
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `Skipping symlink: ${filePath}` };
  }

  const stat = statSync(filePath);
  if (stat.size > MAX_MARKDOWN_IMPORT_BYTES) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `File too large (${stat.size} bytes)` };
  }

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseMarkdown(content, relativePath);
  const expectedSlug = pathToSlug(relativePath, options?.slugPrefix);

  if (hasExplicitFrontmatterSlug(content) && canonicalParsedSlug(parsed.slug) !== expectedSlug) {
    return {
      slug: expectedSlug,
      status: 'skipped',
      chunks: 0,
      error:
        `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expectedSlug}" ` +
        `(from ${relativePath}). Remove the frontmatter "slug:" line or move the file.`,
    };
  }

  return importFromContent(engine, expectedSlug, content, {
    path: relativePath,
    deferDerived: options?.deferDerived,
  });
}

function hasExplicitFrontmatterSlug(content: string): boolean {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return false;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return false;
    if (/^slug\s*:/.test(line.trim())) return true;
  }
  return false;
}

function canonicalParsedSlug(slug: string): string {
  try {
    return slugifyPath(validateSlug(slug));
  } catch {
    return slug;
  }
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
