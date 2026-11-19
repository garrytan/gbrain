/**
 * The access member and group writes (engine-sql/access-members.ts) on the Rust store
 * (rust/docs/store/access-members.md).
 *
 * Each write is one store write: the member row, its groups and the trigger effects Postgres runs in the same
 * statement (`access.restrictions_present`, the serves keys) commit together or not at all. A store refusal names
 * the Postgres constraint, so it leaves here as the Postgres error would: `code` 23505 (unique), 23514 (check) or
 * 23503 (foreign key) with `constraint_name`, which the member commands read (refuseEmailRace).
 *
 * The store keeps no access tokens and no OAuth clients, so a token bind on insert and every credential binding
 * member refuse with engine_capability_missing before anything is written.
 */
import type { AccessMemberInsert, AccessMemberKind, CredentialBinding, CredentialBindingRow, CredentialTarget } from '../../engine-sql/access-members.ts';
import { storeErrorCode } from '../store-errors.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const NO_CREDENTIALS = 'the store keeps no access tokens and no OAuth clients';

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
  if (spec.bindTokenId !== null) refuseMember('insertAccessMember', `${NO_CREDENTIALS}, so it binds no token`);
  const out = await write('insertAccessMember', () => brain.insertAccessMember({
    id: spec.id, displayName: spec.displayName, email: spec.email, kind: spec.kind, groups: [...spec.groups],
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

export const readAccessMemberIdByEmail: StoreMember<[email: string], string | null> = async (brain, email) => {
  const id = await storeCall({ member: 'readAccessMemberIdByEmail' }, () => brain.readAccessMemberIdByEmail(email));
  return typeof id === 'string' ? id : null;
};

/** The ids of the members neither disabled nor removed, by id. */
export const listActiveAccessMembers: StoreMember<[], string[]> = async (brain) =>
  await storeCall({ member: 'listActiveAccessMembers' }, () => brain.listActiveAccessMembers()) as string[];

export const readCredentialBindingForUpdate: StoreMember<[target: CredentialTarget, opts: { readsUnscoped: boolean }], CredentialBindingRow | undefined> =
  async () => refuseMember('readCredentialBindingForUpdate', NO_CREDENTIALS);

export const writeCredentialBinding: StoreMember<[target: CredentialTarget, binding: CredentialBinding], void> =
  async () => refuseMember('writeCredentialBinding', NO_CREDENTIALS);

export const writeCredentialReadsUnscoped: StoreMember<[target: CredentialTarget, readsUnscoped: boolean], void> =
  async () => refuseMember('writeCredentialReadsUnscoped', NO_CREDENTIALS);

