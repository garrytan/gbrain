import { readFileSync, statSync, lstatSync } from 'fs';
import type { BrainEngine } from './engine.ts';
import {
  canonicalDerivedTags,
  canonicalDerivedParameters,
  DERIVED_SCHEMA_VERSION,
  PAGE_DERIVED_ARTIFACTS,
} from './derived-jobs.ts';
import { buildFrontmatterSearchText, parseMarkdown } from './markdown.ts';
import { chunkText, type ChunkOptions } from './chunkers/recursive.ts';
import { estimateTokenCount } from './embedding.ts';
import { defaultPageChunkOptions, resolvePageChunkOptions } from './page-chunk-options.ts';
import {
  buildNoteManifestEntry,
  DEFAULT_NOTE_MANIFEST_SCOPE_ID,
  NOTE_MANIFEST_EXTRACTOR_VERSION,
} from './services/note-manifest-service.ts';
import { markContextMapEntriesStaleForSourceSetChange } from './services/context-map-service.ts';
import { buildNoteSectionEntries, NOTE_SECTION_EXTRACTOR_VERSION } from './services/note-section-service.ts';
import { pathToSlug, slugifyPath } from './sync.ts';
import type { ChunkInput, DerivedArtifactKind, DerivedIndexState, DerivedJob, Page } from './types.ts';
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
  leaseOwner?: string;
  leaseArtifactKind?: DerivedArtifactKind;
  signal?: AbortSignal;
}

const PAGE_CHUNKS_EXTRACTOR_VERSION = 'qwen3-token-recursive-chunks-v1';
const PAGE_DERIVED_EXTRACTOR_VERSIONS: Record<DerivedArtifactKind, string> = {
  page_chunks: PAGE_CHUNKS_EXTRACTOR_VERSION,
  note_manifest: NOTE_MANIFEST_EXTRACTOR_VERSION,
  note_sections: NOTE_SECTION_EXTRACTOR_VERSION,
  context_map: 'context-map-v1',
  context_atlas: 'context-atlas-v1',
};
const DERIVED_REFRESH_TARGET_CHANGED_ERROR =
  'Skipped derived refresh because derived target changed before the background job ran.';

class DerivedRefreshTargetChangedError extends Error {
  constructor() {
    super(DERIVED_REFRESH_TARGET_CHANGED_ERROR);
  }
}

class DerivedRefreshAbortedError extends Error {
  constructor() {
    super('Skipped derived refresh because the worker was stopped before completion.');
  }
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
    if (!canRefreshDerivedStorage(existing)) {
      return { slug, status: 'skipped', chunks: 0, content_hash: hash };
    }
    const derivedStorageCurrent = await isPageDerivedStorageCurrent(engine, existing, manifestPath);
    if (derivedStorageCurrent) {
      return { slug, status: 'skipped', chunks: 0, content_hash: hash };
    }

    if (deferDerived) {
      await engine.transaction(async (tx) => {
        const current = await tx.getPageForUpdate(slug);
        if (!current || current.content_hash !== hash || !canRefreshDerivedStorage(current)) return;
        await invalidatePageDerivedStorage(tx, current, manifestPath);
      });
      return {
        slug,
        status: 'skipped',
        chunks: 0,
        deferred_derived: true,
        content_hash: hash,
      };
    }

    await engine.transaction(async (tx) => {
      const current = await tx.getPageForUpdate(slug);
      if (!current || current.content_hash !== hash || !canRefreshDerivedStorage(current)) return;
      const tags = await tx.getTags(slug);
      await enqueuePageDerivedRefresh(tx, current, manifestPath, tags);
      await replacePageDerivedStorage(
        tx,
        current,
        tags,
        manifestPath,
        undefined,
        new Set(PAGE_DERIVED_ARTIFACTS),
      );
    });
    return { slug, status: 'skipped', chunks: 0, content_hash: hash };
  }

  const chunkOptions = await resolvePageChunkOptions(engine);
  const chunks = deferDerived
    ? []
    : buildPageChunks(parsed.compiled_truth, parsed.timeline, parsed.frontmatter, chunkOptions);

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

    // Tag reconciliation: remove stale, add current. Removes and adds target
    // disjoint tags and are single statements (no nested transactions), so
    // they can be issued concurrently.
    const existingTags = await tx.getTags(slug);
    const newTags = new Set(parsed.tags);
    await Promise.all([
      ...existingTags.filter((old) => !newTags.has(old)).map((old) => tx.removeTag(slug, old)),
      ...parsed.tags.map((tag) => tx.addTag(slug, tag)),
    ]);

    if (deferDerived) {
      await invalidatePageDerivedStorage(tx, storedPage, manifestPath);
    } else {
      await enqueuePageDerivedRefresh(tx, storedPage, manifestPath, parsed.tags);
      await replacePageDerivedStorage(
        tx,
        storedPage,
        parsed.tags,
        manifestPath,
        chunks,
        new Set(PAGE_DERIVED_ARTIFACTS),
      );
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
  let skipError: string | undefined;

  try {
    assertDerivedRefreshNotAborted(options.signal);
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
        skipError = 'Skipped derived refresh because content hash changed before the background job ran.';
        return;
      }

      const tags = await tx.getTags(normalizedSlug);
      const targetState = await getPageDerivedRefreshTargetState(tx, page, manifestPath, tags);
      if (!targetState.current) {
        chunkCount = -1;
        skipError = DERIVED_REFRESH_TARGET_CHANGED_ERROR;
        return;
      }

      assertDerivedRefreshNotAborted(options.signal);
      chunkCount = await replacePageDerivedStorage(
        tx,
        page,
        tags,
        manifestPath,
        undefined,
        targetState.activeArtifactKinds,
        options.leaseOwner,
        options.leaseArtifactKind,
        options.signal,
      );
    });
  } catch (error) {
    if (!(error instanceof DerivedRefreshTargetChangedError) && !(error instanceof DerivedRefreshAbortedError)) {
      throw error;
    }
    chunkCount = -1;
    skipError = error.message;
  }

  if (chunkCount === -1) {
    return {
      slug: normalizedSlug,
      status: 'skipped',
      chunks: 0,
      deferred_derived: false,
      content_hash: contentHash,
      error: skipError ?? 'Skipped derived refresh because derived target changed before the background job ran.',
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

export async function refreshPageDerivedStorageIfStale(
  engine: BrainEngine,
  page: Page,
  options: { path?: string } = {},
): Promise<ImportResult | null> {
  if (!canRefreshDerivedStorage(page)) return null;
  const manifestPath = options.path ?? await resolvePageDerivedRefreshManifestPath(engine, page);
  if (await isPageDerivedStorageCurrent(engine, page, manifestPath)) return null;

  return refreshDerivedStorageForPage(engine, page.slug, {
    path: manifestPath,
    expectedContentHash: page.content_hash,
  });
}

async function resolvePageDerivedRefreshManifestPath(engine: BrainEngine, page: Page): Promise<string> {
  const manifest = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, page.slug);
  if (manifest?.path) return manifest.path;

  const activeJobs = [
    ...await engine.listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: page.slug,
      status: 'pending',
    }),
    ...await engine.listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: page.slug,
      status: 'running',
    }),
  ];
  const matchingJob = activeJobs.find((job) => (
    job.target_content_hash === page.content_hash
    && job.manifest_path
  ));
  if (matchingJob?.manifest_path) return matchingJob.manifest_path;

  return `${validateSlug(page.slug)}.md`;
}

async function replacePageDerivedStorage(
  engine: BrainEngine,
  page: Page,
  tags: string[],
  manifestPath: string,
  chunks: ChunkInput[] | undefined = undefined,
  activeArtifactKinds?: ReadonlySet<DerivedArtifactKind>,
  leaseOwner?: string,
  leaseArtifactKind?: DerivedArtifactKind,
  signal?: AbortSignal,
): Promise<number> {
  assertDerivedRefreshNotAborted(signal);
  const resolvedChunks = chunks ?? buildPageChunks(
    page.compiled_truth,
    page.timeline,
    page.frontmatter,
    await resolvePageChunkOptions(engine),
  );
  await engine.upsertChunks(page.slug, resolvedChunks);
  assertDerivedRefreshNotAborted(signal);
  const manifest = await engine.upsertNoteManifestEntry(buildNoteManifestEntry({
    page_id: page.id,
    slug: page.slug,
    path: manifestPath,
    tags,
    content_hash: page.content_hash,
    page,
  }));
  assertDerivedRefreshNotAborted(signal);
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
  assertDerivedRefreshNotAborted(signal);
  if (!await markPageDerivedStorageReady(
    engine,
    page,
    manifestPath,
    tags,
    activeArtifactKinds,
    leaseOwner,
    leaseArtifactKind,
  )) {
    throw new DerivedRefreshTargetChangedError();
  }
  await markContextMapEntriesStaleForSourceSetChange(engine);
  return resolvedChunks.length;
}

function assertDerivedRefreshNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DerivedRefreshAbortedError();
  }
}

async function invalidatePageDerivedStorage(
  engine: BrainEngine,
  page: Page,
  manifestPath: string,
): Promise<void> {
  await engine.deleteChunks(page.slug);
  await engine.deleteNoteSectionEntries(DEFAULT_NOTE_MANIFEST_SCOPE_ID, page.slug);
  await engine.deleteNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, page.slug);
  await markContextMapEntriesStaleForSourceSetChange(engine);
  if (page.content_hash) {
    await enqueuePageDerivedRefresh(engine, page, manifestPath, await engine.getTags(page.slug));
  }
}

async function enqueuePageDerivedRefresh(
  engine: BrainEngine,
  page: Page,
  manifestPath: string,
  tags: string[] = [],
): Promise<void> {
  for (const artifactKind of PAGE_DERIVED_ARTIFACTS) {
    await engine.enqueueDerivedJob({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: page.slug,
      artifact_kind: artifactKind,
      target_content_hash: page.content_hash ?? '',
      manifest_path: manifestPath,
      derived_parameters: pageDerivedParameters(artifactKind, manifestPath, tags),
    });
  }
}

async function markPageDerivedStorageReady(
  engine: BrainEngine,
  page: Page,
  manifestPath: string,
  tags: string[] = [],
  activeArtifactKinds?: ReadonlySet<DerivedArtifactKind>,
  leaseOwner?: string,
  leaseArtifactKind?: DerivedArtifactKind,
): Promise<boolean> {
  if (!page.content_hash) return true;
  for (const artifactKind of PAGE_DERIVED_ARTIFACTS) {
    const artifactLeaseOwner = leaseArtifactKind === artifactKind ? leaseOwner : undefined;
    const state = await engine.markDerivedIndexReady({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: page.slug,
      artifact_kind: artifactKind,
      target_content_hash: page.content_hash,
      indexed_content_hash: page.content_hash,
      manifest_path: manifestPath,
      derived_parameters: pageDerivedParameters(artifactKind, manifestPath, tags),
      extractor_version: PAGE_DERIVED_EXTRACTOR_VERSIONS[artifactKind],
      derived_schema_version: DERIVED_SCHEMA_VERSION,
      lease_owner: artifactLeaseOwner,
      require_active_job: activeArtifactKinds?.has(artifactKind) === true,
    });
    if (!isReadyDerivedIndexState(state, page, artifactKind)) return false;
  }
  return true;
}

async function getPageDerivedRefreshTargetState(
  engine: BrainEngine,
  page: Page,
  manifestPath: string,
  tags: string[] = [],
): Promise<{ current: boolean; activeArtifactKinds: ReadonlySet<DerivedArtifactKind> }> {
  const activeArtifactKinds = new Set<DerivedArtifactKind>();
  if (!page.content_hash) return { current: true, activeArtifactKinds };
  // Two status-filtered round trips covering every artifact kind instead of
  // one unfiltered query per kind. Filtering by status server-side matters:
  // superseded/failed job rows accumulate per slug and are only deleted with
  // the page, so an unfiltered slug query could push active jobs past the
  // default row limit on heavily re-imported pages.
  const pendingJobs = await engine.listDerivedJobs({
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    slug: page.slug,
    status: 'pending',
  });
  const runningJobs = await engine.listDerivedJobs({
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    slug: page.slug,
    status: 'running',
  });
  const activeJobsByKind = new Map<DerivedArtifactKind, DerivedJob[]>();
  for (const job of [...pendingJobs, ...runningJobs]) {
    const bucket = activeJobsByKind.get(job.artifact_kind) ?? [];
    bucket.push(job);
    activeJobsByKind.set(job.artifact_kind, bucket);
  }
  for (const artifactKind of PAGE_DERIVED_ARTIFACTS) {
    const activeJobs = activeJobsByKind.get(artifactKind) ?? [];
    if (activeJobs.length === 0) continue;
    activeArtifactKinds.add(artifactKind);

    const targetParameters = pageDerivedParameters(artifactKind, manifestPath, tags);
    const expectedParameters = canonicalDerivedParameters(targetParameters);
    const hasMatchingTarget = activeJobs.some((job) => (
      job.target_content_hash === page.content_hash
      && job.manifest_path === manifestPath
      && canonicalDerivedParameters(job.derived_parameters) === expectedParameters
    ));
    if (!hasMatchingTarget) return { current: false, activeArtifactKinds };
  }
  return { current: true, activeArtifactKinds };
}

async function isPageDerivedStorageCurrent(
  engine: BrainEngine,
  page: Page,
  manifestPath: string,
): Promise<boolean> {
  if (!page.content_hash) return true;
  const existingManifest = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, page.slug);
  if (existingManifest?.path !== manifestPath) return false;

  // One round trip covering every artifact kind instead of one query per kind.
  const states = await engine.listDerivedIndexStates({
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    slug: page.slug,
  });
  const statesByKind = new Map(states.map((state) => [state.artifact_kind, state]));
  for (const artifactKind of PAGE_DERIVED_ARTIFACTS) {
    const targetParameters = pageDerivedParameters(artifactKind, manifestPath);
    const state = statesByKind.get(artifactKind);
    if (
      state?.status !== 'ready'
      || state.target_content_hash !== page.content_hash
      || state.indexed_content_hash !== page.content_hash
      || state.extractor_version !== targetParameters.extractor_version
      || state.derived_schema_version !== targetParameters.derived_schema_version
    ) {
      return false;
    }
  }
  return true;
}

function pageDerivedParameters(
  artifactKind: DerivedArtifactKind,
  manifestPath: string,
  tags: string[] = [],
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    manifest_path: manifestPath,
    extractor_version: PAGE_DERIVED_EXTRACTOR_VERSIONS[artifactKind],
    derived_schema_version: DERIVED_SCHEMA_VERSION,
  };
  if (artifactKind === 'note_manifest') {
    parameters.tags = canonicalDerivedTags(tags);
  }
  return parameters;
}

function isReadyDerivedIndexState(
  state: DerivedIndexState,
  page: Page,
  artifactKind: DerivedArtifactKind,
): boolean {
  if (!page.content_hash) return true;
  const targetParameters = pageDerivedParameters(artifactKind, '');
  return state.status === 'ready'
    && state.target_content_hash === page.content_hash
    && state.indexed_content_hash === page.content_hash
    && state.extractor_version === targetParameters.extractor_version
    && state.derived_schema_version === targetParameters.derived_schema_version;
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
  options: ChunkOptions = defaultPageChunkOptions(),
): ChunkInput[] {
  const chunks: ChunkInput[] = [];

  if (compiledTruth.trim()) {
    for (const chunk of chunkText(compiledTruth, options)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunk.text,
        chunk_source: 'compiled_truth',
        token_count: chunk.token_count ?? estimateTokenCount(chunk.text),
      });
    }
  }

  if (timeline.trim()) {
    for (const chunk of chunkText(timeline, options)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunk.text,
        chunk_source: 'timeline',
        token_count: chunk.token_count ?? estimateTokenCount(chunk.text),
      });
    }
  }

  const searchText = frontmatter ? buildFrontmatterSearchText(frontmatter) : '';
  if (searchText) {
    for (const chunk of chunkText(searchText, options)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunk.text,
        chunk_source: 'frontmatter',
        token_count: chunk.token_count ?? estimateTokenCount(chunk.text),
      });
    }
  }

  return chunks;
}
