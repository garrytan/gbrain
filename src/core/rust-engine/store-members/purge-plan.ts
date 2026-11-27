/**
 * The reads of a fact purge's plan, its dry run and `--match` (src/core/engine-sql/facts-purge.ts and
 * facts-purge-plan.ts), served from rust/crates/gbrain-store/src/facts/purge_plan.rs. Each member sends the arguments
 * of its BrainEngine member; the store call keeps its own name (the store method in parentheses below).
 *
 * Answered here, without a store call, because the store keeps no such rows:
 * - `listStagingPartEdges`: the raw upload parts (`page_body_staging_parts`) are not kept, so no part edge exists.
 * - `listDerivedRows` is facts-purge.ts's: the store keeps no derivation edges, so no row is derived.
 * - `setPurgeProbeTimeout`: a store read has no statement deadline to set.
 *
 * The inventory probes (`countPurgeProbe`, `listPurgeProbeItems`) send the probe's shape (purgeProbeShape). The store
 * answers the named probes (`links`, `timeline_entries`, `raw_data`) and the whole-table probes of every inventory
 * table it keeps (facts/purge_probe.rs `table_rows`, plus `wanted_links`); a table the store does not keep at all
 * holds no row (0, or no item). The swept stores a fact purge's receipt probes (the belief and generation ledgers, files, open
 * loops, page aliases, held writes, trust proposals, the effect queue and the segmented-body stores) stream their rows through
 * `for_each_table_row`, so a count stops at its bound. The store keeps no raw upload part, derivation sweep record or
 * retrieval event, feedback or weight record, so a probe of those finds nothing. The belief ledger's table probe is a plain
 * count of the store's own events; the receipt's ledger report reads the recorded values through lane 3's member instead
 * (`listBeliefEventsForPurgeProbe`, served by belief-purge.ts). A named `raw_data` probe names its rows by the `raw_data.id` the store keeps; it refuses
 * its item list only when a matching record was written before the store kept that id (its next putRawData adds one).
 *
 * A page purge receipt's store probes (engine-sql/purge-verify.ts) run through the same two members, as
 * `countPurgeStoreProbe` and `listPurgeStoreProbeItems` (facts/purge_store_probe.rs). The store answers `slug_key` for the
 * stores it keeps (pages, facts, take proposals, open loops, core edit notices, page and slug aliases, eval candidates, files, write-gate
 * holds, the mention gazetteer), `page_rows`, `fact_refs`, `trust_proposals`, `page_requests`, `page_segment_texts`, `segment_texts` and
 * `effect_payload`. It keeps no rows of the retrieval event, link, feedback and weight stores,
 * `context_volunteer_events` or `query_cache`, so a probe of one finds nothing without a store
 * call. The fact purge receipt's `fingerprint` probe (the fact, take and take proposal stores) and `claim_text` probe (pages,
 * chunks, versions and journal requests; facts/purge_claim_probe.rs) run there too. A `claim_text` probe of `core_edit_notices`
 * counts the base texts that quote the claim, as a `slug_key` probe of it counts the page's notices.
 */
import type { BrainEngine } from '../../engine.ts';
import { escapeFenceCell } from '../../fence-shared.ts';
import { purgeProbeShape } from '../../facts/purge-plan-statements.ts';
import type { PurgeProbe } from '../../engine-sql/facts-purge-plan.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { RECEIPT_ABSENT_SLUG_STORES, STORE_ABSENT_PROBE_TABLES } from './purge-absent-stores.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The inventory tables the store probes (facts/purge_plan.rs `PurgeProbeArgs::hits`, facts/purge_probe.rs). */
const STORE_PROBED_TABLES: ReadonlySet<string> = new Set([
  'links', 'timeline_entries', 'raw_data', 'wanted_links', 'calibration_profiles', 'decision_receipts', 'dream_verdicts',
  'eval_candidates', 'eval_contradictions_cache', 'eval_contradictions_runs', 'fact_relink_attempts', 'ingest_log',
  'mcp_request_log', 'mention_gazetteer_entries', 'minion_attachments', 'minion_inbox', 'minion_jobs', 'persistence_topology_changes',
  'subagent_messages', 'subagent_tool_executions', 'pinned_questions', 'context_volunteer_events',
  // The swept stores a fact purge's receipt probes (facts/purge_probe.rs `for_each_table_row`).
  'belief_events', 'derived_generations', 'derived_generation_items', 'files', 'open_loops', 'page_aliases', 'page_body_manifest', 'page_body_stagings',
  'page_body_staging_texts', 'page_segment_texts', 'page_segment_derivations', 'page_segment_derivation_purges', 'persistence_effects', 'trust_proposals', 'write_gate_holds',
]);

type ProbeRoute = { kind: 'none' } | { kind: 'store'; args: Record<string, unknown> } | { kind: 'receipt'; probe: Record<string, unknown> };

/**
 * The store's arguments for a page purge receipt's store probe (facts/purge_store_probe.rs `StoreProbe`), or none when the
 * store keeps no row of it. A probe of a store the store keeps must reach it: it never answers 0 for one.
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
    case 'fingerprint':
      return { kind: 'receipt', probe: {
        kind: 'fingerprint', store: probe.store, sourceId: probe.sourceId, factHash: probe.factHash,
        visibility: probe.visibility, subject: probe.subject } };
    case 'claim_text':
      return { kind: 'receipt', probe: {
        kind: 'claim_text', store: probe.store, sourceId: probe.sourceId, claim: probe.claim, json: probe.json,
        reason: probe.reason, reasonJson: probe.reasonJson } };
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

/** (store `listSegmentedPurgeBodies`, the live pages) */
export const listSegmentedPageBodies: Member<'listSegmentedPageBodies'> = (brain, sourceId, limit) =>
  storeCall({ member: 'listSegmentedPageBodies' }, () => brain.listSegmentedPurgeBodies({ sourceId, store: 'pages', limit }));

/** (store `listSegmentedPurgeBodies`, the saved versions) */
export const listSegmentedVersionBodies: Member<'listSegmentedVersionBodies'> = (brain, sourceId, limit) =>
  storeCall({ member: 'listSegmentedVersionBodies' }, () => brain.listSegmentedPurgeBodies({ sourceId, store: 'page_versions', limit }));

/**
 * (store `probePurgeDerivations`) One batch of the stored derivation results after `cursor`: the rows walked, the claim candidates,
 * those a sweep covers and holds the claim, those it does not, and the last key. The store walks from the cursor and stops at the batch.
 */
export const probePurgeDerivations: Member<'probePurgeDerivations'> = (brain, sourceId, needles, pageIds, patterns, cursor, rows) =>
  storeCall({ member: 'probePurgeDerivations' }, () => brain.probePurgeDerivations({
    sourceId, needles: [...needles], pageIds: [...pageIds], patterns: [...patterns],
    cursor: cursor ? { page: cursor[0], pipeline: cursor[1], occurrence: cursor[2] } : null, rows })) as ReturnType<Member<'probePurgeDerivations'>>;

/**
 * The claims' derivation forms: each claim normalized as the fact fingerprint does, then folded (a final sigma to sigma, a dotted
 * i to i), distinct, in byte order, none empty (store `listDerivationClaimForms`). No claim makes no store call.
 */
export const listDerivationClaimForms: Member<'listDerivationClaimForms'> = async (brain, claims) => {
  const list = [...new Set(claims.filter(Boolean))];
  if (!list.length) return [];
  return await storeCall({ member: 'listDerivationClaimForms' }, () => brain.listDerivationClaimForms({ claims: list })) as string[];
};

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

export const countPurgeProbe: Member<'countPurgeProbe'> = async (brain, probe, rows) => {
  // The SQL arms refuse a bad bound before they build a statement (boundedCountSql); so does a probe the store never sees.
  if (!Number.isSafeInteger(rows) || rows < 0) throw new Error('purge probe: the row bound must be a non-negative integer');
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
