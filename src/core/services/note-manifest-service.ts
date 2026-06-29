import type { BrainEngine } from '../engine.ts';
import { canonicalDerivedTags, DERIVED_SCHEMA_VERSION } from '../derived-jobs.ts';
import type { DerivedJob, NoteManifestEntry, NoteManifestEntryInput, NoteManifestHeading, NoteResolverMetadata, Page, PageInput } from '../types.ts';
import { slugifyPath } from '../sync.ts';
import { importContentHash, validateSlug } from '../utils.ts';
import { extractFrontmatterSourceRefs, mergeSourceRefs } from './corpus-lane-service.ts';

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
  const slug = validateSlug(input.slug);
  const path = normalizeManifestPath(input.path);
  const page = input.page;
  const tags = canonicalizeTags(input.tags ?? []);
  const body = joinCanonicalBody(page.compiled_truth, page.timeline ?? '');
  const frontmatter = page.frontmatter ?? {};

  return {
    scope_id: scopeId,
    page_id: input.page_id,
    slug,
    path,
    page_type: page.type,
    title: page.title,
    frontmatter,
    aliases: extractAliases(frontmatter),
    tags,
    outgoing_wikilinks: extractOutgoingWikilinks(body),
    outgoing_urls: extractOutgoingUrls(body),
    source_refs: mergeSourceRefs(
      extractSourceRefs(body),
      extractFrontmatterSourceRefs(frontmatter, path),
    ),
    resolver_metadata: extractResolverMetadata(frontmatter),
    heading_index: extractHeadingIndex(body),
    content_hash: input.content_hash
      ?? page.content_hash
      ?? importContentHash({
        title: page.title,
        type: page.type,
        compiled_truth: page.compiled_truth,
        timeline: page.timeline ?? '',
        frontmatter,
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
    const manifestPath = await resolveManualRebuildManifestPath(engine, scopeId, page, existing?.path);
    const manifest = await engine.upsertNoteManifestEntry(buildNoteManifestEntry({
      scope_id: scopeId,
      page_id: page.id,
      slug: page.slug,
      path: manifestPath,
      tags,
      content_hash: page.content_hash,
      page,
    }));
    rebuilt.push(manifest);

    if (page.content_hash) {
      await engine.markDerivedIndexReady({
        scope_id: scopeId,
        slug: page.slug,
        artifact_kind: 'note_manifest',
        target_content_hash: page.content_hash,
        indexed_content_hash: page.content_hash,
        manifest_path: manifest.path,
        derived_parameters: {
          manifest_path: manifest.path,
          tags: canonicalDerivedTags(tags),
          extractor_version: NOTE_MANIFEST_EXTRACTOR_VERSION,
          derived_schema_version: DERIVED_SCHEMA_VERSION,
        },
        extractor_version: NOTE_MANIFEST_EXTRACTOR_VERSION,
        derived_schema_version: DERIVED_SCHEMA_VERSION,
      });
    }
  }

  return rebuilt;
}

async function resolveManualRebuildManifestPath(
  engine: BrainEngine,
  scopeId: string,
  page: Page,
  existingPath: string | undefined,
): Promise<string> {
  if (existingPath) return existingPath;
  return await findActiveManifestJobPath(engine, scopeId, page) ?? `${page.slug}.md`;
}

async function findActiveManifestJobPath(
  engine: BrainEngine,
  scopeId: string,
  page: Page,
): Promise<string | null> {
  if (!page.content_hash) return null;

  const [pendingJobs, runningJobs] = await Promise.all([
    engine.listDerivedJobs({
      scope_id: scopeId,
      slug: page.slug,
      artifact_kind: 'note_manifest',
      status: 'pending',
    }),
    engine.listDerivedJobs({
      scope_id: scopeId,
      slug: page.slug,
      artifact_kind: 'note_manifest',
      status: 'running',
    }),
  ]);
  const matchingJob = [...pendingJobs, ...runningJobs]
    .find((job: DerivedJob) => (
      job.target_content_hash === page.content_hash
      && typeof job.manifest_path === 'string'
      && job.manifest_path.length > 0
    ));

  return matchingJob?.manifest_path ?? null;
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

function extractResolverMetadata(frontmatter: Record<string, unknown>): NoteResolverMetadata {
  const metadata: NoteResolverMetadata = {
    applies_to: frontmatterStringList(frontmatter.applies_to),
    excludes: frontmatterStringList(frontmatter.excludes),
    routing_triggers: frontmatterStringList(frontmatter.routing_triggers),
    gotchas: frontmatterStringList(frontmatter.gotchas),
  };

  const canonicalSubjectKey = frontmatterString(frontmatter.canonical_subject_key);
  if (canonicalSubjectKey) metadata.canonical_subject_key = canonicalSubjectKey;
  const definitionOwner = frontmatterString(frontmatter.definition_owner);
  if (definitionOwner) metadata.definition_owner = definitionOwner;
  const semanticGrain = frontmatterString(frontmatter.semantic_grain);
  if (semanticGrain) metadata.semantic_grain = semanticGrain;
  return metadata;
}

function frontmatterString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function frontmatterStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return uniqueStrings(value.split(',').map((item) => item.trim()).filter(Boolean));
  }
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((item) => String(item).trim()).filter(Boolean));
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
