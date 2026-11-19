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
 * (its member id and groups) and a private-readable grant: the member renders the page policy for a fresh record of
 * just those two, and when the caller's text equals it, the store reads the identity and the granted sources from
 * the policy (`readers_allowed` and `orPrivateReadableSource` in privacy.rs). Folder rules, pending coverage,
 * audiences, lineage, owner reads (whose text has no owner-only test), labelled-only grants and relaxed reads still refuse.
 *
 * Every text the store serves ends with the owner-only test (access/owner-only.ts), in the `fn` or the `closed` form
 * by the schema version the context carries; `ownerOnly` sends the form the text holds (owner_only.rs).
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
import { ANY_OWNER_ONLY_SQL, ownerOnlyFactSql, ownerOnlyPageSql } from '../../access/owner-only.ts';
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
}

/** `OwnerOnlyForm` (access/owner-only.ts), plus 'off' for a text with no owner-only test (`OwnerOnlyForm` in owner_only.rs). */
export type StoreOwnerOnlyForm = 'fn' | 'closed' | 'off';

/**
 * The form of the owner-only test in a rendered policy whose row alias is `alias` (`pages` for a page policy, `facts`
 * for a fact policy): the v320 function call, the closed test, or none. The same text never holds two forms (one
 * schema version renders both conjuncts), so the first match decides.
 */
export function ownerOnlyFormIn(sql: string, table: 'pages' | 'facts', alias: string): StoreOwnerOnlyForm {
  if (sql.includes(table === 'pages' ? ownerOnlyPageSql(alias, 'fn') : ownerOnlyFactSql(alias, 'fn'))) return 'fn';
  return sql.includes(ANY_OWNER_ONLY_SQL) ? 'closed' : 'off';
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
 * member-page case. Any other caller refuses.
 */
export function storePrivacyPolicy(
  member: string,
  excludePrivate: unknown,
  rendered: () => string,
  opts: { callerReaders?: boolean } = {},
): StorePrivacyPolicy | undefined {
  if (excludePrivate !== true) return undefined;
  const text = normalizeConceptInputs(rendered());
  for (const form of FACT_FORMS) {
    const baseline = withoutCallerAccess(() => form.sql('facts'));
    if (text === normalizeConceptInputs(baseline)) return factPolicyFlags(baseline);
  }
  if (opts.callerReaders) {
    const access = currentCallerAccess();
    const readers = { identity: [...access.identity], privateReadableSources: [...access.privateReadableSources] };
    const own = readers.identity.find(p => p.startsWith('member:'))?.slice('member:'.length);
    for (const form of FACT_FORMS) {
      const canonical = withoutCallerAccess(() =>
        withCallerAccess({ ...readers, hidePrivate: true }, () => form.sql('facts')));
      if (text !== normalizeConceptInputs(canonical)) continue;
      const memberPage = own === undefined ? undefined : `${MEMBER_PAGE_PREFIX}${own}`;
      const judged = form.memberCase && memberPage !== undefined && canonical.includes(`pp.slug = '${memberPage}'`);
      return { ...factPolicyFlags(canonical), ...readers, ...(judged ? { memberPage } : {}) };
    }
  }
  refuseMember(member, 'excludePrivate for a caller whose member pages, grants or lineage widen the policy');
}

/**
 * The store policy for the remote provenance floor, remoteProvenanceFloorSql('facts'): the provenance page judged by
 * privatePagesFilterFragment('pp', true), which reads no caller identity, plus the owner-only conjunct. The store serves
 * it when the text equals the no-caller rendering; a labelled-only caller (its own conjunct) or an owner read refuses.
 */
export function storeFloorPolicy(member: string): StorePrivacyPolicy {
  const text = normalizeConceptInputs(remoteProvenanceFloorSql('facts'));
  const baseline = withoutCallerAccess(() => remoteProvenanceFloorSql('facts'));
  if (text === normalizeConceptInputs(baseline)) return { ...factPolicyFlags(baseline), entityPrivacy: false, provenanceOnly: true };
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
 * no-caller page policy). A family that opts in with `callerReaders` also serves the caller's reader identities and
 * private-readable sources when the fragment is the canonical one for them. The caller is judged by
 * judgeWidenedCaller; any other fragment refuses.
 */
export function storePageTextPolicy(
  member: string,
  rendered: () => string,
  opts: { callerReaders?: boolean } = {},
): StorePrivacyPolicy {
  const policy = judgeWidenedCaller(readers => {
    const text = normalizeConceptInputs(rendered());
    const baseline = renderForStoreCaller({}, () => privatePagesFilterForCaller('p'));
    if (text === normalizeConceptInputs(baseline)) return pagePolicyFlags(baseline);
    if (!opts.callerReaders) return undefined;
    const canonical = renderForStoreCaller({ ...readers, hidePrivate: true }, () => privatePagesFilterForCaller('p'));
    return text === normalizeConceptInputs(canonical) ? { ...pagePolicyFlags(canonical), ...readers } : undefined;
  });
  if (policy) return policy;
  refuseMember(member, 'excludePrivate for a caller whose member pages, grants or lineage widen the policy');
}

/** The reader record a store policy carries for a widening caller (`identity` and `privateReadableSources` in privacy.rs). */
export interface StoreCallerReaders {
  identity: string[];
  privateReadableSources: string[];
}

/**
 * The widened-caller step every store privacy policy shares (page, member-access and fact policies). `judge` compares
 * the caller's rendered text with reference renderings (renderForStoreCaller) and returns the store policy for the
 * one it equals, or undefined. It runs with the caller's reader record (its reader identities and private-readable
 * sources), in the caller's context.
 *
 * When nothing matches and the caller is anonymous (no reader identity) on a brain whose config holds no member-access
 * restriction (restricted: false, the short member-access form the MCP stdio server's caller renders), `judge` runs
 * again under the restricted rendering. The restricted rendering only adds conditions that need a page with readers,
 * a folder rule or a pending folder prefix; each of those sets the store's sticky restriction flag
 * (access.restrictions_present), which restricted: false says is unset, so it hides the same pages. Undefined when
 * neither run matches: the member refuses.
 */
export function judgeWidenedCaller<T>(judge: (readers: StoreCallerReaders) => T | undefined): T | undefined {
  const access = currentCallerAccess();
  const readers = { identity: [...access.identity], privateReadableSources: [...access.privateReadableSources] };
  const served = judge(readers);
  if (served !== undefined) return served;
  if (access.restricted || access.identity.length > 0) return undefined;
  return withCallerAccess({ restricted: true }, () => judge(readers));
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
function pagePolicyFlags(sql: string): StorePrivacyPolicy {
  return {
    honorAliases: sql.includes(privacyAliasSql('p')),
    entityPrivacy: sql.includes(privateSnapshotFilterFragment('p')),
    ownerOnly: ownerOnlyFormIn(sql, 'pages', 'p'),
  };
}
