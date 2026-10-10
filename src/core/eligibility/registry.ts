/**
 * ENG-14: how every read-scope operation handles trust, and which surfaces
 * inject memory proactively (activation control, CEO-20).
 *
 * Classes:
 * - `filtered`: applies the effective read floor (token floor and the
 *   caller's `min_trust` param, eligibility/policy.ts) inside its SQL before
 *   LIMIT, hides quarantined-page projections, and labels each item with
 *   `trust_tier` + `origin`. Declares the `min_trust` param.
 * - `labeled`: returns stored memory text without a per-row floor. A
 *   connection with a token floor is refused (fail-closed) instead of being
 *   served rows below its floor.
 * - `text_free`: returns no stored memory text (identity, counts, status,
 *   schema, catalog), so trust does not apply.
 *
 * `test/eligibility-registry.test.ts` fails when a read-scope operation is
 * missing here, when a `filtered` op lacks `min_trust`, and when a proactive
 * surface stops calling `proactiveEligibility` with its registered id.
 */
import { opError, type AuthInfo, type Operation } from '../ops/contract.ts';
import { trustLabel } from '../trust/tier.ts';
import { resolveReadEligibility, type EligibilityCaller, type ReadEligibility, type TrustReadConfig } from './policy.ts';

export type ReadTrustHandling = 'filtered' | 'labeled' | 'text_free';

export const OP_READ_TRUST: Readonly<Record<string, ReadTrustHandling>> = {
  // memory verbs and retrieval
  recall: 'filtered', context_pack: 'filtered', delta: 'filtered',
  search: 'filtered', query: 'filtered', get_page: 'filtered', fetch: 'filtered',
  get_chunks: 'filtered', get_timeline: 'filtered', takes_list: 'filtered', takes_search: 'filtered',
  assemble_evidence: 'filtered',
  entity: 'labeled', synthesize: 'labeled', think: 'labeled',
  search_by_image: 'labeled', list_pages: 'labeled', volunteer_context: 'filtered',
  get_versions: 'labeled', get_raw_data: 'labeled', resolve_slugs: 'labeled',
  get_recent_salience: 'labeled', find_anomalies: 'labeled', get_recent_transcripts: 'labeled',
  find_orphans: 'labeled', traverse_graph: 'labeled', get_links: 'labeled', get_backlinks: 'labeled',
  wanted_pages: 'labeled', get_tags: 'labeled', get_ingest_log: 'labeled',
  chronicle_day: 'labeled', chronicle_on_this_day: 'labeled', chronicle_since: 'labeled', chronicle_last_seen: 'labeled',
  ontology_get: 'labeled', ontology_dimensions: 'labeled', ontology_conflicts: 'labeled', volunteer_chronicle: 'labeled',
  extraction_pending: 'labeled', entity_identity_list: 'labeled', find_contradictions: 'labeled',
  find_experts: 'labeled', find_trajectory: 'labeled', takes_scorecard: 'labeled', takes_calibration: 'labeled',
  open_loops: 'labeled', schema_review_orphans: 'labeled',
  code_callers: 'labeled', code_callees: 'labeled', code_def: 'labeled', code_refs: 'labeled', code_blast: 'labeled', code_flow: 'labeled',
  // no stored memory text
  search_modes: 'text_free', list_link_sources: 'text_free', get_brain_identity: 'text_free',
  list_skills: 'text_free', get_skill: 'text_free', list_brain_skillpack: 'text_free', advisor: 'text_free',
  get_skill_asset: 'text_free', join_brain: 'text_free', sync_brain_skills: 'text_free', leave_brain: 'text_free',
  get_calibration_profile: 'text_free', whoami: 'text_free', sources_list: 'text_free', sources_status: 'text_free',
  sources_inspect: 'text_free', request_tools: 'text_free', connectors_status: 'text_free',
  get_active_schema_pack: 'text_free', list_schema_packs: 'text_free', schema_stats: 'text_free', schema_lint: 'text_free',
  schema_graph: 'text_free', schema_explain_type: 'text_free',
};

/** The class an op resolves to; an unlisted read op is held to the strictest (`labeled`) rule. */
export function readTrustHandling(op: Pick<Operation, 'name'>): ReadTrustHandling {
  return OP_READ_TRUST[op.name] ?? 'labeled';
}

/**
 * Dispatcher backstop (CEO-18): a connection carrying a token floor may only
 * call read ops that enforce it (`filtered`) or return no memory text.
 */
export function enforceReadTrustFloor(auth: Pick<AuthInfo, 'minTrust'> | undefined, op: Pick<Operation, 'name' | 'scope'>): void {
  if (!auth?.minTrust || (op.scope ?? 'read') !== 'read' || readTrustHandling(op) !== 'labeled') return;
  throw opError('permission_denied',
    `${op.name} cannot enforce this connection's trust floor (${trustLabel(auth.minTrust)} or higher), so it is not available here.`,
    'Use search, query, recall, get_page, fetch, context_pack or delta, which return only rows at or above the floor.',
    { why: 'The brain owner set a minimum trust tier for this connection; operations that cannot filter by tier are refused rather than returning rows below it.' });
}

// ---------------------------------------------------------------------------
// Proactive surfaces (CEO-20, DX-10)
// ---------------------------------------------------------------------------

export const PROACTIVE_SURFACES = {
  'hook.user_prompt': 'src/core/context/turn-context.ts',
  context_engine: 'src/core/context/reflex.ts',
  context_pack: 'src/core/ops/facts.ts',
  volunteer: 'src/core/context/volunteer.ts',
  retrieval_reflex: 'src/core/context/retrieval-reflex.ts',
  core_delivery: 'src/core/core-memory.ts',
  hot_memory: 'src/core/facts/meta-hook.ts',
} as const;
export type ProactiveSurface = keyof typeof PROACTIVE_SURFACES;

/** The eligibility a proactive surface applies: the read floor plus activation control. */
export async function proactiveEligibility(
  ctx: EligibilityCaller,
  surface: ProactiveSurface,
  opts: { minTrust?: unknown; config?: TrustReadConfig } = {},
): Promise<ReadEligibility & { surface: ProactiveSurface }> {
  return { ...await resolveReadEligibility(ctx, { ...opts, proactive: true }), surface };
}
