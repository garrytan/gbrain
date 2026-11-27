/**
 * The access member and group writes (engine-sql/access-members.ts) on the Rust store
 * (rust/docs/store/access-members.md).
 *
 * Each write is one store write: the member row, its groups and the trigger effects Postgres runs in the same
 * statement (`access.restrictions_present`, the serves keys) commit together or not at all. A store refusal names
 * the Postgres constraint, so it leaves here as the Postgres error would: `code` 23505 (unique), 23514 (check) or
 * 23503 (foreign key) with `constraint_name`, which the member commands read (refuseEmailRace).
 *
 * The member and group reads (readAccessMembers, readAudiencePrincipals, listActiveAccessMembers,
 * listAudienceAccessMembers, readLiveMember, readAccessGroups) read the same records, so a member a write added is
 * visible to the next read.
 *
 * A token bind on insert writes the token's member in the same store write. The credential binding members read and
 * write the member, may_act_for, attest and reads_unscoped columns of the token and client records
 * (rust/docs/store/access-tokens.md, oauth-clients.md); readLiveMember finds the member a live token or client names.
 * A time crosses the binding as ISO text and leaves here as a `Date`.
 */
import type { ReadSharedSourceRow } from '../../engine-sql/read-shared-sources.ts';
import type { AccessGroupRow, AccessMemberLookup, AccessMemberRow, AudiencePrincipalRows, LiveMemberRow, MemberBindingVia } from '../../engine-sql/access-control.ts';
import type { AccessMemberInsert, AccessMemberKind, AccessMemberLinkRow, CredentialBinding, CredentialBindingRow, CredentialMemberBinding, CredentialTarget, LinkedMemberRow, AccessTokenAttestRow, OauthClientAttestRow } from '../../engine-sql/access-members.ts';
import { withDates } from '../store-codec.ts';
import { storeErrorCode } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

const PG_CODE: ReadonlyArray<[RegExp, string]> = [[/_(pkey|key)$/, '23505'], [/_check$/, '23514'], [/_fkey$/, '23503']];

/** A store constraint refusal as the Postgres error the SQL engines throw; any other error unchanged. */
function asPostgresError(error: unknown): unknown {
  if (storeErrorCode(error) !== 'constraint_violation' || !(error instanceof Error)) return error;
  const constraint = /\(constraint ([a-z0-9_]+)\)$/.exec(error.message)?.[1];
  const code = constraint ? PG_CODE.find(([re]) => re.test(constraint))?.[1] : undefined;
  if (!constraint || !code) return error;
  return Object.assign(new Error(error.message.replace(/ \(constraint [a-z0-9_]+\)$/, '')), { code, constraint_name: constraint });
}

async function write<T>(member: string, run: () => Promise<T>): Promise<T> {
  try {
    return await storeCall({ member }, run);
  } catch (error) {
    throw asPostgresError(error);
  }
}

export const insertAccessMember: StoreMember<[spec: AccessMemberInsert], { groupsCreated: string[] }> = async (brain, spec) => {
  const out = await write('insertAccessMember', () => brain.insertAccessMember({
    id: spec.id, displayName: spec.displayName, email: spec.email, kind: spec.kind, groups: [...spec.groups], bindTokenId: spec.bindTokenId,
  })) as { groupsCreated: string[] };
  return { groupsCreated: out.groupsCreated };
};

export const setAccessMemberDisabled: StoreMember<[id: string, disabled: boolean], void> = async (brain, id, disabled) => {
  await write('setAccessMemberDisabled', () => brain.setAccessMemberDisabled(id, disabled));
};

export const setAccessMemberEmail: StoreMember<[id: string, email: string | null], boolean> = async (brain, id, email) =>
  await write('setAccessMemberEmail', () => brain.setAccessMemberEmail(id, email)) === true;

export const setAccessMemberKind: StoreMember<[id: string, kind: AccessMemberKind], void> = async (brain, id, kind) => {
  await write('setAccessMemberKind', () => brain.setAccessMemberKind(id, kind));
};

export const setAccessMemberLabelledOnly: StoreMember<[id: string, labelledOnly: boolean], void> = async (brain, id, labelledOnly) => {
  await write('setAccessMemberLabelledOnly', () => brain.setAccessMemberLabelledOnly(id, labelledOnly));
};

export const tombstoneAccessMember: StoreMember<[id: string], void> = async (brain, id) => {
  await write('tombstoneAccessMember', () => brain.tombstoneAccessMember(id));
};

export const addAccessGroupMembers: StoreMember<[groupId: string, memberIds: readonly string[]], boolean> = async (brain, groupId, memberIds) =>
  await write('addAccessGroupMembers', () => brain.addAccessGroupMembers(groupId, [...memberIds])) === true;

export const removeAccessGroupMembers: StoreMember<[groupId: string, memberIds: readonly string[]], void> = async (brain, groupId, memberIds) => {
  await write('removeAccessGroupMembers', () => brain.removeAccessGroupMembers(groupId, [...memberIds]));
};

export const deleteAccessGroup: StoreMember<[id: string], void> = async (brain, id) => {
  await write('deleteAccessGroup', () => brain.deleteAccessGroup(id));
};

const asLink = (r: Record<string, unknown>): AccessMemberLinkRow => ({ system: String(r.system), external_id: String(r.external_id),
  member_id: String(r.member_id), created_at: new Date(String(r.created_at)) });

export const readAccessMemberLink: StoreMember<[system: string, externalId: string], AccessMemberLinkRow | null> = async (brain, system, externalId) => {
  const row = await storeCall({ member: 'readAccessMemberLink' }, () => brain.readAccessMemberLink(system, externalId)) as Record<string, unknown> | null;
  return row ? asLink(row) : null;
};

export const insertAccessMemberLink: StoreMember<[system: string, externalId: string, memberId: string], void> = async (brain, system, externalId, memberId) => {
  await write('insertAccessMemberLink', () => brain.insertAccessMemberLink(system, externalId, memberId));
};

export const deleteAccessMemberLink: StoreMember<[system: string, externalId: string], void> = async (brain, system, externalId) => {
  await write('deleteAccessMemberLink', () => brain.deleteAccessMemberLink(system, externalId));
};

export const listAccessMemberLinks: StoreMember<[memberId: string | null], AccessMemberLinkRow[]> = async (brain, memberId) =>
  (await storeCall({ member: 'listAccessMemberLinks' }, () => brain.listAccessMemberLinks(memberId)) as Record<string, unknown>[]).map(asLink);

/** The enabled member a link names, with its groups in byte order (the Postgres SQL sorts them with COLLATE "C"). */
export const readLinkedMember: StoreMember<[system: string, externalId: string], LinkedMemberRow | null> = async (brain, system, externalId) =>
  await storeCall({ member: 'readLinkedMember' }, () => brain.readLinkedMember(system, externalId)) as LinkedMemberRow | null;

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
 * config key names (edge whitespace trimmed, as Postgres btrims it), or by the member of the live token (its id text)
 * or OAuth client the key names.
 */
export const readLiveMember: StoreMember<[via: MemberBindingVia, key: string], LiveMemberRow | null> = async (brain, via, key) => {
  let id: string | null = key;
  if (via === 'legacy_token' || via === 'oauth_client') {
    const live = await storeCall({ member: 'readLiveMember' }, () => brain.readLiveCredential(via, key)) as { member_id: string | null } | null;
    id = live?.member_id ?? null;
  } else if (via === 'stdio_config') {
    const value = await storeCall({ member: 'readLiveMember' }, () => brain.getConfig(key)) as string | null;
    id = typeof value === 'string' ? value.trim() : null;
  }
  if (id === null) return null;
  const [row] = await memberRows(brain, 'readLiveMember', { id });
  return row && isLive(row) ? { id: row.id, groups: row.groups } : null;
};

/** Every access group with its member ids, by id; or the one group with exactly this id. A group with no members carries none. */
export const readAccessGroups: StoreMember<[id: string | null], AccessGroupRow[]> = async (brain, id) =>
  await storeCall({ member: 'readAccessGroups' }, () => brain.readAccessGroups(id)) as AccessGroupRow[];

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

/**
 * The binding columns of the token or client, or undefined when no row has the id. The row lock has nothing to wait
 * for: the store runs one write at a time.
 */
export const readCredentialBindingForUpdate: StoreMember<[target: CredentialTarget, opts: { readsUnscoped: boolean }], CredentialBindingRow | undefined> =
  async (brain, target, opts) => {
    const row = await storeCall({ member: 'readCredentialBindingForUpdate' }, () =>
      brain.readCredentialBinding(target.kind, target.id, opts.readsUnscoped)) as CredentialBindingRow | null;
    return row ? withDates(row, ['reads_unscoped']) as CredentialBindingRow : undefined;
  };

/** The member of a token or client, from the same binding read as readCredentialBindingForUpdate (a revoked token and a deleted client are read too). */
/** The brain-audience heuristic's binding read (BrainEngine listCredentialMemberBindings): from the store's tokens and clients. */
export const listCredentialMemberBindings: StoreMember<[names: readonly string[]], CredentialMemberBinding[]> = async (brain, names) => {
  if (!names.length) return [];
  return await storeCall({ member: 'listCredentialMemberBindings' }, () => brain.listCredentialMemberBindings([...names])) as CredentialMemberBinding[];
};

export const readCredentialMemberId: StoreMember<[target: CredentialTarget], string | null> = async (brain, target) => {
  const row = await storeCall({ member: 'readCredentialMemberId' }, () =>
    brain.readCredentialBinding(target.kind, target.id, false)) as { member_id?: string | null } | null;
  return row?.member_id ?? null;
};

/** A legacy token's attest row, revoked or not, or null (access/actor.ts attestRightOf). */
export const readAccessTokenAttest: StoreMember<[id: string], AccessTokenAttestRow | null> = async (brain, id) => {
  const row = await storeCall({ member: 'readAccessTokenAttest' }, () => brain.readCredentialAttest('token', id)) as AccessTokenAttestRow | null;
  return row ? withDates(row, ['revoked_at']) as AccessTokenAttestRow : null;
};

/** An OAuth client's attest row, deleted or not, or null. The row lock has nothing to wait for: the store runs one write at a time. */
export const readOauthClientAttest: StoreMember<[clientId: string, opts?: { lock?: boolean }], OauthClientAttestRow | null> = async (brain, clientId) => {
  const row = await storeCall({ member: 'readOauthClientAttest' }, () => brain.readCredentialAttest('client', clientId)) as OauthClientAttestRow | null;
  return row ? withDates(row, ['deleted_at']) as OauthClientAttestRow : null;
};

export const writeCredentialBinding: StoreMember<[target: CredentialTarget, binding: CredentialBinding], void> = async (brain, target, binding) => {
  await write('writeCredentialBinding', () => brain.writeCredentialBinding(target.kind, target.id, binding));
};

export const writeCredentialReadsUnscoped: StoreMember<[target: CredentialTarget, readsUnscoped: boolean], void> = async (brain, target, readsUnscoped) => {
  await write('writeCredentialReadsUnscoped', () => brain.writeCredentialReadsUnscoped(target.kind, target.id, readsUnscoped));
};

/** GST-2898: the source rows of the read-shared switch's shared set (engine-sql/read-shared-sources.ts, rust read_shared.rs). */
export const readSharedSourceRows: StoreMember<[], ReadSharedSourceRow[]> = async (brain) =>
  storeCall({ member: 'readSharedSourceRows' }, () => brain.readSharedSourceRows());
