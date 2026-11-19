/**
 * The private-provenance policy a fact read applies under `excludePrivate`, as the store reads it.
 *
 * PGLite renders the policy as SQL for the caller in context (src/core/search/private-visibility.ts). The store
 * implements one rendering: the one with no caller record (the empty identity, no satisfied folder rule, no lineage
 * read), less its two process settings, which travel as flags. A member renders its own PGLite fragment in the
 * current context and serves the read only when that text equals the no-caller text; any other caller (a member page,
 * a grant, a lineage or owner read, a labelled-only grant, a relaxed remote read) refuses with
 * `engine_capability_missing`.
 *
 * A page read under `excludePrivate` (pageReadFilter, src/core/search/read-policy-sql.ts) adds the page policy
 * `privatePagesFilterForCaller('p')` instead, which the entity gate of the fact policy applies to its entity page;
 * `storePagePolicy` refuses the same way and sends the same flags (`entityPrivacy` is then the privacy part of `p`).
 *
 * The concept-input test is rendered either inline or as a call of `gbrain_concept_inputs_private` (migration v311),
 * by the schema version the context carries. The two forms are the same test, so the comparison reads both as one.
 */
import { ownerOnlyPageSql } from '../../access/owner-only.ts';
import {
  privacyAliasSql,
  privatePagesFilterForCaller,
  privateSnapshotFilterFragment,
  withoutCallerAccess,
  privateProvenanceFilterUnderPolicy,
} from '../../search/private-visibility.ts';
import type { HybridSearchOpts, PostFusionOpts } from '../../search/hybrid.ts';
import type { PageReadScope } from '../../types.ts';
import { refuseMember } from './common.ts';

/** The policy flags the store reads (`PrivacyPolicy` in rust/crates/gbrain-store/src/facts/privacy.rs). */
export interface StorePrivacyPolicy {
  honorAliases: boolean;
  entityPrivacy: boolean;
  ownerOnly: StoreOwnerOnly;
}

/**
 * The owner-only part of the policy, as the baseline renders it (src/core/access/owner-only.ts): `lineage` is the v320
 * form (a page of an owner-only source, or a concept or question synthesized from one, is hidden), which a brain at or
 * above that schema version renders, and its v328 form with the login's read mode (always the exact lineage in the store,
 * which has no logins that row security narrows); `closed` is the form below v320 or outside an engine scope (any
 * owner-only source in the brain, or the held flag, hides every page). The part always applies to the no-caller baseline, whatever the other settings say.
 */
export type StoreOwnerOnly = 'lineage' | 'closed';

/** Which owner-only form `baseline` renders for the page alias `alias`; a text that holds neither refuses (the store has no third form). */
function ownerOnlyOf(member: string, baseline: string, alias: string): StoreOwnerOnly {
  if (baseline.includes(ownerOnlyPageSql(alias, 'fn')) || baseline.includes(ownerOnlyPageSql(alias, 'mode'))) return 'lineage';
  if (baseline.includes(ownerOnlyPageSql(alias, 'closed'))) return 'closed';
  return refuseMember(member, 'excludePrivate under an owner-only rule the store does not model');
}

/** The page aliases the policies judge: the fact policy's two, and `p` of a page read. */
const PAGE_ALIASES = ['pp', 'entity_pp', 'p'] as const;

/** `derivedPageSql(alias)` as derivedOriginPrivateSql opens its concept-input branch with it. */
const conceptBranchStart = (p: string): string =>
  `\n    WHEN (${p}.type IN ('atom', 'question') OR (${p}.type = 'concept' AND ${p}.frontmatter->>'synthesized_by' IS NOT NULL)) THEN `;
const conceptBranchEnd = (p: string): string => `\n    WHEN ${p}.type = 'event'`;

/** The policy text with each concept-input test, inline or a function call, read as one placeholder. */
export function normalizeConceptInputs(sql: string): string {
  let out = sql;
  for (const p of PAGE_ALIASES) {
    const start = conceptBranchStart(p);
    const end = conceptBranchEnd(p);
    let from = 0;
    for (;;) {
      const at = out.indexOf(start, from);
      if (at < 0) break;
      const body = at + start.length;
      const stop = out.indexOf(end, body);
      if (stop < 0) break;
      const marker = `<concept-inputs ${p}>`;
      out = out.slice(0, body) + marker + out.slice(stop);
      from = body + marker.length;
    }
  }
  return out;
}

/**
 * The store policy for a read under `excludePrivate`, or undefined when the read does not ask for it. `rendered` is
 * the fragment PGLite would add in the current context; a caller whose fragment is not the no-caller one refuses.
 */
export function storePrivacyPolicy(member: string, excludePrivate: unknown, rendered: () => string): StorePrivacyPolicy | undefined {
  if (excludePrivate !== true) return undefined;
  const baseline = withoutCallerAccess(() => privateProvenanceFilterUnderPolicy('facts'));
  if (normalizeConceptInputs(rendered()) !== normalizeConceptInputs(baseline)) {
    refuseMember(member, 'excludePrivate for a caller whose member pages, grants or lineage widen the policy');
  }
  return {
    honorAliases: baseline.includes(privacyAliasSql('pp')),
    entityPrivacy: baseline.includes(privateSnapshotFilterFragment('entity_pp')),
    ownerOnly: ownerOnlyOf(member, baseline, 'pp'),
  };
}

/**
 * The store policy for a page read (`pageReadFilter`'s `excludePrivate`), or undefined when the read does not ask for
 * it. The read's page alias is `p`; a caller whose `privatePagesFilterForCaller('p')` is not the no-caller one refuses.
 */
export function storePagePolicy(member: string, excludePrivate: unknown): StorePrivacyPolicy | undefined {
  if (!excludePrivate) return undefined;
  const baseline = withoutCallerAccess(() => privatePagesFilterForCaller('p'));
  if (normalizeConceptInputs(privatePagesFilterForCaller('p')) !== normalizeConceptInputs(baseline)) {
    refuseMember(member, 'excludePrivate for a caller whose member pages, grants or lineage widen the policy');
  }
  return {
    honorAliases: baseline.includes(privacyAliasSql('p')),
    entityPrivacy: baseline.includes(privateSnapshotFilterFragment('p')),
    ownerOnly: ownerOnlyOf(member, baseline, 'p'),
  };
}

/**
 * Every key hybridSearch's option bag carries that does not decide which pages a marker read may see: the search's own
 * settings, callbacks and internal flags, and `takesHoldersAllowList`, which only the takes reads honour. hybridSearch
 * hands the page-marker reads (stampContentFlags, stampUnverifiedExtractions) and the ranking reads
 * (getBacklinkCounts, getAdjacencyBoosts, supersedingPageSlugs) that whole bag as their policy, and PGLite
 * reads only the page policy out of it (src/core/search/read-policy-sql.ts), so these change nothing here. The list is
 * checked against the two option types below: a new key in either one fails the type check until it is listed.
 */
export const HYBRID_BAG_KEYS = [
  'expansion', 'anyWordFill', 'decide', 'aliasTokenHop', 'onRelationalMeta', 'mode', 'expandFn', 'expansionVariantBudget',
  'keywordArmConfidenceFloor', 'metadataBoostGate', 'rerankGate', 'pageRankCut', 'explainTarget', 'explain', 'rrfK', 'dedupOpts',
  'onMeta', 'onRerankPool', '_queryEmbedDeadline', '_queryPrefix', '_embeddingOptedOut', '_timings', 'queryEmbedFn',
  'onQueryEmbedding', '_telemetryCacheStatus', '_searchModeInput', 'limit', 'offset', 'onVectorPoolMeta', 'vectorLegacyGuard',
  'hnswIterativeScan', 'cjkKeyword', 'onKeywordIncomplete', 'adaptiveReturn', 'autocut', 'type', 'types', 'where',
  'exclude_slugs', 'exclude_slug_prefixes', 'source_boosts', 'include_slug_prefixes', 'detail', 'language', 'symbolKind',
  'nearSymbol', 'walkDepth', 'orFallback', 'orFill', 'keywordTimeoutCache', 'rankQuery', 'keywordPhrase', 'embeddingColumn',
  'afterDate', 'afterDateInclusive', 'beforeDate', 'beforeDateInclusive', 'recencyBoost', 'salience', 'recency', 'since',
  'until', 'tokenBudget', 'useCache', 'intentWeighting', 'reranker', 'floorRatio', 'crossModal', 'graph_signals',
  'relationalRetrieval', 'relationalRetrievalDepth', 'relationalRerankPin', 'relationalPlanner', 'relationalOrientOneHop',
  'relationalChainSlots', 'takesHoldersAllowList', 'applyBacklinks', 'decayMap', 'fallback', 'graphSignalsEnabled',
  'onGraphMeta', 'onScoreDistribution', 'query', 'titleBoost', 'skipMetadataBoosts',
] as const;
type BagKey = Exclude<keyof HybridSearchOpts | keyof PostFusionOpts, keyof PageReadScope>;
// Both directions: every listed key is a key of the bag, and every key of the bag that is not a page policy key is listed.
const HYBRID_BAG_KEYS_CHECKED: readonly BagKey[] = HYBRID_BAG_KEYS;
const HYBRID_BAG_KEYS_COMPLETE: [Exclude<BagKey, (typeof HYBRID_BAG_KEYS)[number]>] extends [never] ? true : never = true;
void HYBRID_BAG_KEYS_CHECKED;
void HYBRID_BAG_KEYS_COMPLETE;
