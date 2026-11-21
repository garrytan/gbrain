/**
 * The reads of a fact purge's plan, its dry run and `--match` (src/core/engine-sql/facts-purge.ts and
 * facts-purge-plan.ts), served from rust/crates/gbrain-store/src/facts/purge_plan.rs. Each member sends the arguments
 * of its BrainEngine member; the store call keeps its own name (the store method in parentheses below).
 *
 * Answered here, without a store call, because the store keeps no such rows:
 * - `listStagingPartEdges`: the raw upload parts (`page_body_staging_parts`) are not kept, so no part edge exists.
 * - `listDerivedRows`: the store keeps no derivation edges (`derivation_inputs`; `recordDerivationEdges` refuses on
 *   Rust), so no row is derived.
 * - `setPurgeProbeTimeout`: a store read has no statement deadline to set.
 *
 * The inventory probes (`countPurgeProbe`, `listPurgeProbeItems`) send the probe's shape (purgeProbeShape). The store
 * answers the named probes (`links`, `timeline_entries`, `raw_data`) and the whole-table probes of every inventory
 * table it keeps (facts/purge_probe.rs `table_rows`, plus `wanted_links`); a table the store does not keep at all
 * holds no row (0, or no item). A named `raw_data` probe names its rows by the `raw_data.id` the store keeps; it refuses
 * its item list only when a matching record was written before the store kept that id (its next putRawData adds one).
 *
 * A page purge receipt's store probes (engine-sql/purge-verify.ts) run through the same two members, as
 * `countPurgeStoreProbe` and `listPurgeStoreProbeItems` (facts/purge_store_probe.rs). The store answers `slug_key` for the
 * stores it keeps (pages, facts, take proposals, open loops, page and slug aliases, eval candidates, files, write-gate
 * holds), `page_rows`, `fact_refs`, `trust_proposals`, `page_requests`, `page_segment_texts`, `segment_texts` and
 * `effect_payload`. It keeps no rows of `core_edit_notices`, the retrieval event, link, feedback and weight stores,
 * `context_volunteer_events`, `mention_gazetteer_entries` or `query_cache`, so a probe of one finds nothing without a store
 * call. The fact purge's `fingerprint` and `claim_text` probes are not served: they refuse naming their kind.
 */
import type { BrainEngine } from '../../engine.ts';
import { escapeFenceCell } from '../../fence-shared.ts';
import { purgeProbeShape } from '../../facts/purge-plan-statements.ts';
import type { PurgeProbe } from '../../engine-sql/facts-purge-plan.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The inventory tables the store probes (facts/purge_plan.rs `PurgeProbeArgs::hits`, facts/purge_probe.rs). */
const STORE_PROBED_TABLES: ReadonlySet<string> = new Set([
  'links', 'timeline_entries', 'raw_data', 'wanted_links', 'calibration_profiles', 'decision_receipts', 'dream_verdicts',
  'eval_candidates', 'eval_contradictions_cache', 'eval_contradictions_runs', 'fact_relink_attempts', 'ingest_log',
  'mcp_request_log', 'minion_attachments', 'minion_inbox', 'minion_jobs', 'persistence_topology_changes',
  'subagent_messages', 'subagent_tool_executions',
]);

/** Inventory tables the store keeps no rows of: a probe of one finds nothing. */
const STORE_ABSENT_PROBE_TABLES: ReadonlySet<string> = new Set([
  'context_volunteer_events', 'mention_gazetteer_entries', 'conversation_parser_llm_cache', 'drift_decisions',
  'eval_takes_quality_runs', 'link_edge_proposals', 'memory_proposals', 'migration_impact_log', 'persistence_graduation',
  'persistence_worktree_refreshes', 'pinned_questions', 'session_context_state', 'shared_skill_revisions',
  'source_ingestion_receipts', 'sync_notifier_sources', 'take_grade_cache', 'think_ab_results',
]);

type ProbeRoute = { kind: 'none' } | { kind: 'store'; args: Record<string, unknown> } | { kind: 'receipt'; probe: Record<string, unknown> };

/**
 * The slug-keyed stores of a page purge receipt the store keeps no rows of, so a probe of one finds nothing:
 * `core_edit_notices` (no edit notices), the retrieval event, link, feedback and weight stores (reserved keyspaces that
 * hold no record), `context_volunteer_events` and `mention_gazetteer_entries` (not kept). `query_cache` is the same:
 * the store keeps no query cache, as `clearQueryCache` answering 0 says.
 */
const RECEIPT_ABSENT_SLUG_STORES: ReadonlySet<string> = new Set([
  'core_edit_notices', 'retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'retrieval_weights',
  'context_volunteer_events', 'mention_gazetteer_entries',
]);

/**
 * The store's arguments for a page purge receipt's store probe (facts/purge_store_probe.rs `StoreProbe`), or none when the
 * store keeps no row of it. A probe of a store the store keeps must reach it: it never answers 0 for one. The fact
 * purge's `fingerprint` and `claim_text` probes are not served and refuse naming their kind.
 */
function receiptRoute(member: string, probe: Exclude<PurgeProbe, { kind: 'table' | 'named' }>): ProbeRoute {
  switch (probe.kind) {
    case 'query_cache': return { kind: 'none' };
    case 'slug_key':
      return RECEIPT_ABSENT_SLUG_STORES.has(probe.store) ? { kind: 'none' }
        : { kind: 'receipt', probe: { kind: 'slug_key', store: probe.store, sourceId: probe.sourceId, slug: probe.slug } };
    case 'page_rows': return { kind: 'receipt', probe: { kind: 'page_rows', store: probe.store, pageId: probe.pageId } };
    case 'fact_refs':
      return { kind: 'receipt', probe: { kind: 'fact_refs', store: probe.store, sourceId: probe.sourceId, factIds: [...probe.factIds] } };
    case 'trust_proposals':
      return { kind: 'receipt', probe: { kind: 'trust_proposals', sourceId: probe.sourceId, pageId: probe.pageId, factIds: [...probe.factIds] } };
    case 'page_requests':
      return { kind: 'receipt', probe: {
        kind: 'page_requests', sourceId: probe.sourceId, slug: probe.slug, requestId: probe.requestId,
        needles: probe.needles.map(n => n.toLowerCase()), reasons: probe.reasons.map(n => n.toLowerCase()) } };
    case 'page_segment_texts':
      return { kind: 'receipt', probe: { kind: 'page_segment_texts', sourceId: probe.sourceId, shas: [...probe.shas], forms: [...probe.forms] } };
    case 'segment_texts':
      return { kind: 'receipt', probe: { kind: 'segment_texts', sourceId: probe.sourceId, needles: [...probe.needles], referenced: probe.referenced } };
    case 'effect_payload':
      return { kind: 'receipt', probe: {
        kind: 'effect_payload', sourceId: probe.sourceId, forms: [...probe.forms],
        ...(probe.page ? { page: { slug: probe.page.slug, reasonForms: [...probe.page.reasonForms] } } : {}) } };
    case 'fingerprint': case 'claim_text': return refuseMember(member, `the ${probe.kind} probe`);
  }
}

/**
 * Where a probe runs. An inventory probe of a table the store keeps runs there; one of a table it keeps no rows of
 * finds nothing. A purge receipt's store probe (engine-sql/purge-verify.ts) runs there too, except the stores above.
 */
function probeRoute(member: string, probe: PurgeProbe): ProbeRoute {
  if (probe.kind !== 'table' && probe.kind !== 'named') return receiptRoute(member, probe);
  const shape = purgeProbeShape(probe);
  if (!shape) return { kind: 'none' };
  if (STORE_ABSENT_PROBE_TABLES.has(shape.table)) return { kind: 'none' };
  if (!STORE_PROBED_TABLES.has(shape.table)) refuseMember(member, `the ${shape.table} probe`);
  return { kind: 'store', args: {
    table: shape.table, sourceId: shape.sourceId, columns: [...shape.bare], scoped: shape.scoped, binary: shape.binary,
    needles: shape.needles.map(n => ({ text: n, lower: n.toLowerCase(), escaped: JSON.stringify(n).slice(1, -1).toLowerCase() })),
  } };
}

/** (store `hasLivePageSlug`) */
export const purgeSubjectPageLive: Member<'purgeSubjectPageLive'> = (brain, sourceId, slug) =>
  storeCall({ member: 'purgeSubjectPageLive' }, () => brain.hasLivePageSlug({ sourceId, slug }));

/** (store `readPurgeTakePages`) */
export const listPurgePagesById: Member<'listPurgePagesById'> = (brain, sourceId, pageIds) =>
  storeCall({ member: 'listPurgePagesById' }, () => brain.readPurgeTakePages({ sourceId, pageIds: [...pageIds] }));

/** (store `countPurgeCarryingVersions`) `needle` is the lowered claim and `escaped` its lowered JSON form. */
export const countPurgeVersionsCarryingClaim: Member<'countPurgeVersionsCarryingClaim'> = (brain, sourceId, needle, escaped, reason) =>
  storeCall({ member: 'countPurgeVersionsCarryingClaim' }, () => brain.countPurgeCarryingVersions({
    sourceId, claimLower: needle, claimJson: escaped, reason }));

/** The store gets the same three needles the SQL binds: lowered, exact and the lowered fence cell. */
export const listStagingsHoldingClaim: Member<'listStagingsHoldingClaim'> = (brain, sourceId, claim) =>
  storeCall({ member: 'listStagingsHoldingClaim' }, () => brain.listStagingsHoldingClaim({
    sourceId, claimLower: claim.toLowerCase(), claim, cellLower: escapeFenceCell(claim).toLowerCase() }));

/** The store keeps no raw staging parts, so there is no part edge to read. */
export const listStagingPartEdges: Member<'listStagingPartEdges'> = async () => [];

/** The store counts by the fact ids; every caller passes `refs` as those ids in text. */
export const countPurgeReviewRows: Member<'countPurgeReviewRows'> = async (brain, sourceId, _refs, factIds) => {
  const n = await storeCall({ member: 'countPurgeReviewRows' }, () => brain.countPurgeReviewRows({ sourceId, factIds: [...factIds] })) as { q: number; rp: number; dp: number };
  return { decide_review_queue: n.q, decide_review_proposals: n.rp, decide_proposals: n.dp };
};

/** (store `matchPurgeCandidates`) */
export const listPurgeMatchCandidates: Member<'listPurgeMatchCandidates'> = (brain, sourceId, text) =>
  storeCall({ member: 'listPurgeMatchCandidates' }, () => brain.matchPurgeCandidates({ sourceId, text }));

export const listRequestsCarryingClaim: Member<'listRequestsCarryingClaim'> = (brain, q) =>
  storeCall({ member: 'listRequestsCarryingClaim' }, () => brain.listRequestsCarryingClaim({
    sourceId: q.sourceId, claimLower: q.claimLower, claimJson: q.claimJson, reason: q.reason, limit: q.limit }));

export const listRequestsHoldingStagings: Member<'listRequestsHoldingStagings'> = (brain, sourceId, stagingIds) =>
  storeCall({ member: 'listRequestsHoldingStagings' }, () => brain.listRequestsHoldingStagings({ sourceId, stagingIds: [...stagingIds] }));

/** The store keeps no derivation edges, so no row is derived from the frontier. */
export const listDerivedRows: Member<'listDerivedRows'> = async () => [];

/** (store `listSegmentedPurgeBodies`, the live pages) */
export const listSegmentedPageBodies: Member<'listSegmentedPageBodies'> = (brain, sourceId, limit) =>
  storeCall({ member: 'listSegmentedPageBodies' }, () => brain.listSegmentedPurgeBodies({ sourceId, store: 'pages', limit }));

/** (store `listSegmentedPurgeBodies`, the saved versions) */
export const listSegmentedVersionBodies: Member<'listSegmentedVersionBodies'> = (brain, sourceId, limit) =>
  storeCall({ member: 'listSegmentedVersionBodies' }, () => brain.listSegmentedPurgeBodies({ sourceId, store: 'page_versions', limit }));

export const countLegacyDerivedPages: Member<'countLegacyDerivedPages'> = (brain, sourceId) =>
  storeCall({ member: 'countLegacyDerivedPages' }, () => brain.countLegacyDerivedPages({ sourceId }));

/** (store `listPageSourcePaths`) */
export const listPageSourcePathsForPurge: Member<'listPageSourcePathsForPurge'> = async (brain, pageIds) => {
  const paths = await storeCall({ member: 'listPageSourcePathsForPurge' }, () => brain.listPageSourcePaths({ pageIds: [...pageIds] })) as string[];
  return paths.map(source_path => ({ source_path }));
};

/** (store `listFactNeighbours`) */
export const listNearestFactsForPurge: Member<'listNearestFactsForPurge'> = (brain, embedding, sourceId, model, fact) =>
  storeCall({ member: 'listNearestFactsForPurge' }, () => brain.listFactNeighbours({ embedding, sourceId, model, claim: fact }));

/** A store read has no statement deadline to set. */
export const setPurgeProbeTimeout: Member<'setPurgeProbeTimeout'> = async () => {};

export const countPurgeProbe: Member<'countPurgeProbe'> = async (brain, probe, rows) => {
  const route = probeRoute('countPurgeProbe', probe);
  if (route.kind === 'none') return 0;
  if (route.kind === 'receipt') return storeCall({ member: 'countPurgeProbe' }, () => brain.countPurgeStoreProbe({ probe: route.probe, rows }));
  return storeCall({ member: 'countPurgeProbe' }, () => brain.countPurgeProbe({ ...route.args, rows }));
};

export const listPurgeProbeItems: Member<'listPurgeProbeItems'> = async (brain, probe) => {
  const route = probeRoute('listPurgeProbeItems', probe);
  if (route.kind === 'none') return [];
  if (route.kind === 'receipt') return storeCall({ member: 'listPurgeProbeItems' }, () => brain.listPurgeStoreProbeItems({ probe: route.probe })) as Promise<string[]>;
  const items = await storeCall({ member: 'listPurgeProbeItems' }, () => brain.listPurgeProbeItems(route.args)) as string[] | null;
  if (items == null) return refuseMember('listPurgeProbeItems', `naming the ${probe.kind === 'named' ? probe.table : probe.kind} rows`);
  return items;
};
