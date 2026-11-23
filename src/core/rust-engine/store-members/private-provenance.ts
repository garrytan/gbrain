/**
 * The private-provenance policy a fact read applies under `excludePrivate`, as the store reads it.
 *
 * PGLite renders the policy as SQL for the caller in context (src/core/search/private-visibility.ts). The store
 * implements the rendering with no caller record (the empty identity, no satisfied folder rule, no lineage read), less
 * its two process settings, which travel as flags. A member renders its own PGLite fragment in the current context and
 * serves the read only when that text equals the no-caller text of one of two forms: privateProvenanceFilterUnderPolicy
 * and privateFactFilterForCaller (what privateFactFilterForReader renders for a non-owner; with no caller it is the
 * same policy in another order). A fact family that opts in with `callerReaders` also
 * serves a fresh record of only a reader identity and a private-readable grant: the entity gate judges by both, and the
 * provenance page by the identity only on the caller's own member page (`memberPage`, the member-page case of
 * privateProvenanceFilterUnderPolicy; the other form has none). Any other caller (a folder rule, an audience, a lineage or owner read, a
 * labelled-only grant, a relaxed remote read) refuses with `engine_capability_missing`.
 *
 * A page read under `excludePrivate` (pageReadFilter, src/core/search/read-policy-sql.ts) adds the page policy
 * `privatePagesFilterForCaller('p')` instead, which the entity gate of the fact policy applies to its entity page;
 * `storePagePolicy` refuses the same way and sends the same flags (`entityPrivacy` is then the privacy part of `p`).
 * A page family that opts in with `callerReaders` also serves a caller whose record holds only a reader identity
 * (its member id and groups), a private-readable grant, and the folder rules it satisfies and the pending prefixes
 * its record holds: the member renders the page policy for a fresh record of just those, and when the caller's text
 * equals it, the store reads them from the policy (`readers_allowed`, `orPrivateReadableSource` and `FolderAccess` in
 * privacy.rs). An owner record (the local owner reading with privacy off, or a remote owner reading its own lineage)
 * is served when its text equals the same record's rendering with the owner fields: that text has no owner-only test
 * (`ownerOnly` off) and, for the local owner, no privacy part (`entityPrivacy` false, and `provenancePrivacyOff` for a
 * fact policy). Lineage, labelled-only grants and relaxed reads still refuse.
 *
 * Every text the store serves ends with the owner-only test (access/owner-only.ts), in the `fn` or the `closed` form
 * by the schema version the context carries; `ownerOnly` sends the form the text holds (owner_only.rs).
 *
 * A remote read on a brain that holds no member restriction (config access.restrictions_present unset, so
 * `CallerAccess.restricted` is false) renders the short member-access form `page_readers IS NULL AND
 * folder_rule_ids IS NULL`: no page that names readers, no origin walk. The member compares such a caller's text with
 * the forms rendered under `restricted: false` and sends `open` (privacy.rs `readers_allowed`). The store's own flag
 * then decides: unset, it applies the short form as written; set (the caller's flag read was stale, or an operator
 * cleared the config row), it applies the short form and the full form's origin walk too, so the read is never wider
 * than either form. The Rust page write sets the flag (access_flag.rs), so a Rust brain that once held a `readable_by`
 * page renders the full form unless the caller's read was stale.
 *
 * The concept-input test is rendered either inline or as a call of `gbrain_concept_inputs_private` (migration v311),
 * by the schema version the context carries. The two forms are the same test, so the comparison reads both as one.
 */
import {
  type CallerAccess,
  currentCallerAccess,
  privacyAliasSql,
  privatePagesFilterForCaller,
  privateSnapshotFilterFragment,
  withCallerAccess,
  withoutCallerAccess,
  privateProvenanceFilterUnderPolicy,
  privateFactFilterForCaller,
  remoteProvenanceFloorSql,
} from '../../search/private-visibility.ts';
import { MEMBER_PAGE_PREFIX } from '../../access/principals.ts';
import { ownerOnlyFactSql, ownerOnlyPageSql, ownerOnlyTakeSql, ownerOnlyTimelineSql } from '../../access/owner-only.ts';
import type { HybridSearchOpts, PostFusionOpts } from '../../search/hybrid.ts';
import type { PageReadScope } from '../../types.ts';
import { refuseMember } from './common.ts';

/** The policy flags the store reads (`PrivacyPolicy` in rust/crates/gbrain-store/src/facts/privacy.rs). */
export interface StorePrivacyPolicy {
  honorAliases: boolean;
  entityPrivacy: boolean;
  /** The caller's reader principals; empty for the no-caller policy. */
  identity?: string[];
  /** The sources whose private pages the caller reads; empty for the no-caller policy. */
  privateReadableSources?: string[];
  /** The fact policy's member-page case: the caller's own member page, the one provenance page judged by `identity`. */
  memberPage?: string;
  /** The remote floor (`remoteProvenanceFloorSql`): the provenance page only, with no entity or holding-page gate. */
  provenanceOnly?: boolean;
  /** The owner-only test the text ends with (ownerOnlyAllowedSql / ownerOnlyFactAllowedSql), by form; 'off' when it has none. */
  ownerOnly: StoreOwnerOnlyForm;
  /**
   * The caller renders the short member-access form (`CallerAccess.restricted` false); the store's flag
   * (`access.restrictions_present`) decides the rest (`open` in privacy.rs).
   */
  open?: boolean;
  /** The folder rules the caller satisfies (`CallerAccess.satisfiedRuleIds`, `source:rule_id`); a page under only these passes. */
  satisfiedRuleIds?: string[];
  /** The prefixes the caller's record reads as nobody (`CallerAccess.folderCoverage`): a page under one is hidden. */
  folderCoverage?: { source_id: string; prefix: string }[];
  /** A local owner's fact policy with privacy off: the provenance page is judged with no privacy part. */
  provenancePrivacyOff?: boolean;
}

/** `OwnerOnlyForm` (access/owner-only.ts), plus 'off' for a text with no owner-only test (`OwnerOnlyForm` in owner_only.rs). */
export type StoreOwnerOnlyForm = 'fn' | 'closed' | 'off';

/**
 * The form of the owner-only test in a rendered policy whose row alias is `alias` (`pages` for a page policy, `facts`
 * for a fact policy, `takes` or `timeline_entries` for a row's own test): the v320 function call (or its v328 form with the login's read mode, always the exact lineage in the
 * store), the closed test (any owner-only source or the held flag), or none. The same text never holds two forms (one
 * schema version renders both conjuncts), so the first match decides.
 */
export function ownerOnlyFormIn(sql: string, table: 'pages' | 'facts' | 'takes' | 'timeline_entries', alias: string): StoreOwnerOnlyForm {
  const render = { pages: ownerOnlyPageSql, facts: ownerOnlyFactSql, takes: ownerOnlyTakeSql, timeline_entries: ownerOnlyTimelineSql }[table];
  const rendered = (form: 'mode' | 'fn' | 'closed') => render(alias, form);
  if (sql.includes(rendered('fn')) || sql.includes(rendered('mode'))) return 'fn';
  return sql.includes(rendered('closed')) ? 'closed' : 'off';
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

/** The two fact policies the store implements, rendered in the current context. */
const FACT_FORMS = [
  { sql: privateProvenanceFilterUnderPolicy, memberCase: true },
  { sql: privateFactFilterForCaller, memberCase: false },
] as const;

/**
 * The store policy for a read under `excludePrivate`, or undefined when the read does not ask for it. `rendered` is
 * the fragment PGLite would add in the current context: privateProvenanceFilterUnderPolicy('facts'), or
 * privateFactFilterForReader('facts'), which is privateFactFilterForCaller('facts') for a caller that is not the owner.
 * The store serves the read when that text equals one of the two forms with no caller record or, for a family that opts
 * in with `callerReaders`, for a fresh record of just the caller's reader identity and private-readable grant. Under
 * that record the first form judges the caller's own member page by the identity (`memberPage`); the second has no
 * member-page case. The caller is judged by judgeWidenedCaller, so a caller on a brain that never named readers
 * (`restricted` false), anonymous or with a member identity, is also served under the restricted rendering. A caller
 * that renders the short member-access form (`restricted` false) is compared with references in that form, and its
 * policy carries `open`, so the store hides every page that names readers whoever the caller is, as the short form
 * does; a member identity retried under the restricted rendering keeps `open` too. Any other caller refuses.
 */
export function storePrivacyPolicy(
  member: string,
  excludePrivate: unknown,
  rendered: () => string,
  opts: { callerReaders?: boolean } = {},
): StorePrivacyPolicy | undefined {
  if (excludePrivate !== true) return undefined;
  const openFlag = currentCallerAccess().restricted === false ? { open: true } : {};
  const policy = judgeWidenedCaller<StorePrivacyPolicy>(readers => {
    const open = currentCallerAccess().restricted === false;
    const text = normalizeConceptInputs(rendered());
    for (const form of FACT_FORMS) {
      const baseline = renderForStoreCaller(open ? { restricted: false } : {}, () => form.sql('facts'));
      if (text === normalizeConceptInputs(baseline)) return factPolicyFlags(baseline);
    }
    if (!opts.callerReaders) return undefined;
    const own = readers.identity.find(p => p.startsWith('member:'))?.slice('member:'.length);
    // The reader record, then (for an owner) the same record with the owner fields; each compared by its exact text.
    const access = currentCallerAccess();
    const records: Array<Partial<CallerAccess>> = [{ ...readers, hidePrivate: true, restricted: !open }];
    if (access.owner) {
      records.push({ ...readers, hidePrivate: access.hidePrivate, restricted: !open, owner: true, ...(access.ownerReads ? { ownerReads: true } : {}) });
    }
    for (const record of records) {
      for (const form of FACT_FORMS) {
        const canonical = renderForStoreCaller(record, () => form.sql('facts'));
        if (text !== normalizeConceptInputs(canonical)) continue;
        const memberPage = own === undefined ? undefined : `${MEMBER_PAGE_PREFIX}${own}`;
        const judged = form.memberCase && memberPage !== undefined && canonical.includes(`pp.slug = '${memberPage}'`);
        // A local owner reading with privacy off renders no privacy part on the provenance page either.
        const provenancePrivacyOff = record.owner === true && !canonical.includes(privateSnapshotFilterFragment('pp'));
        return { ...factPolicyFlags(canonical), ...readers, ...(judged ? { memberPage } : {}), ...(provenancePrivacyOff ? { provenancePrivacyOff: true } : {}) };
      }
    }
    return undefined;
  });
  if (policy) return { ...policy, ...openFlag };
  refuseMember(member, 'excludePrivate for a caller whose member pages, grants or lineage widen the policy');
}

/**
 * The store policy for the remote provenance floor, remoteProvenanceFloorSql('facts'): the provenance page judged by
 * the plain page fragment (alias pp, world flag on), which reads no caller identity, plus the owner-only conjunct. The
 * store serves it when the text equals the no-caller rendering (judgeWidenedCaller); a labelled-only caller (its
 * own conjunct) or an owner read refuses.
 */
export function storeFloorPolicy(member: string): StorePrivacyPolicy {
  const policy = judgeWidenedCaller<StorePrivacyPolicy>(() => {
    const text = normalizeConceptInputs(remoteProvenanceFloorSql('facts'));
    const baseline = renderForStoreCaller({}, () => remoteProvenanceFloorSql('facts'));
    return text === normalizeConceptInputs(baseline) ? { ...factPolicyFlags(baseline), entityPrivacy: false, provenanceOnly: true } : undefined;
  });
  if (policy) return policy;
  refuseMember(member, 'the remote provenance floor for a caller whose labelled-only grant or owner read changes it');
}

/** The process-setting flags of a rendered fact policy, and its owner-only form. */
function factPolicyFlags(sql: string): StorePrivacyPolicy {
  return {
    honorAliases: sql.includes(privacyAliasSql('pp')),
    entityPrivacy: sql.includes(privateSnapshotFilterFragment('entity_pp')),
    ownerOnly: ownerOnlyFormIn(sql, 'facts', 'facts'),
  };
}

/**
 * The store policy for a page read (`pageReadFilter`'s `excludePrivate`), or undefined when the read does not ask for
 * it. The read's page alias is `p`; a caller whose `privatePagesFilterForCaller('p')` is not the no-caller one refuses.
 */
export function storePagePolicy(
  member: string,
  excludePrivate: unknown,
  opts: { callerReaders?: boolean } = {},
): StorePrivacyPolicy | undefined {
  if (!excludePrivate) return undefined;
  return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), opts);
}

/**
 * The store page policy for a read whose page fragment over `p` is `rendered` in the current context: the caller's
 * page policy, or the remote read floor (`remoteReadFloorSql('p')`, which with no labelled-only caller is the
 * no-caller page policy). A family that opts in with `callerReaders` also serves the caller's reader identities,
 * private-readable sources, satisfied folder rules and folder coverage when the fragment is the canonical one for them. A
 * family whose fragment never reads the caller's readers (`privatePagesFilterFragment`, the no-caller policy a `world`
 * mark reports) opts in with `noReaders`: inside a caller record that fragment renders as the canonical policy of a
 * record with no readers, which it is served as. Any other fragment refuses. A `restricted: false` caller is judged
 * under the short form and sent as `open` (see the head of this file).
 */
export function storePageTextPolicy(
  member: string,
  rendered: () => string,
  opts: { callerReaders?: boolean; noReaders?: boolean } = {},
): StorePrivacyPolicy {
  const open = currentCallerAccess().restricted === false;
  const openFlag = open ? { open: true } : {};
  const text = normalizeConceptInputs(rendered());
  const baseline = renderForStoreCaller(open ? { restricted: false } : {}, () => privatePagesFilterForCaller('p'));
  if (text === normalizeConceptInputs(baseline)) return { ...pagePolicyFlags(baseline), ...openFlag };
  if (opts.callerReaders || opts.noReaders) {
    const access = currentCallerAccess();
    const readers = opts.noReaders ? { identity: [], privateReadableSources: [] }
      : { identity: [...access.identity], privateReadableSources: [...access.privateReadableSources] };
    const folders = opts.noReaders ? { satisfiedRuleIds: [], folderCoverage: [] } : {
      satisfiedRuleIds: [...access.satisfiedRuleIds],
      folderCoverage: access.folderCoverage.map(c => ({ source_id: c.source_id, prefix: c.prefix })),
    };
    const canonical = renderForStoreCaller({ ...readers, ...folders, hidePrivate: true, restricted: !open }, () => privatePagesFilterForCaller('p'));
    const stored = {
      ...(folders.satisfiedRuleIds.length ? { satisfiedRuleIds: folders.satisfiedRuleIds } : {}),
      ...(folders.folderCoverage.length ? { folderCoverage: folders.folderCoverage } : {}),
    };
    if (text === normalizeConceptInputs(canonical)) return { ...pagePolicyFlags(canonical), ...readers, ...stored, ...openFlag };
    // An owner record (the local owner, or a remote owner reading its own lineage): the same record with the owner
    // fields, compared by its exact text. Its text holds no owner-only test, and the local owner's no privacy part, so
    // the flags read off it (`owner_only` off, `entity_privacy` false) are what the text applies.
    if (opts.callerReaders && access.owner) {
      const owner = renderForStoreCaller({ ...readers, ...folders, hidePrivate: access.hidePrivate, restricted: !open, owner: true,
        ...(access.ownerReads ? { ownerReads: true } : {}) }, () => privatePagesFilterForCaller('p'));
      if (text === normalizeConceptInputs(owner)) return { ...pagePolicyFlags(owner), ...readers, ...stored, ...openFlag };
    }
  }
  refuseMember(member, 'excludePrivate for a caller whose member pages, grants or lineage widen the policy');
}

/** The reader record a store policy carries for a widening caller (`identity` and `privateReadableSources` in privacy.rs). */
export interface StoreCallerReaders {
  identity: string[];
  privateReadableSources: string[];
}

/**
 * The widened-caller step of the member-access policy (page-visibility.ts), which the page and fact policies above do
 * without: they send the short form as `open` and the store's flag decides. `judge` compares
 * the caller's rendered text with reference renderings (renderForStoreCaller) and returns the store policy for the
 * one it equals, or undefined. It runs with the caller's reader record (its reader identities and private-readable
 * sources), in the caller's context.
 *
 * When nothing matches and the caller is on a brain whose config holds no member-access restriction (restricted:
 * false, the short member-access form the MCP stdio server's caller renders), anonymous or with a reader identity,
 * `judge` runs again under the restricted rendering. The restricted rendering only adds conditions that need a page
 * with readers, a folder rule or a pending folder prefix; each of those sets the store's sticky restriction flag
 * (access.restrictions_present), which restricted: false says is unset, so it hides the same pages and rows. The
 * identity reaches a policy only through a page's readers (readersAllowedSql, the member-page case of
 * privateProvenanceFilterUnderPolicy, memberFactAdmitSql), and no page names readers there, so the restricted
 * rendering with that identity hides what the short form, which reads no identity, hides. Undefined when neither run
 * matches: the member refuses.
 */
export function judgeWidenedCaller<T>(judge: (readers: StoreCallerReaders) => T | undefined): T | undefined {
  const access = currentCallerAccess();
  const readers = { identity: [...access.identity], privateReadableSources: [...access.privateReadableSources] };
  const served = judge(readers);
  if (served !== undefined) return served;
  if (access.restricted) return undefined;
  return withCallerAccess({ restricted: true }, () => judge(readers));
}

/**
 * The page policy the store judges a page by for a fresh caller record of just `readers` (privatePagesFilterForCaller
 * with hidePrivate on): the reference storePageTextPolicy serves a `callerReaders` family under, as `page_hidden` in
 * privacy.rs reads it.
 */
export function callerReadersPagePolicy(readers: StoreCallerReaders): StorePrivacyPolicy {
  const canonical = renderForStoreCaller({ ...readers, hidePrivate: true }, () => privatePagesFilterForCaller('p'));
  return { ...pagePolicyFlags(canonical), ...readers };
}

/**
 * `render` for a fresh caller record of just `record`, as a reference the caller's text is compared with. The record
 * keeps the caller's remote policy, whose schema version picks the owner-only and concept-input forms
 * (readSchemaVersion), so a request whose engine scope has not recorded the version renders its reference in the
 * same forms as its own text. The store reads the owner-only form off the matched text. An empty record with no
 * remote policy renders outside any caller record, as the no-caller baseline always has.
 */
export function renderForStoreCaller<T>(record: Partial<CallerAccess>, render: () => T): T {
  const remotePolicy = currentCallerAccess().remotePolicy;
  const fresh: Partial<CallerAccess> = { ...(remotePolicy ? { remotePolicy } : {}), ...record };
  return withoutCallerAccess(() => Object.keys(fresh).length === 0 ? render() : withCallerAccess(fresh, render));
}

/** The process-setting flags of a rendered page policy, and its owner-only form. */
export function pagePolicyFlags(sql: string): StorePrivacyPolicy {
  return {
    honorAliases: sql.includes(privacyAliasSql('p')),
    entityPrivacy: sql.includes(privateSnapshotFilterFragment('p')),
    ownerOnly: ownerOnlyFormIn(sql, 'pages', 'p'),
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
/** `WhoknowsOpts` keys whoknows passes with its read policy (src/commands/whoknows.ts) beyond the hybrid bag; the page reads never read them. */
export const WHOKNOWS_KEYS = ['topic'] as const;
type BagKey = Exclude<keyof HybridSearchOpts | keyof PostFusionOpts, keyof PageReadScope>;
// Both directions: every listed key is a key of the bag, and every key of the bag that is not a page policy key is listed.
const HYBRID_BAG_KEYS_CHECKED: readonly BagKey[] = HYBRID_BAG_KEYS;
const HYBRID_BAG_KEYS_COMPLETE: [Exclude<BagKey, (typeof HYBRID_BAG_KEYS)[number]>] extends [never] ? true : never = true;
void HYBRID_BAG_KEYS_CHECKED;
void HYBRID_BAG_KEYS_COMPLETE;
