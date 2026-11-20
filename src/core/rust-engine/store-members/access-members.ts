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
 * A credential's binding is columns of its row, a client's (rust/docs/store/oauth-clients.md) and a token's
 * (rust/docs/store/access-tokens.md): the three binding members run on either, insertAccessMember binds its token in the
 * same write, and readLiveMember finds the member a client not deleted or a token not revoked is bound to.
 */
import type { AccessGroupRow, AccessMemberLookup, AccessMemberRow, AudiencePrincipalRows, LiveMemberRow, MemberBindingVia } from '../../engine-sql/access-control.ts';
import type { AccessMemberInsert, AccessMemberKind, AccessMemberLinkRow, CredentialBinding, CredentialBindingRow, CredentialTarget, LinkedMemberRow } from '../../engine-sql/access-members.ts';
import type { AccessMemberSourceRow, MemberSourceBinding } from '../../engine-sql/access-member-sources.ts';
import { withDates } from '../store-codec.ts';
import { storeErrorCode } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';
import { readOauthClient } from './jobs-oauth-clients.ts';

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

const asSource = (r: Record<string, unknown>): AccessMemberSourceRow => ({ member_id: String(r.member_id), source_id: String(r.source_id),
  created_at: new Date(String(r.created_at)) });

/** Personal sources (v299): the bindings in byte order of member id, then source id, as the SQL sorts with `COLLATE "C"`. */
export const readAccessMemberSource: StoreMember<[memberId: string, sourceId: string], AccessMemberSourceRow | null> = async (brain, memberId, sourceId) => {
  const row = await storeCall({ member: 'readAccessMemberSource' }, () => brain.readAccessMemberSource(memberId, sourceId)) as Record<string, unknown> | null;
  return row ? asSource(row) : null;
};

export const insertAccessMemberSource: StoreMember<[memberId: string, sourceId: string], void> = async (brain, memberId, sourceId) => {
  await write('insertAccessMemberSource', () => brain.insertAccessMemberSource(memberId, sourceId));
};

export const deleteAccessMemberSource: StoreMember<[memberId: string, sourceId: string], void> = async (brain, memberId, sourceId) => {
  await write('deleteAccessMemberSource', () => brain.deleteAccessMemberSource(memberId, sourceId));
};

export const listAccessMemberSources: StoreMember<[memberId: string | null], AccessMemberSourceRow[]> = async (brain, memberId) =>
  (await storeCall({ member: 'listAccessMemberSources' }, () => brain.listAccessMemberSources(memberId)) as Record<string, unknown>[]).map(asSource);

export const listAccessMemberSourceOwners: StoreMember<[sourceId: string], string[]> = async (brain, sourceId) =>
  (await storeCall({ member: 'listAccessMemberSourceOwners' }, () => brain.listAccessMemberSourceOwners(sourceId)) as unknown[]).map(String);

export const readMemberSourceBindings: StoreMember<[sourceIds: readonly string[]], MemberSourceBinding[]> = async (brain, sourceIds) =>
  (await storeCall({ member: 'readMemberSourceBindings' }, () => brain.readMemberSourceBindings([...sourceIds])) as Record<string, unknown>[])
    .map(r => ({ source_id: String(r.source_id), member_id: String(r.member_id) }));

/** The enabled member a link names, with its groups in byte order (Postgres orders them in the database collation). */
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
 * config key names (edge whitespace trimmed, as Postgres btrims it), or by the member an OAuth client not deleted is
 * bound to, or by the member an access token not revoked is bound to.
 */
export const readLiveMember: StoreMember<[via: MemberBindingVia, key: string], LiveMemberRow | null> = async (brain, via, key) => {
  let id: string | null = key;
  if (via === 'legacy_token') {
    id = await storeCall({ member: 'readLiveMember' }, () => brain.readLiveTokenMember(key)) as string | null;
  } else if (via === 'oauth_client') {
    const client = await readOauthClient(brain, key);
    id = client && client.deleted_at === null ? client.member_id : null;
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
 * The credential's binding columns (a client's also its grant types and whether it holds a secret). The row is read
 * whole; the store has one writer. A token is matched by its exact id, revoked or not, as the locking read matches it.
 */
export const readCredentialBindingForUpdate: StoreMember<[target: CredentialTarget, opts: { readsUnscoped: boolean }], CredentialBindingRow | undefined> =
  async (brain, target, opts) => {
    if (target.kind === 'token') {
      const token = await storeCall({ member: 'readCredentialBindingForUpdate' }, () => brain.readAccessTokenBinding(target.id)) as Record<string, unknown> | null;
      if (!token) return undefined;
      const { reads_unscoped, ...columns } = token;
      return { ...columns, ...(opts.readsUnscoped ? { reads_unscoped } : {}) } as unknown as CredentialBindingRow;
    }
    const row = await readOauthClient(brain, target.id);
    if (!row) return undefined;
    return {
      member_id: row.member_id, may_act_for: row.may_act_for, attest_actor: row.attest_actor, attest_ops: row.attest_ops,
      attest_sources: row.attest_sources, attest_read: row.attest_read as CredentialBindingRow['attest_read'],
      grant_types: row.grant_types, confidential: row.client_secret_hash !== null,
      ...(opts.readsUnscoped ? { reads_unscoped: row.reads_unscoped } : {}),
    };
  };

/** The binding reads readCredentialBindingForUpdate uses (a revoked token and a deleted client are read too). */
export const readCredentialMemberId: StoreMember<[target: CredentialTarget], string | null> = async (brain, target) => {
  if (target.kind === 'token') {
    const token = await storeCall({ member: 'readCredentialMemberId' }, () => brain.readAccessTokenBinding(target.id)) as { member_id?: string | null } | null;
    return token?.member_id ?? null;
  }
  return (await readOauthClient(brain, target.id))?.member_id ?? null;
};

export const writeCredentialBinding: StoreMember<[target: CredentialTarget, binding: CredentialBinding], void> = async (brain, target, binding) => {
  const wire = {
    member: binding.member, may_act_for: binding.mayActFor, attest_actor: binding.attestActor, attest_ops: binding.attestOps,
    attest_sources: binding.attestSources, attest_read: binding.attestRead,
  };
  await write('writeCredentialBinding', () => target.kind === 'token' ? brain.writeTokenBinding(target.id, wire) : brain.writeClientBinding(target.id, wire));
};

export const writeCredentialReadsUnscoped: StoreMember<[target: CredentialTarget, readsUnscoped: boolean], void> = async (brain, target, readsUnscoped) => {
  await write('writeCredentialReadsUnscoped', () => target.kind === 'token'
    ? brain.writeTokenReadsUnscoped(target.id, readsUnscoped) : brain.writeClientReadsUnscoped(target.id, readsUnscoped));
};

