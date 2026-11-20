/**
 * The access member reads (engine-sql/access-control.ts) on the Rust store (rust/docs/store/access-members.md): the
 * member list, the audience lists and the live-member lookup the caller's identity and the page filters read through.
 * They read the records the store's member and group writes keep, so a member a write added is visible to the next read.
 *
 * The store keeps no token or OAuth client binding to a member, so a token or a client names no member here
 * (readLiveMember answers null for them) and the credential reads stay in write-misc.ts. A time crosses the store as
 * ISO text and leaves here as a `Date`.
 */
import type { AccessMemberLookup, AccessMemberRow, AudiencePrincipalRows, LiveMemberRow, LiveMemberVia } from '../../engine-sql/access-control.ts';
import { withDates } from '../store-codec.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The ids of the members neither disabled nor removed, by id. */
export const listActiveAccessMembers: StoreMember<[], string[]> = async (brain) =>
  await storeCall({ member: 'listActiveAccessMembers' }, () => brain.listActiveAccessMembers()) as string[];

const MEMBER_DATES = ['disabled_at', 'tombstoned_at', 'created_at'];

async function memberRows(brain: StoreBrain, member: string, lookup: AccessMemberLookup): Promise<AccessMemberRow[]> {
  const rows = await storeCall({ member }, () => brain.readAccessMembers(lookup)) as AccessMemberRow[];
  return rows.map(row => withDates(row, MEMBER_DATES));
}

const isLive = (row: AccessMemberRow) => row.disabled_at === null && row.tombstoned_at === null;

/**
 * The member with this id (any status); the members that declare this email (removed members declare none), by id; or
 * every member by id (removed ones only when asked). Each carries its groups.
 */
export const readAccessMembers: StoreMember<[by: AccessMemberLookup], AccessMemberRow[]> = async (brain, by) => {
  if ('id' in by) return memberRows(brain, 'readAccessMembers', { id: by.id });
  if ('email' in by) return memberRows(brain, 'readAccessMembers', { email: by.email });
  return memberRows(brain, 'readAccessMembers', { includeRemoved: by.includeRemoved });
};

/** The ids of the enabled, untombstoned members of kind `audience`, by id. */
export const listAudienceAccessMembers: StoreMember<[], string[]> = async (brain) =>
  (await memberRows(brain, 'listAudienceAccessMembers', { includeRemoved: false })).filter(row => row.kind === 'audience' && isLive(row)).map(row => row.id);

/**
 * The enabled, untombstoned member `via` and `key` name, with its groups, or null: by its id, or by the member the
 * config key names (edge whitespace trimmed, as Postgres btrims it). A token or an OAuth client names no member: the
 * store keeps no binding of either to one.
 */
export const readLiveMember: StoreMember<[via: LiveMemberVia, key: string], LiveMemberRow | null> = async (brain, via, key) => {
  let id: string | null = key;
  if (via === 'legacy_token' || via === 'oauth_client') id = null;
  else if (via === 'stdio_config') {
    const value = await storeCall({ member: 'readLiveMember' }, () => brain.getConfig(key)) as string | null;
    id = typeof value === 'string' ? value.trim() : null;
  }
  if (id === null) return null;
  const [row] = await memberRows(brain, 'readLiveMember', { id });
  return row && isLive(row) ? { id: row.id, groups: row.groups } : null;
};

/**
 * Which of `memberIds` are enabled, untombstoned members (each with its groups) and which of `groupIds` are existing
 * groups. An empty list reads nothing.
 */
export const readAudiencePrincipals: StoreMember<[memberIds: readonly string[], groupIds: readonly string[]], AudiencePrincipalRows> =
  async (brain, memberIds, groupIds) => {
    const wanted = new Set(memberIds);
    const members = wanted.size === 0 ? [] : (await storeCall({ member: 'readAudiencePrincipals' }, () =>
      brain.readAccessMembers({ includeRemoved: false })) as AccessMemberRow[])
      .filter(row => wanted.has(row.id) && row.disabled_at === null)
      .map(row => ({ id: row.id, groups: row.groups }));
    const groups = groupIds.length === 0 ? [] : await storeCall({ member: 'readAudiencePrincipals' }, () =>
      brain.readAccessGroupIds([...groupIds])) as string[];
    return { members, groups };
  };
