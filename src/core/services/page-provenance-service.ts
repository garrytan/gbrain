import type { BrainEngine } from '../engine.ts';
import type { CanonicalHandoffEntry, IngestLogEntry, Link, MemoryCandidateEntry, Page, PageVersion, TimelineEntry } from '../types.ts';

export interface PageProvenanceView {
  requested_slug: string;
  resolved_slug: string;
  page: {
    slug: string;
    title: string;
    type: Page['type'];
    content_hash?: string | null;
    updated_at?: Date | string | null;
    compiled_truth_changed_at?: Date | string | null;
    timeline_changed_at?: Date | string | null;
  };
  citations: string[];
  timeline_entries: TimelineEntry[];
  version_history: PageVersion[];
  ingest_log: IngestLogEntry[];
  candidate_trail: MemoryCandidateEntry[];
  canonical_handoffs: CanonicalHandoffEntry[];
  backlinks: Link[];
}

export interface PageProvenanceInput {
  slug: string;
  limit?: number;
}

type PageProvenanceEngine = Pick<
  BrainEngine,
  | 'getPage'
  | 'resolveSlugs'
  | 'getTimeline'
  | 'getVersions'
  | 'getIngestLog'
  | 'getBacklinks'
  | 'listMemoryCandidateEntries'
  | 'listCanonicalHandoffEntries'
>;

const PROVENANCE_SCAN_BATCH_SIZE = 50;
const PROVENANCE_SCAN_MAX_ROWS = 1000;

export async function buildPageProvenanceView(engine: PageProvenanceEngine, input: PageProvenanceInput): Promise<PageProvenanceView | {
  error: 'ambiguous_slug';
  candidates: string[];
}> {
  const requestedSlug = input.slug.trim();
  const limit = normalizeLimit(input.limit);
  let resolvedSlug = requestedSlug;
  const candidates = await engine.resolveSlugs(requestedSlug);
  if (candidates.length === 1) {
    resolvedSlug = candidates[0];
  }

  let page = await engine.getPage(resolvedSlug);
  if (!page) {
    if (candidates.length > 1) {
      return { error: 'ambiguous_slug', candidates };
    }
    page = await engine.getPage(requestedSlug);
  }

  if (!page) {
    throw new Error(`Page not found: ${requestedSlug}`);
  }

  const [timelineEntries, versionHistory, backlinks, candidateTrail] = await Promise.all([
    engine.getTimeline(resolvedSlug, { limit }),
    engine.getVersions(resolvedSlug),
    engine.getBacklinks(resolvedSlug),
    engine.listMemoryCandidateEntries({ target_object_id: resolvedSlug, limit }),
  ]);

  const candidateIds = new Set(candidateTrail.map((candidate) => candidate.id));
  const [ingestLog, canonicalHandoffs] = await Promise.all([
    collectMatchingIngestLog(engine, resolvedSlug, limit),
    collectMatchingCanonicalHandoffs(engine, resolvedSlug, candidateIds, limit),
  ]);

  return {
    requested_slug: requestedSlug,
    resolved_slug: resolvedSlug,
    page: {
      slug: page.slug,
      title: page.title,
      type: page.type,
      content_hash: page.content_hash ?? null,
      updated_at: page.updated_at ?? null,
      compiled_truth_changed_at: page.compiled_truth_changed_at ?? null,
      timeline_changed_at: page.timeline_changed_at ?? null,
    },
    citations: extractPageSourceCitations(page),
    timeline_entries: timelineEntries.slice(0, limit),
    version_history: versionHistory.slice(0, limit),
    ingest_log: ingestLog,
    candidate_trail: candidateTrail.slice(0, limit),
    canonical_handoffs: canonicalHandoffs,
    backlinks: backlinks.slice(0, limit),
  };
}

async function collectMatchingIngestLog(
  engine: PageProvenanceEngine,
  resolvedSlug: string,
  limit: number,
): Promise<IngestLogEntry[]> {
  const matches: IngestLogEntry[] = [];
  let offset = 0;
  while (matches.length < limit && offset < PROVENANCE_SCAN_MAX_ROWS) {
    const rows = await engine.getIngestLog({ limit: PROVENANCE_SCAN_BATCH_SIZE, offset });
    if (rows.length === 0) break;
    matches.push(...rows.filter((entry) => entry.pages_updated.includes(resolvedSlug)));
    offset += rows.length;
    if (rows.length < PROVENANCE_SCAN_BATCH_SIZE) break;
  }
  return matches.slice(0, limit);
}

async function collectMatchingCanonicalHandoffs(
  engine: PageProvenanceEngine,
  resolvedSlug: string,
  candidateIds: Set<string>,
  limit: number,
): Promise<CanonicalHandoffEntry[]> {
  const matches: CanonicalHandoffEntry[] = [];
  let offset = 0;
  while (matches.length < limit && offset < PROVENANCE_SCAN_MAX_ROWS) {
    const rows = await engine.listCanonicalHandoffEntries({
      target_object_type: 'curated_note',
      limit: PROVENANCE_SCAN_BATCH_SIZE,
      offset,
    });
    if (rows.length === 0) break;
    matches.push(...rows.filter((entry) => entry.target_object_id === resolvedSlug || candidateIds.has(entry.candidate_id)));
    offset += rows.length;
    if (rows.length < PROVENANCE_SCAN_BATCH_SIZE) break;
  }
  return matches.slice(0, limit);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  return Math.max(1, Math.min(limit, 100));
}

function extractPageSourceCitations(page: Page): string[] {
  const citations = new Set<string>();
  const sourcePattern = /\[Source:\s*([^\]]+)\]/g;
  for (const text of [page.compiled_truth, page.timeline]) {
    for (const match of text.matchAll(sourcePattern)) {
      const citation = match[1]?.trim();
      if (citation) citations.add(citation);
    }
  }
  return [...citations];
}
