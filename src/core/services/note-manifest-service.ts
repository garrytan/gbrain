import type { BrainEngine } from '../engine.ts';
import type { NoteManifestEntry, NoteManifestEntryInput, NoteManifestHeading, Page, PageInput } from '../types.ts';
import { slugifyPath } from '../sync.ts';
import { importContentHash } from '../utils.ts';

export const DEFAULT_NOTE_MANIFEST_SCOPE_ID = 'workspace:default';
export const NOTE_MANIFEST_EXTRACTOR_VERSION = 'phase2-structural-v1';

export interface BuildNoteManifestEntryInput {
  scope_id?: string;
  page_id: number;
  slug: string;
  path: string;
  tags?: string[];
  content_hash?: string;
  page: Pick<PageInput, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'> & {
    content_hash?: string;
  };
}

export function buildNoteManifestEntry(input: BuildNoteManifestEntryInput): NoteManifestEntryInput {
  const scopeId = input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const slug = slugifyPath(input.slug);
  const path = normalizeManifestPath(input.path);
  const page = input.page;
  const tags = canonicalizeTags(input.tags ?? []);
  const body = joinCanonicalBody(page.compiled_truth, page.timeline ?? '');

  return {
    scope_id: scopeId,
    page_id: input.page_id,
    slug,
    path,
    page_type: page.type,
    title: page.title,
    frontmatter: page.frontmatter ?? {},
    aliases: extractAliases(page.frontmatter ?? {}),
    tags,
    outgoing_wikilinks: extractOutgoingWikilinks(body),
    outgoing_urls: extractOutgoingUrls(body),
    source_refs: extractSourceRefs(body),
    heading_index: extractHeadingIndex(body),
    content_hash: input.content_hash
      ?? page.content_hash
      ?? importContentHash({
        title: page.title,
        type: page.type,
        compiled_truth: page.compiled_truth,
        timeline: page.timeline ?? '',
        frontmatter: page.frontmatter ?? {},
        tags,
      }),
    extractor_version: NOTE_MANIFEST_EXTRACTOR_VERSION,
  };
}

export async function rebuildNoteManifestEntries(
  engine: BrainEngine,
  input: {
    scope_id?: string;
    slug?: string;
  } = {},
): Promise<NoteManifestEntry[]> {
  const scopeId = input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const pages = input.slug
    ? [await requirePage(engine, input.slug)]
    : await listAllPages(engine);

  const rebuilt: NoteManifestEntry[] = [];
  for (const page of pages) {
    const tags = await engine.getTags(page.slug);
    const existing = await engine.getNoteManifestEntry(scopeId, page.slug);
    rebuilt.push(await engine.upsertNoteManifestEntry(buildNoteManifestEntry({
      scope_id: scopeId,
      page_id: page.id,
      slug: page.slug,
      path: existing?.path ?? `${page.slug}.md`,
      tags,
      content_hash: page.content_hash,
      page,
    })));
  }

  return rebuilt;
}

function normalizeManifestPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

function joinCanonicalBody(compiledTruth: string, timeline: string): string {
  if (!timeline.trim()) return compiledTruth;
  return `${compiledTruth}\n\n---\n\n${timeline}`;
}

function extractAliases(frontmatter: Record<string, unknown>): string[] {
  const aliases = frontmatter.aliases;
  if (typeof aliases === 'string') {
    return uniqueStrings(aliases.split(',').map((alias) => alias.trim()).filter(Boolean));
  }
  if (Array.isArray(aliases)) {
    return uniqueStrings(aliases.map((alias) => String(alias).trim()).filter(Boolean));
  }
  return [];
}

function extractOutgoingWikilinks(body: string): string[] {
  const targets: string[] = [];
  const pattern = /\[\[([^\]]+)\]\]/g;

  for (const match of body.matchAll(pattern)) {
    const raw = match[1]?.trim() ?? '';
    if (!raw) continue;
    const target = raw.split('|')[0]?.split('#')[0]?.trim() ?? '';
    if (!target) continue;
    targets.push(slugifyPath(target));
  }

  return uniqueStrings(targets);
}

function extractOutgoingUrls(body: string): string[] {
  const urls: string[] = [];
  const pattern = /https?:\/\/[^\s<>"')\]]+/g;

  for (const match of body.matchAll(pattern)) {
    const candidate = match[0]?.trim() ?? '';
    if (!candidate) continue;
    urls.push(candidate.replace(/[.,;:!?]+$/g, ''));
  }

  return uniqueStrings(urls);
}

function extractSourceRefs(body: string): string[] {
  const refs: string[] = [];
  const pattern = /\[Source:\s*([^\]\n]+)\]/g;

  for (const match of body.matchAll(pattern)) {
    const source = match[1]?.trim() ?? '';
    if (!source) continue;
    refs.push(source);
  }

  return uniqueStrings(refs);
}

function extractHeadingIndex(body: string): NoteManifestHeading[] {
  const headings: NoteManifestHeading[] = [];
  const seen = new Map<string, number>();
  const lines = body.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;

    const depth = match[1]!.length;
    const text = match[2]!.trim();
    if (!text) continue;

    const baseSlug = slugifyHeadingText(text);
    const nextCount = (seen.get(baseSlug) ?? 0) + 1;
    seen.set(baseSlug, nextCount);
    const headingSlug = nextCount === 1 ? baseSlug : `${baseSlug}-${nextCount}`;

    headings.push({
      slug: headingSlug,
      text,
      depth,
      line_start: index + 1,
    });
  }

  return headings;
}

function slugifyHeadingText(text: string): string {
  const slug = slugifyPath(text);
  return slug || 'section';
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

function canonicalizeTags(values: string[]): string[] {
  return uniqueStrings(values).sort((left, right) => left.localeCompare(right));
}

async function requirePage(engine: BrainEngine, slug: string): Promise<Page> {
  const page = await engine.getPage(slug);
  if (!page) {
    throw new Error(`Page not found: ${slug}`);
  }
  return page;
}

async function listAllPages(engine: BrainEngine, batchSize = 500): Promise<Page[]> {
  const pages: Page[] = [];

  for (let offset = 0; ; offset += batchSize) {
    const batch = await engine.listPages({ limit: batchSize, offset });
    pages.push(...batch);
    if (batch.length < batchSize) {
      break;
    }
  }

  return pages;
}
