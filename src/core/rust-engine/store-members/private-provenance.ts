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
  callerAccessAllowedSql,
  currentCallerAccess,
  privacyAliasSql,
  privatePagesFilterForCaller,
  privateSnapshotFilterFragment,
  withCallerAccess,
  withoutCallerAccess,
  privateProvenanceFilterUnderPolicy,
  privateFactFilterForCaller,
  privateFactFilterForReader,
  privatePagesFilterFragment,
  privacyPartSql,
  remoteProvenanceFloorSql,
  remoteReadFloorSql,
  readPolicyFragment,
  ownerReadPolicyFragment,
} from '../../search/private-visibility.ts';
import type { RetirementPrivacy } from '../../engine-sql/entity-reads.ts';
import type { ReflexPrivacy } from '../../engine-sql/reflex-reads.ts';
import { MEMBER_PAGE_PREFIX } from '../../access/principals.ts';
import { ownerOnlyFactSql, ownerOnlyPageSql, ownerOnlyTakeSql, ownerOnlyTimelineSql } from '../../access/owner-only.ts';
import type { HybridSearchOpts, PostFusionOpts } from '../../search/hybrid.ts';
import type { PageReadScope } from '../../types.ts';
import { refuseMember } from './common.ts';
import { accessDerivationOn, accessSelfCheckMismatch, selfChecked } from '../access-self-check.ts';

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
  /** The owner read rule (`ownerReadPolicyFragment`): a derived page's origins are judged by `identity`. */
  ownerRead?: boolean;
  /** The folder rules the caller satisfies (`CallerAccess.satisfiedRuleIds`, `source:rule_id`); a page under only these passes. */
  satisfiedRuleIds?: string[];
  /** The prefixes the caller's record reads as nobody (`CallerAccess.folderCoverage`): a page under one is hidden. */
  folderCoverage?: { source_id: string; prefix: string }[];
  /**
   * The text is a caller record's rendering: `folderCoverage` is the whole pending test (`coverageSql` inside a record
   * renders no live conjunct), so a prefix the store holds pending that the record does not name hides nothing.
   */
  callerRecord?: boolean;
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

/**
 * The page fragment a page-text policy renders (`PageFragment` in rust/crates/gbrain-store/src/access_derive.rs):
 * the caller's page policy, the remote read floor, or the no-caller fragment (which `readPolicyFragment('p', [], true)`
 * renders too). Only the self-check reads it; it checks the label against the rendered text first.
 */
export type StorePageFragment = 'caller' | 'floor' | 'plain';
/** The fact fragment a fact policy renders (`FactFragment` in access_derive.rs). */
export type StoreFactFragment = 'under_policy' | 'for_caller' | 'for_reader';

const PAGE_FRAGMENTS: Readonly<Record<StorePageFragment, () => string>> = {
  caller: () => privatePagesFilterForCaller('p'),
  floor: () => remoteReadFloorSql('p'),
  plain: () => privatePagesFilterFragment('p'),
};
const FACT_FRAGMENTS: Readonly<Record<StoreFactFragment, () => string>> = {
  under_policy: () => privateProvenanceFilterUnderPolicy('facts'),
  for_caller: () => privateFactFilterForCaller('facts'),
  for_reader: () => privateFactFilterForReader('facts'),
};

/** Under the self-check: the call site's fragment label renders the call site's own text, or the read refuses. */
function checkFragment(member: string, mode: string, rendered: () => string, labelled: (() => string) | undefined): void {
  if (!labelled) throw accessSelfCheckMismatch(member, mode, '$fragment (no label)');
  if (normalizeConceptInputs(rendered()) !== normalizeConceptInputs(labelled())) throw accessSelfCheckMismatch(member, mode, '$fragment');
}

/** The no-caller page policy's flags (`pagePolicyFlags(privatePagesFilterFragment('p'))`), derived by the store under the multi-user switch. */
export function plainPageFlags(member: string): StorePrivacyPolicy {
  return selfChecked(member, { mode: 'plain_page_flags' }, () => pagePolicyFlags(privatePagesFilterFragment('p')));
}

/** Whether the privacy part honours the aliases (`pagePolicyFlags(privacyPartSql('p')).honorAliases`), derived by the store under the multi-user switch. */
export function privacyPartAliases(member: string): boolean {
  return selfChecked(member, { mode: 'privacy_part_aliases' }, () => pagePolicyFlags(privacyPartSql('p')).honorAliases);
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
  opts: { callerReaders?: boolean; fragment?: StoreFactFragment } = {},
): StorePrivacyPolicy | undefined {
  if (!accessDerivationOn()) return storePrivacyPolicyRendered(member, excludePrivate, rendered, opts);
  checkFragment(member, 'fact', rendered, opts.fragment ? FACT_FRAGMENTS[opts.fragment] : undefined);
  return selfChecked(member, { mode: 'fact', excludePrivate: excludePrivate === true, fragment: opts.fragment!, callerReaders: opts.callerReaders === true },
    () => storePrivacyPolicyRendered(member, excludePrivate, rendered, opts));
}

function storePrivacyPolicyRendered(
  member: string,
  excludePrivate: unknown,
  rendered: () => string,
  opts: { callerReaders?: boolean },
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
      records.push({ ...readers, hidePrivate: access.hidePrivate, restricted: !open, owner: true, ...(access.ownerReads ? { ownerReads: access.ownerReads } : {}) });
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
 * store serves the no-caller rendering, and the rendering for a fresh record of the caller's `restricted` and `owner`
 * settings and remote policy: a caller record has no live pending-coverage test, an owner read drops the owner-only
 * test, and `restricted: false` renders the short member-access form (the store's `open`). A labelled-only caller, folder
 * coverage or a relaxed privacy setting renders other text and refuses.
 */
export function storeFloorPolicy(member: string): StorePrivacyPolicy {
  return selfChecked(member, { mode: 'floor_policy' }, () => storeFloorPolicyRendered(member));
}

function storeFloorPolicyRendered(member: string): StorePrivacyPolicy {
  const text = normalizeConceptInputs(remoteProvenanceFloorSql('facts'));
  const floor = (sql: string, open: boolean): StorePrivacyPolicy =>
    ({ ...factPolicyFlags(sql), entityPrivacy: false, provenanceOnly: true, ...(open ? { open: true } : {}) });
  const unscoped = withoutCallerAccess(() => remoteProvenanceFloorSql('facts'));
  if (text === normalizeConceptInputs(unscoped)) return floor(unscoped, false);
  const { restricted, owner } = currentCallerAccess();
  const fresh = renderForStoreCaller({ restricted, owner }, () => remoteProvenanceFloorSql('facts'));
  if (text === normalizeConceptInputs(fresh)) return floor(fresh, !restricted);
  refuseMember(member, 'the remote provenance floor for a caller whose labelled-only grant, folder coverage or relaxed privacy changes it');
}

/**
 * The store policy for the page policy of a page's member, `readPolicyFragment('pp', identity, true, satisfied)`: what
 * `readMemberPageWithdrawal` judges the provenance and entity pages by, for the member whose page a save lands on (not
 * the caller's own record). The store serves it for a member that meets no folder rule: a satisfied folder rule is not
 * modelled, so it refuses. For the brain owner it is the owner read rule ({@link storeOwnerReadPolicy}).
 * The text is compared with the same fragment for a fresh record of the caller's remote policy (the one that picks the
 * owner-only and concept-input forms), under the short member-access form when the caller renders it (`open`). An
 * identity the fragment drops as invalid (`validIdentity`) refuses, as the store would apply it as written.
 */
export function storeMemberReadPolicy(member: string, q: { owner: boolean; identity: readonly string[]; satisfied: readonly string[] }): StorePrivacyPolicy {
  return selfChecked(member, { mode: 'member_read', owner: q.owner, identity: [...q.identity], satisfied: [...q.satisfied] },
    () => storeMemberReadPolicyRendered(member, q));
}

function storeMemberReadPolicyRendered(member: string, q: { owner: boolean; identity: readonly string[]; satisfied: readonly string[] }): StorePrivacyPolicy {
  if (q.satisfied.length > 0) refuseMember(member, 'a member page whose reader meets a folder rule');
  if (q.owner) return storeOwnerReadPolicyRendered(member, q.identity);
  const text = normalizeConceptInputs(readPolicyFragment('p', q.identity, true, q.satisfied));
  const open = currentCallerAccess().restricted === false;
  const reference = renderForStoreCaller(open ? { restricted: false } : {}, () => readPolicyFragment('p', q.identity, true, []));
  const named = open || q.identity.every(id => text.includes(`'${id}'`));
  if (text === normalizeConceptInputs(reference) && named) {
    return { ...pagePolicyFlags(reference), identity: [...q.identity], ...(open ? { open: true } : {}) };
  }
  refuseMember(member, 'a member page read whose policy is not the one the store models');
}

/**
 * The owner read rule, `ownerReadPolicyFragment('pp', identity, [])` (GST-2346, GST-2490 with the opt-in off): the
 * owner's readers and the privacy part, with a derived page's origins judged by the owner's identity
 * (`gbrain_access_origin_hidden_for`, the store's `ownerRead`) and no owner-only test. The text is compared with the
 * same fragment for a fresh record of the caller's remote policy. An identity with no valid member principal renders
 * `FALSE` (the owner reads no page but its own) and refuses, and so does an identity the fragment drops as invalid.
 */
function storeOwnerReadPolicyRendered(member: string, identity: readonly string[]): StorePrivacyPolicy {
  const text = normalizeConceptInputs(ownerReadPolicyFragment('p', identity, []));
  const reference = normalizeConceptInputs(renderForStoreCaller({}, () => ownerReadPolicyFragment('p', identity, [])));
  const named = identity.every(id => text.includes(`'${id}'`));
  if (text !== 'FALSE' && text === reference && named) {
    const flags = pagePolicyFlags(reference);
    if (flags.ownerOnly === 'off') return { ...flags, identity: [...identity], ownerRead: true };
  }
  refuseMember(member, 'an owner read of a member page whose policy is not the one the store models');
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
  return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { ...opts, fragment: 'caller' });
}

/**
 * The store page policy for a read whose page fragment over `p` is `rendered` in the current context: the caller's
 * page policy, or the remote read floor (`remoteReadFloorSql('p')`, which with no labelled-only caller is the
 * no-caller page policy). A family that opts in with `callerReaders` also serves the caller's reader identities,
 * private-readable sources, satisfied folder rules and folder coverage when the fragment is the canonical one for them.
 * A family whose fragment never reads the caller's readers (`privatePagesFilterFragment`, the no-caller policy a
 * `world` mark reports) opts in with `noReaders`: inside a caller record that fragment renders as the canonical policy
 * of a record with no readers, which it is served as. The caller is judged by judgeWidenedCaller. A caller that renders
 * the short member-access form (`restricted` false) is compared with references in that form, and its policy carries
 * `open` (storePrivacyPolicy). Any other fragment refuses.
 */
export function storePageTextPolicy(
  member: string,
  rendered: () => string,
  opts: { callerReaders?: boolean; noReaders?: boolean; fragment?: StorePageFragment; renderedIn?: { record: CallerAccess | null } } = {},
): StorePrivacyPolicy {
  if (!accessDerivationOn()) return storePageTextPolicyRendered(member, rendered, opts);
  const labelled = opts.fragment ? PAGE_FRAGMENTS[opts.fragment] : undefined;
  const at = opts.renderedIn;
  checkFragment(member, 'page_text', rendered, labelled && at
    ? () => withoutCallerAccess(() => at.record ? withCallerAccess(at.record, labelled) : labelled())
    : labelled);
  const renderedIn = at ? { renderedIn: { record: at.record ? JSON.parse(JSON.stringify(at.record)) : null } } : {};
  return selfChecked(member, { mode: 'page_text', fragment: opts.fragment!, callerReaders: opts.callerReaders === true, noReaders: opts.noReaders === true, ...renderedIn },
    () => storePageTextPolicyRendered(member, rendered, opts));
}

function storePageTextPolicyRendered(
  member: string,
  rendered: () => string,
  opts: { callerReaders?: boolean; noReaders?: boolean },
): StorePrivacyPolicy {
  const openFlag = currentCallerAccess().restricted === false ? { open: true } : {};
  const policy = judgeWidenedCaller<StorePrivacyPolicy>(callerReaders => {
    const access = currentCallerAccess();
    const open = access.restricted === false;
    const text = normalizeConceptInputs(rendered());
    const baseline = renderForStoreCaller(open ? { restricted: false } : {}, () => privatePagesFilterForCaller('p'));
    if (text === normalizeConceptInputs(baseline)) return pagePolicyFlags(baseline);
    if (!opts.callerReaders && !opts.noReaders) return undefined;
    if (opts.noReaders) {
      const none = { identity: [], privateReadableSources: [] };
      const canonical = renderForStoreCaller({ ...none, hidePrivate: true, restricted: !open }, () => privatePagesFilterForCaller('p'));
      return text === normalizeConceptInputs(canonical) ? { ...pagePolicyFlags(canonical), ...none } : undefined;
    }
    const folders = {
      satisfiedRuleIds: [...access.satisfiedRuleIds],
      folderCoverage: access.folderCoverage.map(c => ({ source_id: c.source_id, prefix: c.prefix })),
    };
    const canonical = renderForStoreCaller({ ...callerReaders, ...folders, hidePrivate: true, restricted: !open }, () => privatePagesFilterForCaller('p'));
    const stored = {
      ...(folders.satisfiedRuleIds.length ? { satisfiedRuleIds: folders.satisfiedRuleIds } : {}),
      ...(folders.folderCoverage.length ? { folderCoverage: folders.folderCoverage } : {}),
    };
    if (text === normalizeConceptInputs(canonical)) return { ...pagePolicyFlags(canonical), ...callerReaders, ...stored, callerRecord: true };
    // An owner record (the local owner, or a remote owner reading its own lineage): the same record with the owner
    // fields, compared by its exact text. Its text holds no owner-only test, and the local owner's no privacy part, so
    // the flags read off it (`owner_only` off, `entity_privacy` false) are what the text applies.
    if (opts.callerReaders && access.owner) {
      const owner = renderForStoreCaller({ ...callerReaders, ...folders, hidePrivate: access.hidePrivate, restricted: !open, owner: true,
        ...(access.ownerReads ? { ownerReads: access.ownerReads } : {}) }, () => privatePagesFilterForCaller('p'));
      if (text === normalizeConceptInputs(owner)) return { ...pagePolicyFlags(owner), ...callerReaders, ...stored, callerRecord: true };
    }
    return undefined;
  });
  if (policy) return { ...policy, ...openFlag };
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
/**
 * The store page policy of a reflex or brief page read (reflex-reads.ts, brief-reads.ts): none, the caller's page
 * policy, or the remote read floor, each through storePageTextPolicy. It lives here, not in a member module, because
 * the store-members index serves every export of a member module as a member.
 */
export function reflexPolicy(member: string, privacy: ReflexPrivacy): StorePrivacyPolicy | null {
  if (privacy === 'none') return null;
  if (privacy === 'caller') return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true, fragment: 'caller' });
  if (privacy === 'floor') return storePageTextPolicy(member, () => remoteReadFloorSql('p'), { callerReaders: true, fragment: 'floor' });
  refuseMember(member, `privacy ${String(privacy)}`);
}

/**
 * The store page policy a retirement hop applies: the caller's page policy and the remote read floor through
 * storePageTextPolicy; member access alone (privacy off) when the caller's `callerAccessAllowedSql` is the no-caller
 * text or the canonical one for its reader identities, as the page visibility guards serve it (page-visibility.ts).
 * Any other caller refuses before the read.
 */
export function retirementHopPolicy(privacy: RetirementPrivacy, member = 'readRetirementHop'): StorePrivacyPolicy | undefined {
  if (privacy === 'none') return undefined;
  if (privacy === 'caller') return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true, fragment: 'caller' });
  if (privacy === 'floor') return storePageTextPolicy(member, () => remoteReadFloorSql('p'), { callerReaders: true, fragment: 'floor' });
  return selfChecked(member, { mode: 'access_part_plain' }, () => accessPartPlainRendered(member));
}

/** retirementHopPolicy's `access` branch: member access alone, as the TypeScript renderers decide it. */
function accessPartPlainRendered(member: string): StorePrivacyPolicy {
  const text = callerAccessAllowedSql('p');
  const off = { honorAliases: false, entityPrivacy: false, ownerOnly: ownerOnlyFormIn(text, 'pages', 'p') };
  if (text === withoutCallerAccess(() => callerAccessAllowedSql('p'))) return off;
  const access = currentCallerAccess();
  const readers = { identity: [...access.identity], privateReadableSources: [...access.privateReadableSources] };
  const canonical = withoutCallerAccess(() => withCallerAccess({ ...readers, hidePrivate: true }, () => callerAccessAllowedSql('p')));
  if (text === canonical) return { ...off, ...readers };
  refuseMember(member, 'a caller whose member pages, grants or lineage widen the member-access policy');
}
