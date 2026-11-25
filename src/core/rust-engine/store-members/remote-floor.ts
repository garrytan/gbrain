/**
 * Not a member family (store-members/index.ts does not spread it): the remote provenance floor helper the
 * memory-mutation-reads and withdrawal-commit members share.
 */
import { currentCallerAccess, privacyAliasSql, remoteProvenanceFloorSql, withCallerAccess, withoutCallerAccess } from '../../search/private-visibility.ts';
import { refuseMember } from './common.ts';
import { selfChecked } from '../access-self-check.ts';
import { normalizeConceptInputs, ownerOnlyFormIn, type StoreOwnerOnlyForm } from './private-provenance.ts';

/**
 * The remote provenance floor as the store reads it: the rendering with no caller record (which reads pending folder
 * coverage live), or the rendering of a fresh record carrying only the caller's `restricted` and `owner` flags and its
 * schema version (remotePolicy). The floor never reads the caller's identity, and the store keeps no folder rule or
 * pending coverage, so those forms differ only in text the store answers the same way, except `restricted: false`,
 * which drops the origin test, and the owner-only test's form (closed, the schema-320 fn form, or none for an owner),
 * both sent as settings. Any other rendering refuses.
 */
export function storeRemoteFloor(member: string): { honorAliases: boolean; restricted: boolean; ownerOnly: StoreOwnerOnlyForm } {
  return selfChecked(member, { mode: 'remote_floor' }, () => storeRemoteFloorRendered(member));
}

function storeRemoteFloorRendered(member: string): { honorAliases: boolean; restricted: boolean; ownerOnly: StoreOwnerOnlyForm } {
  const got = normalizeConceptInputs(remoteProvenanceFloorSql('facts'));
  const floor = (text: string, restricted: boolean) =>
    ({ honorAliases: text.includes(privacyAliasSql('pp')), restricted, ownerOnly: ownerOnlyFormIn(text, 'facts', 'facts') });
  const unscoped = withoutCallerAccess(() => remoteProvenanceFloorSql('facts'));
  if (got === normalizeConceptInputs(unscoped)) return floor(unscoped, true);
  const { restricted, owner, remotePolicy } = currentCallerAccess();
  const fresh = withoutCallerAccess(() => withCallerAccess({ restricted, owner, remotePolicy }, () => remoteProvenanceFloorSql('facts')));
  if (got !== normalizeConceptInputs(fresh)) {
    refuseMember(member, 'a remote provenance floor the store does not model (a labelled-only caller, folder coverage or a relaxed privacy setting)');
  }
  return floor(fresh, restricted);
}
