/**
 * The reads of a fact purge's plan, its dry run and `--match` (src/core/engine-sql/facts-purge-plan.ts), served from
 * rust/crates/gbrain-store/src/facts/purge_plan.rs. Each member sends the arguments of its BrainEngine member.
 *
 * Answered here, without a store call, because the store keeps no such rows:
 * - `readStagingPartEdges`: the raw upload parts (`page_body_staging_parts`) are not kept, so no part edge exists.
 * - `listDerivedRowsStep`: the store keeps no derivation edges (`derivation_inputs`), so no row is derived.
 * - `setPurgeProbeTimeout`: a store read has no statement deadline to set.
 *
 * The inventory probes (`countPurgeProbe`, `listPurgeProbeItems`) send the probe's shape (purgeProbeShape). The store
 * answers `links`, `timeline_entries`, `raw_data` and `wanted_links`; a table the store does not keep at all holds no
 * row (0, or no item); a table the store keeps but cannot probe yet refuses. A named `raw_data` probe that matches
 * refuses its item list, because the store keeps no `raw_data.id` to name a row by.
 */
import type { BrainEngine } from '../../engine.ts';
import { purgeProbeShape, type PurgeProbe } from '../../facts/purge-plan-statements.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The inventory tables the store probes (facts/purge_plan.rs `PurgeProbeArgs::hits`). */
const STORE_PROBED_TABLES: ReadonlySet<string> = new Set(['links', 'timeline_entries', 'raw_data', 'wanted_links']);

/** Inventory tables the store keeps no rows of: a probe of one finds nothing. */
const STORE_ABSENT_PROBE_TABLES: ReadonlySet<string> = new Set([
  'context_volunteer_events', 'mention_gazetteer_entries', 'conversation_parser_llm_cache', 'drift_decisions',
  'eval_takes_quality_runs', 'link_edge_proposals', 'memory_proposals', 'migration_impact_log', 'persistence_graduation',
  'persistence_worktree_refreshes', 'pinned_questions', 'session_context_state', 'shared_skill_revisions',
  'source_ingestion_receipts', 'sync_notifier_sources', 'take_grade_cache', 'think_ab_results',
]);

type ProbeRoute = { kind: 'none' } | { kind: 'store'; args: Record<string, unknown> };

function probeRoute(member: string, probe: PurgeProbe): ProbeRoute {
  const shape = purgeProbeShape(probe);
  if (!shape) return { kind: 'none' };
  if (STORE_ABSENT_PROBE_TABLES.has(shape.table)) return { kind: 'none' };
  if (!STORE_PROBED_TABLES.has(shape.table) || shape.binary) refuseMember(member, `the ${shape.table} probe`);
  return { kind: 'store', args: {
    table: shape.table, sourceId: shape.sourceId, columns: [...shape.bare],
    needles: shape.needles.map(n => ({ lower: n.toLowerCase(), escaped: JSON.stringify(n).slice(1, -1).toLowerCase() })),
  } };
}

export const hasLivePageSlug: Member<'hasLivePageSlug'> = (brain, sourceId, slug) =>
  storeCall({ member: 'hasLivePageSlug' }, () => brain.hasLivePageSlug({ sourceId, slug }));

export const readPurgeTakePages: Member<'readPurgeTakePages'> = (brain, sourceId, pageIds) =>
  storeCall({ member: 'readPurgeTakePages' }, () => brain.readPurgeTakePages({ sourceId, pageIds: [...pageIds] }));

export const countPurgeCarryingVersions: Member<'countPurgeCarryingVersions'> = (brain, q) =>
  storeCall({ member: 'countPurgeCarryingVersions' }, () => brain.countPurgeCarryingVersions({
    sourceId: q.sourceId, claimLower: q.claimLower, claimJson: q.claimJson, reason: q.reason }));

export const listStagingsHoldingClaim: Member<'listStagingsHoldingClaim'> = (brain, q) =>
  storeCall({ member: 'listStagingsHoldingClaim' }, () => brain.listStagingsHoldingClaim({
    sourceId: q.sourceId, claimLower: q.claimLower, claim: q.claim, cellLower: q.cellLower }));

/** The store keeps no raw staging parts, so there is no part edge to read. */
export const readStagingPartEdges: Member<'readStagingPartEdges'> = async () => [];

export const countPurgeReviewRows: Member<'countPurgeReviewRows'> = (brain, sourceId, factIds) =>
  storeCall({ member: 'countPurgeReviewRows' }, () => brain.countPurgeReviewRows({ sourceId, factIds: [...factIds] }));

export const matchPurgeCandidates: Member<'matchPurgeCandidates'> = (brain, sourceId, text) =>
  storeCall({ member: 'matchPurgeCandidates' }, () => brain.matchPurgeCandidates({ sourceId, text }));

export const listRequestsCarryingClaim: Member<'listRequestsCarryingClaim'> = (brain, q) =>
  storeCall({ member: 'listRequestsCarryingClaim' }, () => brain.listRequestsCarryingClaim({
    sourceId: q.sourceId, claimLower: q.claimLower, claimJson: q.claimJson, reason: q.reason, limit: q.limit }));

export const listRequestsHoldingStagings: Member<'listRequestsHoldingStagings'> = (brain, sourceId, stagingIds) =>
  storeCall({ member: 'listRequestsHoldingStagings' }, () => brain.listRequestsHoldingStagings({ sourceId, stagingIds: [...stagingIds] }));

/** The store keeps no derivation edges, so no row is derived from the frontier. */
export const listDerivedRowsStep: Member<'listDerivedRowsStep'> = async () => [];

export const listSegmentedPurgeBodies: Member<'listSegmentedPurgeBodies'> = (brain, sourceId, store, limit) =>
  storeCall({ member: 'listSegmentedPurgeBodies' }, () => brain.listSegmentedPurgeBodies({ sourceId, store, limit }));

export const countLegacyDerivedPages: Member<'countLegacyDerivedPages'> = (brain, sourceId) =>
  storeCall({ member: 'countLegacyDerivedPages' }, () => brain.countLegacyDerivedPages({ sourceId }));

export const listPageSourcePaths: Member<'listPageSourcePaths'> = (brain, pageIds) =>
  storeCall({ member: 'listPageSourcePaths' }, () => brain.listPageSourcePaths({ pageIds: [...pageIds] }));

export const listFactNeighbours: Member<'listFactNeighbours'> = (brain, q) =>
  storeCall({ member: 'listFactNeighbours' }, () => brain.listFactNeighbours({
    embedding: q.embedding, sourceId: q.sourceId, model: q.model, claim: q.claim }));

/** A store read has no statement deadline to set. */
export const setPurgeProbeTimeout: Member<'setPurgeProbeTimeout'> = async () => {};

export const countPurgeProbe: Member<'countPurgeProbe'> = async (brain, probe, rows) => {
  const route = probeRoute('countPurgeProbe', probe);
  if (route.kind === 'none') return 0;
  return storeCall({ member: 'countPurgeProbe' }, () => brain.countPurgeProbe({ ...route.args, rows }));
};

export const listPurgeProbeItems: Member<'listPurgeProbeItems'> = async (brain, probe) => {
  const route = probeRoute('listPurgeProbeItems', probe);
  if (route.kind === 'none') return [];
  const items = await storeCall({ member: 'listPurgeProbeItems' }, () => brain.listPurgeProbeItems(route.args)) as string[] | null;
  if (items == null) return refuseMember('listPurgeProbeItems', `naming the ${probe.table} rows`);
  return items;
};
