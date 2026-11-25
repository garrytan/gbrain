/**
 * A fact list read's `visibility` list as the store reads it (`listFactsByEntity`, `listFactsSince`, `listFactsKeyset`,
 * `listFactsBySession`, `listSupersessions`).
 *
 * PGLite renders the list with factVisibilitySql (access/member-facts.ts). A list that names 'private', or a caller no
 * rule widens, renders the bare list (`facts.visibility IN (...)`), which the store applies as it stands. A list without
 * 'private' also admits, per row, a private fact on the caller's own member page (memberFactAdmitSql) and a private fact
 * in a source of the caller's private-facts grant whose pages keep it private for no reason (grantedPrivateFactSql).
 * The member serves that widened list only when its text equals the one rendered for a fresh caller record of just the
 * caller's reader identity, private-readable sources and private-facts grant (judgeWidenedCaller), and sends the
 * store what that record reads (`VisibilityWidening` in rust/crates/gbrain-store/src/facts/widen.rs): the member, the
 * page policy its member page is judged by, and the granted sources. Any other caller (an audience, an attested actor
 * whose text differs, a folder rule, a relaxed read) refuses with `engine_capability_missing`.
 */
import { callerMember, factVisibilitySql } from '../../access/member-facts.ts';
import { currentCallerAccess, privateFactSources } from '../../search/private-visibility.ts';
import { refuseMember } from './common.ts';
import { callerFolders, callerFoldersPagePolicy, callerReadersPagePolicy, judgeWidenedCaller, renderForStoreCaller, type StorePrivacyPolicy } from './private-provenance.ts';

/** What the store reads to widen a visibility list without 'private' (`VisibilityWidening` in widen.rs). */
export interface StoreVisibilityWidening {
  /** The caller's member (memberFactAdmitSql): a private fact on its own live member page that names it as a reader. */
  member?: string;
  /** The page policy that member page must pass (`privatePagesFilterForCaller('member_page')`). */
  memberPagePolicy?: StorePrivacyPolicy;
  /** The private-facts grant (grantedPrivateFactSql): a private fact in one of these sources whose pages are open. */
  privateFactSources: string[];
}

export interface StoreVisibility {
  visibility?: string[];
  widen?: StoreVisibilityWidening;
}

/**
 * `visibility` as the store reads it: no filter for an empty list, else the list, and the widening record when the
 * caller's member page or grant widens it. A widened list the store cannot model refuses.
 */
export function storeVisibility(member: string, visibility: readonly string[] | undefined): StoreVisibility {
  if (!visibility || visibility.length === 0) return {};
  const known = (['world', 'private'] as const).filter((v) => visibility.includes(v));
  const listed = known.length ? `facts.visibility IN (${known.map((v) => `'${v}'`).join(', ')})` : 'FALSE';
  if (factVisibilitySql('facts', visibility) === listed) return { visibility: [...visibility] };
  // A caller on a brain that never named readers renders the member page's policy in the short form, which hides
  // every page that names readers (storePrivacyPolicy); its member page policy carries `open` to match.
  const openFlag = currentCallerAccess().restricted === false ? { open: true } : {};
  const widen = judgeWidenedCaller<StoreVisibilityWidening>((readers) => {
    const text = factVisibilitySql('facts', visibility);
    // The fresh record of the caller's readers and grant, then the same record with the caller's own folder rules and
    // pending prefixes (a member whose member page sits under a rule it satisfies).
    const folders = callerFolders();
    const withFolders = folders.satisfiedRuleIds.length > 0 || folders.folderCoverage.length > 0;
    for (const record of withFolders ? [{}, folders] : [{}]) {
      const fresh = { ...readers, ...record, privateFactSources: [...privateFactSources()], hidePrivate: true };
      const canonical = renderForStoreCaller(fresh, () => ({ sql: factVisibilitySql('facts', visibility), member: callerMember() }));
      if (text !== canonical.sql) continue;
      const pagePolicy = 'satisfiedRuleIds' in record ? callerFoldersPagePolicy(readers, folders) : callerReadersPagePolicy(readers);
      return {
        ...(canonical.member ? { member: canonical.member, memberPagePolicy: { ...pagePolicy, ...openFlag } } : {}),
        privateFactSources: fresh.privateFactSources,
      };
    }
    return undefined;
  });
  if (!widen) refuseMember(member, 'a visibility list widened by member pages or grants for a caller the store does not model');
  return { visibility: [...visibility], widen };
}
