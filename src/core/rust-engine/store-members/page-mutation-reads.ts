/**
 * The reads a page write makes before admission, the members of engine-sql/page-mutation-reads.ts, served by the
 * store's page and version records (rust/docs/store/page-mutation-reads.md), and the four reads the enforced member CLI
 * makes around a write (readStoredPageLabels, readMemberPageReadable, readSlugFolderRules, readHiddenPageSlugs).
 */
import type { BrainEngine } from '../../engine.ts';
import { hiddenSlugsPolicySql, memberViewPolicySql } from '../../engine-sql/page-mutation-reads.ts';
import { currentCallerAccess } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { enforcedMemberPolicy } from './enforced-member-policy.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readStoredPageHead: Member<'readStoredPageHead'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readStoredPageHead', sourceId, slug }, () => brain.readStoredPageHead(sourceId, slug));

export const readVersionSourcePath: Member<'readVersionSourcePath'> = (brain, versionId, pageId) =>
  storeCall({ member: 'readVersionSourcePath' }, () => brain.readVersionSourcePath(versionId, pageId));

export const readStoredPageLabels: Member<'readStoredPageLabels'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readStoredPageLabels', sourceId, slug }, () => brain.readStoredPageLabels(sourceId, slug));

export const readMemberPageReadable: Member<'readMemberPageReadable'> = async (brain, sourceId, slug, identity, satisfied, labelled) => {
  if (labelled) refuseMember('readMemberPageReadable', 'a labelled-only member (its labelled read is not served yet)');
  const policy = enforcedMemberPolicy('readMemberPageReadable', 'member_view', () => memberViewPolicySql(identity, satisfied, false), identity, satisfied);
  return await storeCall({ member: 'readMemberPageReadable', slug, sourceId }, () => brain.readMemberPageReadable(sourceId, slug, policy)) as boolean | null;
};

export const readSlugFolderRules: Member<'readSlugFolderRules'> = async (brain, sourceId, slug) =>
  await storeCall({ member: 'readSlugFolderRules', slug, sourceId }, () => brain.readSlugFolderRules(sourceId, slug)) as string[] | null;

export const readHiddenPageSlugs: Member<'readHiddenPageSlugs'> = async (brain, slugs, hiddenSources) => {
  const access = currentCallerAccess();
  const policy = enforcedMemberPolicy('readHiddenPageSlugs', 'hidden_slugs', hiddenSlugsPolicySql, access.identity, access.satisfiedRuleIds);
  if (!slugs.length) return [];
  return await storeCall({ member: 'readHiddenPageSlugs' }, () => brain.readHiddenPageSlugs([...slugs], [...hiddenSources], policy)) as string[];
};
