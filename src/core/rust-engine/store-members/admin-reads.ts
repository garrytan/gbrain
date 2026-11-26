/**
 * The admin operations' page reads (BrainEngine listVisiblePageSlugs; SQL in
 * src/core/engine-sql/admin-reads.ts). The page policy part is turned into the store page policy the way the retirement
 * hop does it (private-provenance.ts retirementHopPolicy): `read` is the caller's page policy (`privatePagesFilterForCaller`),
 * `access` the caller's member-access part (`callerAccessAllowedSql`). A caller whose policy the store does not keep
 * refuses before the read. Contract: rust/docs/store/admin-reads.md.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import { storeCall, type StoreMember } from './common.ts';
import { retirementHopPolicy } from './private-provenance.ts';

export const listVisiblePageSlugs: StoreMember<[slugs: string[], sourceIds: string[] | null, policy: 'read' | 'access'], string[]> =
  (brain, slugs, sourceIds, policy) => {
    const store = retirementHopPolicy(policy === 'access' ? 'member_access' : 'caller', 'listVisiblePageSlugs');
    return storeCall({ member: 'listVisiblePageSlugs' }, () => brain.listVisiblePageSlugs([...slugs], sourceIds ? [...sourceIds] : null, store ?? null));
  };
