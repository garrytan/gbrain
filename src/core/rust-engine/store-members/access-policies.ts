/**
 * Policy builders the store members share (multi-user lane L4). Not a member module: the store-members index serves
 * every export of a member module as an engine member, so builders a member calls, and the differential test
 * imports, live here. Each asks the store's derivation under the multi-user switch (`selfChecked`); its `...Rendered`
 * twin is the TypeScript side the self-check compares with.
 */
import type { WriterReadPolicy } from '../../engine-sql/remote-links.ts';
import { renderWriterReadPolicy } from '../../engine-sql/remote-links.ts';
import {
  accessAllowedSql, callerAccessAllowedSql, callerReadersAllowedSql, currentCallerAccess, ownerOnlyTakeAllowedSql,
  ownerOnlyTimelineAllowedSql, privacyForCaller, privateSnapshotFilterFragment, withoutCallerAccess,
} from '../../search/private-visibility.ts';
import { selfChecked } from '../access-self-check.ts';
import { refuseMember } from './common.ts';
import { judgeWidenedCaller, ownerOnlyFormIn, renderForStoreCaller, type StoreOwnerOnlyForm, type StorePrivacyPolicy } from './private-provenance.ts';

/**
 * countOpenPages's member-access floor: the no-caller member-access policy when the floor is the no-caller rendering,
 * else the same for a fresh record of no identity and the caller's folder coverage; any other rendering refuses.
 */
export function openPageFloorPolicy(): StorePrivacyPolicy {
  const floor = accessAllowedSql('p', [], []);
  return selfChecked('countOpenPages', { mode: 'open_page_floor' }, () => openPageFloorRendered(floor));
}

function openPageFloorRendered(floor: string): StorePrivacyPolicy {
  const base: StorePrivacyPolicy = { honorAliases: false, entityPrivacy: false, ownerOnly: ownerOnlyFormIn(floor, 'pages', 'p') };
  if (floor === renderForStoreCaller({}, () => callerAccessAllowedSql('p'))) return base;
  const caller = currentCallerAccess();
  const folderCoverage = caller.folderCoverage.map(c => ({ source_id: c.source_id, prefix: c.prefix }));
  const record = { identity: [], satisfiedRuleIds: [], folderCoverage, restricted: caller.restricted };
  if (floor !== renderForStoreCaller(record, () => callerAccessAllowedSql('p'))) {
    refuseMember('countOpenPages', 'an open-page floor rendered in a caller record');
  }
  return { ...base, ...(folderCoverage.length ? { folderCoverage } : {}), ...(caller.restricted ? {} : { open: true }) };
}

/** The store policy for the writer's read policy, or a refusal (derived by the store under the multi-user switch). */
export function writerPolicy(policy: WriterReadPolicy): StorePrivacyPolicy {
  const plain = {
    identities: policy.identities.map(i => [...i]), satisfiedRuleIds: [...policy.satisfiedRuleIds],
    folderCoverage: policy.folderCoverage.map(c => ({ source_id: c.source_id, prefix: c.prefix })), owner: policy.owner, labelledOnly: policy.labelledOnly,
  };
  return selfChecked('readLinkTargetPages', { mode: 'writer_policy', policy: plain }, () => writerPolicyRendered(policy));
}

function writerPolicyRendered(policy: WriterReadPolicy): StorePrivacyPolicy {
  const text = renderWriterReadPolicy(policy, 'p', false);
  const off = { honorAliases: false, entityPrivacy: false, ownerOnly: ownerOnlyFormIn(text, 'pages', 'p') };
  const fragment = (record: Parameters<typeof renderForStoreCaller>[0]) =>
    `(${renderForStoreCaller(record, () => callerAccessAllowedSql('p'))} AND TRUE)`;
  if (text === fragment({})) return off;
  // A writer with no identity (an unbound or anonymous writer): its policy renders in a record of its own folder
  // coverage, so the store reads that coverage instead of the live pending prefixes (callerRecord).
  const folderCoverage = policy.folderCoverage.map(c => ({ source_id: c.source_id, prefix: c.prefix }));
  if (!policy.identities.length && text === fragment({ identity: [], satisfiedRuleIds: [], folderCoverage })) {
    return { ...off, identity: [], ...(folderCoverage.length ? { folderCoverage } : {}), callerRecord: true };
  }
  const [identity] = policy.identities;
  // The owner speaking for itself renders the same text without the owner-only clause (CallerAccess.owner), which `off` reads as no test.
  const oneIdentity = (owner: boolean) => policy.identities.length === 1 && identity && text === fragment({ identity: [...identity], privateReadableSources: [], hidePrivate: true, ...(owner ? { owner } : {}) });
  if (oneIdentity(false) || oneIdentity(true)) {
    return { ...off, identity: [...identity], privateReadableSources: [] };
  }
  refuseMember('readLinkTargetPages', 'a writer whose folder rules, owner record, labelled-only grant or identities widen the member-access policy');
}

/** The snapshot visibility the pick reports for a version row, in the current context. */
const snapshotVisibleSql = () => `${callerReadersAllowedSql('pv', 'snapshot')} AND ${privacyForCaller('p', privateSnapshotFilterFragment('pv'))}`;

/** snapshotServedRendered, derived by the store under the multi-user switch. */
export function snapshotServed(member: string, readers: { identity: readonly string[]; privateReadableSources: readonly string[] }): true {
  return selfChecked(member, { mode: 'snapshot_policy', identity: [...readers.identity], privateReadableSources: [...readers.privateReadableSources] },
    () => snapshotServedRendered(member, readers));
}

/** The caller's snapshot text is the no-record one or the canonical one for the page policy's readers, or a refusal. */
function snapshotServedRendered(member: string, readers: { identity: readonly string[]; privateReadableSources: readonly string[] }): true {
  const snapshotServed = judgeWidenedCaller(() => {
    const text = snapshotVisibleSql();
    if (text === withoutCallerAccess(snapshotVisibleSql)) return true;
    return text === renderForStoreCaller({ ...readers, hidePrivate: true } as never, snapshotVisibleSql) || undefined;
  });
  if (!snapshotServed) refuseMember(member, 'a caller whose snapshot policy is not the canonical one for its readers');
  return true;
}

/**
 * The member-access and folder-rule tests (`accessAllowedSql`, `folderRulesAllowedSql`) run under the current caller
 * record, which supplies only the folder coverage and the owner flag; the identity and satisfied set are the call's own.
 * The store judges the member-access part alone (no privacy part) with that record: the identity, the satisfied rules,
 * the coverage, and the owner-only test in the form the SQL renders (`ownerOnlyFormIn`; none for the owner).
 */
/** memberAccessPolicyRendered, derived by the store under the multi-user switch; a null identity is the folder-rules read. */
export function memberAccessPolicy(identity: readonly string[] | null, satisfied: readonly string[]): Record<string, unknown> {
  if (identity === null) {
    return selfChecked('readPageFolderRulesAllowed', { mode: 'member_access_policy', satisfied: [...satisfied] },
      () => memberAccessPolicyRendered([], satisfied, ''));
  }
  return selfChecked('readPageAccessAllowed', { mode: 'member_access_policy', identity: [...identity], satisfied: [...satisfied] },
    () => memberAccessPolicyRendered(identity, satisfied, accessAllowedSql('p', identity)));
}

function memberAccessPolicyRendered(identity: readonly string[], satisfied: readonly string[], rendered: string): Record<string, unknown> {
  const access = currentCallerAccess();
  return {
    honorAliases: false, entityPrivacy: false, identity: [...identity], satisfiedRuleIds: [...satisfied],
    folderCoverage: access.folderCoverage.map(c => ({ source_id: c.source_id, prefix: c.prefix })),
    callerRecord: true, ownerOnly: ownerOnlyFormIn(rendered, 'pages', 'p'), open: access.restricted === false,
  };
}

/**
 * The owner-only form a take or timeline row is read under (`ownerOnlyTakeAllowedSql` / `ownerOnlyTimelineAllowedSql`):
 * 'off' for the owner or a read without excludePrivate.
 */
export function rowOwnerOnly(excludePrivate: boolean | undefined, table: 'takes' | 'timeline_entries'): StoreOwnerOnlyForm {
  if (!excludePrivate) return 'off';
  return selfChecked('readRowAttribution', { mode: 'row_owner_only' }, () => rowOwnerOnlyRendered(table));
}

function rowOwnerOnlyRendered(table: 'takes' | 'timeline_entries'): StoreOwnerOnlyForm {
  return ownerOnlyFormIn(table === 'takes' ? ownerOnlyTakeAllowedSql(table) : ownerOnlyTimelineAllowedSql(table), table, table);
}
