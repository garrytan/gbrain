/**
 * The access members, groups and member reads (BrainEngine insertAccessMember through deleteAccessGroup, SQL in
 * engine-sql/access-members.ts; readAccessMembers, readAccessGroups, listPagesNamingReader, readLiveMember,
 * readAudiencePrincipals, listAudienceAccessMembers, readMayActFor and readAccessCredentials, SQL in
 * engine-sql/access-control.ts; listActiveAccessMembers and hasLabelledOnlyMember, SQL in engine-sql/write-misc.ts),
 * served by gbrain-store `access_members` (rust/docs/store/access-members.md). The member reads filter the store's
 * member and group rows as the SQL filters them. The credential binding members (readCredentialBindingForUpdate,
 * writeCredentialBinding, writeCredentialReadsUnscoped; SQL in engine-sql/access-members.ts) and the token and client
 * halves of readLiveMember and readMayActFor read and write the binding columns of the store's token and client records
 * (gbrain-store `jobs/credential_binding.rs`). A time crosses the binding as ISO text and leaves here as a `Date`.
 */
import type { AccessMemberInsert, AccessMemberKind, CredentialBinding, CredentialBindingRow, CredentialTarget } from '../../engine-sql/access-members.ts';
import type {
  AccessCredentialLookup, AccessCredentialRow, AccessGroupRow, AccessMemberLookup, AccessMemberRow, AudiencePrincipalRows, LiveMemberRow,
  LiveMemberVia, MayActForVia, PageNamingReaderRow,
} from '../../engine-sql/access-control.ts';
import { EDGE_WHITESPACE } from '../../edge-whitespace.ts';
import { withDates } from '../store-codec.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';
import { refusing } from './constraint-errors.ts';

/** A member row as the SQL engines return it: the three times as Date. */
function memberRow(row: AccessMemberRow): AccessMemberRow {
  const date = (v: unknown) => (v == null ? null : new Date(String(v)));
  return { ...row, disabled_at: date(row.disabled_at), tombstoned_at: date(row.tombstoned_at), created_at: date(row.created_at) };
}

async function members(brain: StoreBrain, member: string, by: AccessMemberLookup): Promise<AccessMemberRow[]> {
  const rows = await storeCall({ member }, () => brain.readAccessMembers(by)) as AccessMemberRow[];
  return rows.map(memberRow);
}

/** The enabled, untombstoned members, by id. */
const enabled = async (brain: StoreBrain, member: string) =>
  (await members(brain, member, { includeRemoved: false })).filter(r => r.disabled_at == null);

const live = (row: AccessMemberRow): LiveMemberRow => ({ id: row.id, groups: row.groups });

export const insertAccessMember: StoreMember<[spec: AccessMemberInsert], { groupsCreated: string[] }> = (brain, spec) =>
  refusing('insertAccessMember', () => brain.insertAccessMember(spec)) as Promise<{ groupsCreated: string[] }>;

export const setAccessMemberDisabled: StoreMember<[id: string, disabled: boolean], void> = async (brain, id, disabled) => {
  await refusing('setAccessMemberDisabled', () => brain.setAccessMemberDisabled(id, disabled));
};

export const setAccessMemberEmail: StoreMember<[id: string, email: string | null], boolean> = (brain, id, email) =>
  refusing('setAccessMemberEmail', () => brain.setAccessMemberEmail(id, email)) as Promise<boolean>;

export const setAccessMemberKind: StoreMember<[id: string, kind: AccessMemberKind], void> = async (brain, id, kind) => {
  await refusing('setAccessMemberKind', () => brain.setAccessMemberKind(id, kind));
};

export const setAccessMemberLabelledOnly: StoreMember<[id: string, labelledOnly: boolean], void> = async (brain, id, on) => {
  await refusing('setAccessMemberLabelledOnly', () => brain.setAccessMemberLabelledOnly(id, on));
};

export const tombstoneAccessMember: StoreMember<[id: string], void> = async (brain, id) => {
  await refusing('tombstoneAccessMember', () => brain.tombstoneAccessMember(id));
};

export const addAccessGroupMembers: StoreMember<[groupId: string, memberIds: readonly string[]], boolean> = (brain, groupId, memberIds) =>
  refusing('addAccessGroupMembers', () => brain.addAccessGroupMembers(groupId, [...memberIds])) as Promise<boolean>;

export const removeAccessGroupMembers: StoreMember<[groupId: string, memberIds: readonly string[]], void> = async (brain, groupId, memberIds) => {
  await refusing('removeAccessGroupMembers', () => brain.removeAccessGroupMembers(groupId, [...memberIds]));
};

export const deleteAccessGroup: StoreMember<[id: string], void> = async (brain, id) => {
  await refusing('deleteAccessGroup', () => brain.deleteAccessGroup(id));
};

export const readAccessMembers: StoreMember<[by: AccessMemberLookup], AccessMemberRow[]> = (brain, by) => members(brain, 'readAccessMembers', by);

export const readAccessGroups: StoreMember<[id: string | null], AccessGroupRow[]> = (brain, id) =>
  storeCall({ member: 'readAccessGroups' }, () => brain.readAccessGroups(id)) as Promise<AccessGroupRow[]>;

export const listPagesNamingReader: StoreMember<[principal: string, opts?: { live?: boolean }], PageNamingReaderRow[]> = (brain, principal, opts) =>
  storeCall({ member: 'listPagesNamingReader' }, () => brain.listPagesNamingReader(principal, opts?.live === true)) as Promise<PageNamingReaderRow[]>;

export const listActiveAccessMembers: StoreMember<[], string[]> = async (brain) => (await enabled(brain, 'listActiveAccessMembers')).map(r => r.id);

/** Any member of any status with the labelled-only grant. */
export const hasLabelledOnlyMember: StoreMember<[], boolean> = async (brain) =>
  (await members(brain, 'hasLabelledOnlyMember', { includeRemoved: true })).some(r => r.labelled_only === true);

export const listAudienceAccessMembers: StoreMember<[], string[]> = async (brain) =>
  (await enabled(brain, 'listAudienceAccessMembers')).filter(r => r.kind === 'audience').map(r => r.id);

/** Which of `memberIds` are enabled members (each with its groups) and which of `groupIds` are groups; an empty list reads nothing. */
export const readAudiencePrincipals: StoreMember<[memberIds: readonly string[], groupIds: readonly string[]], AudiencePrincipalRows> = async (brain, memberIds, groupIds) => {
  const found = memberIds.length ? (await enabled(brain, 'readAudiencePrincipals')).filter(r => memberIds.includes(r.id)).map(live) : [];
  const groups = groupIds.length ? (await readAccessGroups(brain, null)).map(g => g.id).filter(id => groupIds.includes(id)) : [];
  return { members: found, groups };
};

/** `btrim(value, EDGE_WHITESPACE)` of the stdio member config. */
function edgeTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && EDGE_WHITESPACE.includes(value[start]!)) start++;
  while (end > start && EDGE_WHITESPACE.includes(value[end - 1]!)) end--;
  return value.slice(start, end);
}

/** The `{ member_id, may_act_for }` of the live token (id text) or client (client id) `key` names, or null. */
const liveCredential = (brain: StoreBrain, member: string, via: 'legacy_token' | 'oauth_client', key: string) =>
  storeCall({ member }, () => brain.readLiveCredential(via, key)) as Promise<{ member_id: string | null; may_act_for: unknown } | null>;

/** The enabled, untombstoned member an id, the stdio member config or the binding of a live token or client names. */
export const readLiveMember: StoreMember<[via: LiveMemberVia, key: string], LiveMemberRow | null> = async (brain, via, key) => {
  let id: string | null = key;
  if (via === 'legacy_token' || via === 'oauth_client') id = (await liveCredential(brain, 'readLiveMember', via, key))?.member_id ?? null;
  else if (via === 'stdio_config') {
    const stored = await storeCall({ member: 'readLiveMember' }, () => brain.getConfig(key)) as string | null;
    id = stored === null ? null : edgeTrim(stored);
  }
  if (id === null) return null;
  const [row] = await members(brain, 'readLiveMember', { id });
  return row && row.disabled_at == null && row.tombstoned_at == null ? live(row) : null;
};

/** A stdio server's may_act_for as the config stores it; a live token's or client's list, or null. */
export const readMayActFor: StoreMember<[via: MayActForVia, key: string], string[] | string | null> = async (brain, via, key) => {
  if (via === 'stdio_config') return storeCall({ member: 'readMayActFor' }, () => brain.getConfig(key));
  const list = (await liveCredential(brain, 'readMayActFor', via, key))?.may_act_for;
  return Array.isArray(list) ? list as string[] : null;
};

export const readAccessCredentials: StoreMember<[by: AccessCredentialLookup], AccessCredentialRow[]> = (brain, by) =>
  storeCall({ member: 'readAccessCredentials' }, () => brain.readAccessCredentials(by)) as Promise<AccessCredentialRow[]>;

export const readCredentialBindingForUpdate: StoreMember<[target: CredentialTarget, opts: { readsUnscoped: boolean }], CredentialBindingRow | undefined> =
  async (brain, target, opts) => {
    const row = await storeCall({ member: 'readCredentialBindingForUpdate' }, () =>
      brain.readCredentialBinding(target.kind, target.id, opts.readsUnscoped)) as CredentialBindingRow | null;
    return row ? withDates(row, ['reads_unscoped']) : undefined;
  };

export const writeCredentialBinding: StoreMember<[target: CredentialTarget, binding: CredentialBinding], void> = async (brain, target, binding) => {
  await refusing('writeCredentialBinding', () => brain.writeCredentialBinding(target.kind, target.id, binding));
};

export const writeCredentialReadsUnscoped: StoreMember<[target: CredentialTarget, readsUnscoped: boolean], void> = async (brain, target, on) => {
  await refusing('writeCredentialReadsUnscoped', () => brain.writeCredentialReadsUnscoped(target.kind, target.id, on));
};
