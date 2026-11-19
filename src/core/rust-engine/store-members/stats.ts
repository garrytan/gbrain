/**
 * Brain statistics, health and the ingest log (BrainEngine getStats, getHealth, logIngest, getIngestLog,
 * listEnrichCandidates, findAnomalies).
 *
 * The store counts; these members resolve what PGLite resolves in TypeScript and finish the same arithmetic:
 *  - getHealth reads the orphan policy overrides, the timeline grading and the entity types (schema pack, through
 *    getConfig and the store's config keys) and the link-extraction watermark here, sends the entity filter to the
 *    store, applies `shouldExcludeFromOrphanReporting` to the linkable pages the store returns, counts stale pages
 *    with countStalePagesForExtraction and scores as `engine-sql/health.ts` does;
 *  - findAnomalies computes the window bounds (an invalid `since` throws the same RangeError), zero-fills the store's
 *    per-day counts over the same days and runs `computeAnomaliesFromBuckets`.
 * The store counts a chunk as embedded when it has a stored vector, and reads the salience weight. getStats and getHealth
 * refuse a brain whose config selects another embedding column, as the embedding members do (rust/docs/store/stats.md).
 */
import type {
  AnomaliesOpts, AnomalyResult, BrainHealth, BrainStats, EnrichCandidate, EnrichCandidatesOpts, IngestLogEntry, IngestLogInput,
} from '../../types.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../../types.ts';
import { computeAnomaliesFromBuckets, type CohortDayRow, type CohortTodayRow } from '../../cycle/anomaly.ts';
import { effectiveLinkExtractorWatermark } from '../../link-extraction-watermark.ts';
import { loadOrphanPolicyOverrides, shouldExcludeFromOrphanReporting } from '../../orphan-policy.ts';
import { resolveEntityTypes } from '../../schema-pack/entity-types.ts';
import { loadTimelineGradedPredicate } from '../../timeline-grading.ts';
import { withDates } from '../store-codec.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, requireTextColumn, storeCall, takeOptions, type StoreMember } from './common.ts';
import { getConfig, listConfigKeys } from './config.ts';
import { countStalePagesForExtraction } from './extraction.ts';
import { listAllSources } from './sources.ts';

type ScopeOpts = { sourceId?: string; sourceIds?: string[] };

/** `opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null)`: an empty `sourceIds` matches nothing. */
function statsScope(member: string, opts: ScopeOpts | undefined): string[] | null {
  const o = takeOptions(member, opts, ['sourceId', 'sourceIds']);
  const ids = (o.sourceIds as string[] | null | undefined) ?? (o.sourceId ? [o.sourceId as string] : null);
  return ids === null ? null : [...new Set(ids)];
}

/** Array wins when not empty, then the scalar, else every source (salience.ts `sourceCondition`). */
function readScope(o: Record<string, unknown>): string[] | null {
  const ids = o.sourceIds as string[] | undefined;
  if (ids && ids.length > 0) return [...ids];
  return o.sourceId ? [o.sourceId as string] : null;
}

export const getStats: StoreMember<[opts?: ScopeOpts], BrainStats> = async (brain, opts) => {
  const scope = statsScope('getStats', opts);
  await requireTextColumn(brain, 'getStats');
  return storeCall({ member: 'getStats' }, () => brain.getStats({ scope }));
};

const SOURCE_OVERRIDE_PREFIX = 'schema_pack.source.';
/** `c.key LIKE 'schema_pack.source.%'`: the `_` is a LIKE wildcard. */
const SOURCE_OVERRIDE_LIKE = /^schema[\s\S]pack\.source\./;

/**
 * The engine `resolveEntityTypes` reads: getConfig, and the one `executeRaw` it runs for a brain-wide reading (the
 * registered sources with a schema pack override), answered from the store's config keys and sources.
 */
function entityTypeEngine(brain: StoreBrain) {
  return {
    getConfig: (key: string) => getConfig(brain, key),
    executeRaw: async <T>(_sql: string, params?: unknown[]): Promise<T[]> => {
      if (params?.[1] !== SOURCE_OVERRIDE_PREFIX) refuseMember('getHealth', 'a schema pack query the store does not answer');
      const sources = new Set((await listAllSources(brain, { includeArchived: true })).map((s) => s.id));
      const keys = await listConfigKeys(brain, 'schema');
      return keys
        .filter((key) => SOURCE_OVERRIDE_LIKE.test(key))
        .map((key) => [...key].slice(SOURCE_OVERRIDE_PREFIX.length).join(''))
        .filter((id) => sources.has(id))
        .map((source_id) => ({ source_id }) as T);
    },
  };
}

interface StoreHealth {
  page_count: number;
  eligible_chunks: number;
  embedded_chunks: number;
  missing_embeddings: number;
  dead_links: number;
  link_count: number;
  entity_page_count: number;
  entity_linked: number;
  entity_with_timeline: number;
  linkable: Array<{ slug: string; type: string; islanded: boolean; has_timeline: boolean }>;
  most_connected: Array<{ slug: string; link_count: number }>;
}

export const getHealth: StoreMember<[opts?: ScopeOpts], BrainHealth> = async (brain, opts) => {
  const scope = statsScope('getHealth', opts);
  await requireTextColumn(brain, 'getHealth');
  const deps = { getConfig: (key: string) => getConfig(brain, key) };
  const [orphanOverrides, isTimelineGraded, entityTypes] = await Promise.all([
    loadOrphanPolicyOverrides(deps),
    loadTimelineGradedPredicate(deps),
    resolveEntityTypes(entityTypeEngine(brain), scope),
  ]);
  const h: StoreHealth = await storeCall({ member: 'getHealth' }, () =>
    brain.getHealth({ scope, entityTypes: entityTypes.filter }));
  const watermark = await effectiveLinkExtractorWatermark(deps);
  const stalePages = scope === null
    ? await countStalePagesForExtraction(brain, { versionTs: watermark })
    : (await Promise.all(scope.map((sourceId) => countStalePagesForExtraction(brain, { sourceId, versionTs: watermark }))))
      .reduce((a, b) => a + b, 0);

  let linkablePageCount = 0;
  let orphanPages = 0;
  let timelineGradedCount = 0;
  let linkableTimelinePages = 0;
  for (const page of h.linkable) {
    if (shouldExcludeFromOrphanReporting(page.slug, orphanOverrides, { type: page.type })) continue;
    linkablePageCount += 1;
    if (page.islanded) orphanPages += 1;
    if (!isTimelineGraded(page.type)) continue;
    timelineGradedCount += 1;
    if (page.has_timeline) linkableTimelinePages += 1;
  }

  const pageCount = h.page_count;
  const embedCoverage = h.eligible_chunks === 0 ? 1.0 : h.embedded_chunks / h.eligible_chunks;
  const deadLinks = h.dead_links;
  const linkCount = h.link_count;
  const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
  const timelineDensity = timelineGradedCount > 0 ? Math.min(linkableTimelinePages / timelineGradedCount, 1) : 1;
  const noOrphans = linkablePageCount > 0 ? 1 - (orphanPages / linkablePageCount) : 1;
  const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;
  const embedCoverageScore = pageCount === 0 ? 35 : Math.round(embedCoverage * 35);
  const linkDensityScore = pageCount === 0 ? 25 : Math.round(linkDensity * 25);
  const timelineCoverageScore = pageCount === 0 ? 15 : Math.round(timelineDensity * 15);
  const noOrphansScore = pageCount === 0 ? 15 : Math.round(noOrphans * 15);
  const noDeadLinksScore = pageCount === 0 ? 10 : Math.round(noDeadLinks * 10);
  const coverageGraded = h.entity_page_count >= MIN_ENTITY_PAGES_FOR_COVERAGE;
  const denominator = Math.max(h.entity_page_count, 1);

  return {
    page_count: pageCount,
    linkable_page_count: linkablePageCount,
    embed_coverage: embedCoverage,
    stale_pages: stalePages,
    orphan_pages: orphanPages,
    missing_embeddings: h.missing_embeddings,
    brain_score: embedCoverageScore + linkDensityScore + timelineCoverageScore + noOrphansScore + noDeadLinksScore,
    dead_links: deadLinks,
    entity_page_count: h.entity_page_count,
    entity_types_status: entityTypes.status,
    link_coverage: coverageGraded ? h.entity_linked / denominator : null,
    timeline_coverage: coverageGraded ? h.entity_with_timeline / denominator : null,
    most_connected: h.most_connected.map((c) => ({ slug: c.slug, link_count: c.link_count })),
    embed_coverage_score: embedCoverageScore,
    link_density_score: linkDensityScore,
    timeline_coverage_score: timelineCoverageScore,
    no_orphans_score: noOrphansScore,
    no_dead_links_score: noDeadLinksScore,
  };
};

/** The text node-postgres binds for a non-null parameter; null and undefined bind SQL NULL. */
function boundText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const logIngest: StoreMember<[entry: IngestLogInput], void> = async (brain, entry) => {
  const sourceId = entry.source_id ?? 'default';
  await storeCall({ member: 'logIngest', sourceId: boundText(sourceId) ?? undefined }, () => brain.logIngest({
    source_id: boundText(sourceId),
    source_type: boundText(entry.source_type),
    source_ref: boundText(entry.source_ref),
    pages_updated_json: JSON.stringify(entry.pages_updated) ?? null,
    summary: boundText(entry.summary),
  }));
};

export const getIngestLog: StoreMember<[opts?: { limit?: number; sourceIds?: string[] }], IngestLogEntry[]> = async (brain, opts) => {
  const o = takeOptions('getIngestLog', opts, ['limit', 'sourceIds']);
  const limit = (o.limit as number | undefined) || 50;
  const rows: IngestLogEntry[] = await storeCall({ member: 'getIngestLog' }, () =>
    brain.getIngestLog({ limit, sourceIds: o.sourceIds ?? null }));
  return rows.map((row) => withDates(row, ['created_at']));
};

export const listEnrichCandidates: StoreMember<[opts: EnrichCandidatesOpts], EnrichCandidate[]> = async (brain, opts) => {
  const o = takeOptions('listEnrichCandidates', opts,
    ['types', 'thinThreshold', 'order', 'limit', 'reenrichAfterMs', 'sourceId', 'sourceIds']);
  const types = o.types as string[] | undefined;
  if (!types || types.length === 0) return [];
  const limit = Math.max(1, Math.min((o.limit as number | undefined) ?? 50, 5000));
  const threshold = Math.max(0, o.thinThreshold as number);
  // A NaN or infinite bound binds as numeric NaN / Infinity in Postgres, above every length; JSON has neither.
  const thinThreshold = Number.isFinite(threshold) ? threshold : Number.MAX_VALUE;
  const reenrichMs = (o.reenrichAfterMs as number | undefined) ?? 0;
  const enrichedAfter = reenrichMs > 0 ? new Date(Date.now() - reenrichMs).toISOString() : null;
  const order = ['inbound-links', 'updated', 'salience'].includes(o.order as string) ? o.order as string : 'inbound-links';
  return storeCall({ member: 'listEnrichCandidates' }, () => brain.listEnrichCandidates({
    types, thinThreshold, order, limit, enrichedAfter, scope: readScope(o),
  }));
};

const DAY_MS = 86_400_000;

/** `generate_series(start::date, end::date - 1, '1 day')` as `YYYY-MM-DD` texts. */
function baselineDays(baselineStart: Date, sinceDate: Date): string[] {
  const first = Math.floor(baselineStart.getTime() / DAY_MS);
  const last = Math.floor(sinceDate.getTime() / DAY_MS) - 1;
  const days: string[] = [];
  for (let day = first; day <= last; day++) days.push(new Date(day * DAY_MS).toISOString().slice(0, 10));
  return days;
}

interface StoreAnomalies {
  baseline: Record<'tag' | 'type', Record<string, Record<string, number>>>;
  today: CohortTodayRow[];
}

export const findAnomalies: StoreMember<[opts: AnomaliesOpts], AnomalyResult[]> = async (brain, opts) => {
  // PGLite reads only excludePrivate of the read scope here: minTrust, suppressFlagged and requireSafeChunks change nothing.
  const o = takeOptions('findAnomalies', opts, ['sourceId', 'sourceIds', 'since', 'lookback_days', 'sigma'],
    ['minTrust', 'suppressFlagged', 'requireSafeChunks']);
  const sigma = (o.sigma as number | undefined) ?? 3.0;
  const lookbackDays = Math.max(1, (o.lookback_days as number | undefined) ?? 30);
  const sinceIso = (o.since as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const sinceDate = new Date(sinceIso + 'T00:00:00Z');
  const sinceEnd = new Date(sinceDate.getTime() + DAY_MS);
  const baselineStart = new Date(sinceDate.getTime() - lookbackDays * DAY_MS);
  // The same RangeError PGLite throws while binding an invalid date.
  sinceEnd.toISOString();
  baselineStart.toISOString();
  const found: StoreAnomalies = await storeCall({ member: 'findAnomalies' }, () => brain.findAnomalies({
    scope: readScope(o),
    baselineStartUs: baselineStart.getTime() * 1000,
    sinceUs: sinceDate.getTime() * 1000,
    sinceEndUs: sinceEnd.getTime() * 1000,
  }));
  const days = baselineDays(baselineStart, sinceDate);
  const baseline: CohortDayRow[] = [];
  for (const kind of ['tag', 'type'] as const) {
    for (const [value, counts] of Object.entries(found.baseline[kind])) {
      for (const day of days) baseline.push({ cohort_kind: kind, cohort_value: value, day, count: counts[day] ?? 0 });
    }
  }
  return computeAnomaliesFromBuckets(baseline, found.today, sigma);
};
