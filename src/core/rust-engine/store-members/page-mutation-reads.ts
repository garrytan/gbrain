/**
 * The reads a page write makes before admission, the members of engine-sql/page-mutation-reads.ts, served by the
 * store's page and version records (rust/docs/store/page-mutation-reads.md), and the four reads the enforced member CLI
 * makes around a write (readStoredPageLabels, readMemberPageReadable, readSlugFolderRules, readHiddenPageSlugs).
 */
import type { BrainEngine } from '../../engine.ts';
import { hiddenSlugsPolicySql, memberViewPolicySql } from '../../engine-sql/page-mutation-reads.ts';
import { currentCallerAccess, labelledOnlyForSql, labelledOnlyTerms, sqlAppliedSets } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { normalizeConceptInputs, pagePolicyFlags, renderForStoreCaller, type StorePrivacyPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readStoredPageHead: Member<'readStoredPageHead'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readStoredPageHead', sourceId, slug }, () => brain.readStoredPageHead(sourceId, slug));

export const readVersionSourcePath: Member<'readVersionSourcePath'> = (brain, versionId, pageId) =>
  storeCall({ member: 'readVersionSourcePath' }, () => brain.readVersionSourcePath(versionId, pageId));

export const readStoredPageLabels: Member<'readStoredPageLabels'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readStoredPageLabels', sourceId, slug }, () => brain.readStoredPageLabels(sourceId, slug));

/**
 * The store policy for the member read text `rendered` (member access, then privacy, for the current caller record with
 * `identity`, the rules it satisfies and no private-readable grant), or a refusal. The text is compared with the same
 * fragment for a fresh record of just those, so lineage, an audience or an owner record (each renders other text) refuses
 * with `engine_capability_missing` before any read, and the store applies exactly the text that was rendered. A caller on a
 * brain with no member restriction renders the short form, which the store's flag decides (`open`, as storePageTextPolicy
 * sends it). With `labelled` the text is that fragment ANDed with the labelled-only conjunct for `identity` as one audience
 * entry (`labelledOnlyForSql`, readers and rules, no lineage: memberViewPolicySql): the rest is judged as for any member and
 * the conjunct goes to the store as data (`labelledOnlyTerms`, the sets the SQL embeds), the form a labelled-only writer's
 * policy takes (remote-links.ts `writerPolicy`).
 */
function enforcedMemberPolicy(member: string, rendered: () => string, rawIdentity: readonly string[], rawSatisfied: readonly string[], labelled = false): StorePrivacyPolicy {
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
    refuseMember(member, 'a member whose lineage, audience or owner record changes the read policy');
  }
  // The conjunct is the whole of what a labelled read adds to the text the store judges: the sets it embeds are the terms sent.
  if (labelled && !reference.endsWith(` AND ${labelledOnlyForSql('p', [rawIdentity], rawSatisfied)}`)) {
    refuseMember(member, 'a labelled-only read whose policy is not the member-access policy and the labelled-only conjunct');
  }
  const terms = labelled ? { labelledOnly: labelledOnlyTerms({ identity: [], audienceIdentities: [rawIdentity], satisfiedRuleIds: rawSatisfied }) } : {};
  return { ...pagePolicyFlags(reference), identity: [...identity], privateReadableSources: [], ...folders, callerRecord: true, ...(access.restricted ? {} : { open: true }), ...terms };
}

export const readMemberPageReadable: Member<'readMemberPageReadable'> = async (brain, sourceId, slug, identity, satisfied, labelled) => {
  const policy = enforcedMemberPolicy('readMemberPageReadable', () => memberViewPolicySql(identity, satisfied, labelled), identity, satisfied, labelled);
  return await storeCall({ member: 'readMemberPageReadable', slug, sourceId }, () => brain.readMemberPageReadable(sourceId, slug, policy)) as boolean | null;
};

export const readSlugFolderRules: Member<'readSlugFolderRules'> = async (brain, sourceId, slug) =>
  await storeCall({ member: 'readSlugFolderRules', slug, sourceId }, () => brain.readSlugFolderRules(sourceId, slug)) as string[] | null;

export const readHiddenPageSlugs: Member<'readHiddenPageSlugs'> = async (brain, slugs, hiddenSources) => {
  const access = currentCallerAccess();
  const policy = enforcedMemberPolicy('readHiddenPageSlugs', hiddenSlugsPolicySql, access.identity, access.satisfiedRuleIds);
  if (!slugs.length) return [];
  return await storeCall({ member: 'readHiddenPageSlugs' }, () => brain.readHiddenPageSlugs([...slugs], [...hiddenSources], policy)) as string[];
};
