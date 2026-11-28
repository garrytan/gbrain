/**
 * The read policy of the enforced member CLI's reads around a write (readMemberPageReadable and readHiddenPageSlugs in
 * page-mutation-reads.ts). It lives apart from the member module because it is a helper, not a store member: every
 * export of a member module becomes a row of STORE_MEMBERS.
 */
import { currentCallerAccess, sqlAppliedSets } from '../../search/private-visibility.ts';
import { selfChecked } from '../access-self-check.ts';
import { refuseMember } from './common.ts';
import { normalizeConceptInputs, pagePolicyFlags, renderForStoreCaller, type StorePrivacyPolicy } from './private-provenance.ts';

/**
 * The store policy for the member read text `rendered` (member access, then privacy, for the current caller record with
 * `identity`, the rules it satisfies and no private-readable grant), or a refusal. The text is compared with the same
 * fragment for a fresh record of just those, so a labelled-only grant, lineage, an audience or an owner record (each
 * renders other text) refuses with `engine_capability_missing` before any read, and the store applies exactly the text
 * that was rendered. A caller on a brain with no member restriction renders the short form, which the store's flag
 * decides (`open`, as storePageTextPolicy sends it).
 */
export function enforcedMemberPolicy(member: string, view: 'member_view' | 'hidden_slugs', rendered: () => string, rawIdentity: readonly string[], rawSatisfied: readonly string[]): StorePrivacyPolicy {
  return selfChecked(member, { mode: 'enforced_member_policy', view, identity: [...rawIdentity], satisfied: [...rawSatisfied] },
    () => enforcedMemberPolicyRendered(member, rendered, rawIdentity, rawSatisfied));
}

/** The TypeScript side of `enforcedMemberPolicy`, the one the store's derivation (`enforced_member_policy`) is compared with. */
function enforcedMemberPolicyRendered(member: string, rendered: () => string, rawIdentity: readonly string[], rawSatisfied: readonly string[]): StorePrivacyPolicy {
  const access = currentCallerAccess();
  // The SQL renderer empties a whole set when any entry of it is invalid (readersAllowedSql: validIdentity; folderRulesAllowedSql:
  // validQualifiedRuleId), so a member holding one invalid entry reads nothing through that set. The store matches entries one by
  // one, so it is sent the set the SQL applies, never the raw one. An identity emptied that way beside rules the SQL still
  // applies is a policy the store cannot hold (it judges the rules only for a named identity), so it refuses.
  const { identity, satisfiedRuleIds: satisfied } = sqlAppliedSets(rawIdentity, rawSatisfied);
  if (!identity.length && satisfied.length) refuseMember(member, 'a member whose identity holds an invalid entry beside satisfied folder rules');
  const folders = { satisfiedRuleIds: [...satisfied], folderCoverage: access.folderCoverage.map(c => ({ source_id: c.source_id, prefix: c.prefix })) };
  const reference = renderForStoreCaller({ identity: [...identity], privateReadableSources: [], hidePrivate: true, owner: false, restricted: access.restricted, ...folders }, rendered);
  if (normalizeConceptInputs(rendered()) !== normalizeConceptInputs(reference)) {
    refuseMember(member, 'a member whose labelled-only grant, lineage, audience or owner record changes the read policy');
  }
  return { ...pagePolicyFlags(reference), identity: [...identity], privateReadableSources: [], ...folders, callerRecord: true, ...(access.restricted ? {} : { open: true }) };
}
