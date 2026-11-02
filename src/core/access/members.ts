/**
 * GBRA-218: members and groups for per-member read access inside one brain.
 *
 * A member is a named person (`alice-example`), optionally in groups
 * (`team-a`). Access tokens, OAuth clients and the stdio server bind to one
 * member; pages name their readers in frontmatter `readable_by`. Everything
 * here lives in the database, so a repo-less brain gets it unchanged.
 *
 * Ids are never reused: `removeMember` tombstones the row, and `addMember`
 * refuses a tombstoned id (access_member_id_retired). `disableMember` is the
 * reversible option. A credential bound to a disabled, tombstoned or missing
 * member is refused at verification (`verifiedMember`, access_member_disabled).
 */
import type { BrainEngine } from '../engine.ts';
import type { SqlQuery } from '../sql-query.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { ACCESS_ID_RE, identityFor, normalizePrincipal } from './principals.ts';

export interface MemberRecord {
  id: string;
  display_name: string | null;
  status: 'enabled' | 'disabled' | 'removed';
  groups: string[];
  created_at: string | null;
}

export interface CredentialRef { kind: 'token' | 'client'; id: string; name: string }

export interface PageRef { slug: string; source_id: string }

export interface MemberRemovalPreview {
  member: MemberRecord;
  bound_credentials: CredentialRef[];
  pages: PageRef[];
  pages_truncated: boolean;
  note: string;
}

const PREVIEW_PAGE_LIMIT = 50;
const MEMBER_LIST_FIX: Action = {
  argv: ['gbrain', 'access', 'member', 'list', '--all', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
  why: 'Read-only: lists every member id on this brain with its status.',
  verify: { argv: ['gbrain', 'access', 'member', 'list', '--all', '--json'] },
};

function memberInvalid(message: string, reason: string, suggestion: string, why: string): OperationError {
  return opError('access_member_invalid', message, suggestion, { reason, why, fix: MEMBER_LIST_FIX });
}

function retired(id: string, suggestion: string, why: string): OperationError {
  return opError('access_member_id_retired', `Member id "${id}" was removed and can never be reused.`, suggestion, { why, fix: MEMBER_LIST_FIX });
}

/** A member or group id, validated; throws access_member_invalid otherwise. */
export function assertAccessId(raw: unknown, what: 'member' | 'group' = 'member'): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (ACCESS_ID_RE.test(id)) return id;
  throw memberInvalid(`"${String(raw ?? '')}" is not a valid ${what} id.`, 'ill_formed',
    `Use 1-64 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit (for example ${what === 'member' ? 'alice-example' : 'team-a'}).`,
    'Ids are matched exactly against page readers, so only one canonical spelling is accepted.');
}

/** A comma-separated list of ids, each validated; empty entries dropped. */
export function parseIdList(raw: string | undefined, what: 'member' | 'group'): string[] {
  return [...new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => assertAccessId(s, what)))];
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toRecord(row: Record<string, unknown>): MemberRecord {
  return {
    id: String(row.id),
    display_name: (row.display_name as string | null) ?? null,
    status: row.tombstoned_at != null ? 'removed' : row.disabled_at != null ? 'disabled' : 'enabled',
    groups: Array.isArray(row.groups) ? (row.groups as string[]) : [],
    created_at: iso(row.created_at),
  };
}

const MEMBER_SELECT = `SELECT m.id, m.display_name, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id`;

export async function getMember(engine: BrainEngine, id: string): Promise<MemberRecord | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(`${MEMBER_SELECT} WHERE m.id = $1 GROUP BY m.id`, [id]);
  return row ? toRecord(row) : null;
}

export async function listMembers(engine: BrainEngine, opts: { includeRemoved?: boolean } = {}): Promise<MemberRecord[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `${MEMBER_SELECT}${opts.includeRemoved ? '' : ' WHERE m.tombstoned_at IS NULL'} GROUP BY m.id ORDER BY m.id`);
  return rows.map(toRecord);
}

async function existingMember(engine: BrainEngine, raw: unknown, action: string): Promise<MemberRecord> {
  const id = assertAccessId(raw);
  const member = await getMember(engine, id);
  if (member) return member;
  throw memberInvalid(`No member "${id}" exists on this brain.`, 'unknown',
    `Check the id with gbrain access member list, or add it: gbrain access member add ${id}.`,
    `Only an existing member can be ${action}; an unknown id is refused rather than read as unbound.`);
}

/** The enabled member `raw` names, or a refusal saying why it cannot be used. */
async function requireEnabledMember(engine: BrainEngine, raw: unknown): Promise<MemberRecord> {
  const member = await existingMember(engine, raw, 'bound or previewed');
  if (member.status === 'enabled') return member;
  throw memberInvalid(`Member "${member.id}" is ${member.status}.`, member.status,
    member.status === 'disabled' ? `Enable it first (gbrain access member enable ${member.id}), or name another member.` : 'Removed ids are never reused; add a new member id.',
    'Only an enabled member can be bound or previewed.');
}

/** The identity set `--as <member>` reads with; refuses an ill-formed or non-enabled member before any work. */
export async function memberIdentity(engine: BrainEngine, raw: unknown): Promise<{ member: string; groups: string[]; identity: string[] }> {
  const member = await requireEnabledMember(engine, raw);
  return { member: member.id, groups: member.groups, identity: identityFor(member.id, member.groups) };
}

async function ensureGroups(engine: BrainEngine, groups: readonly string[]): Promise<string[]> {
  const created: string[] = [];
  for (const g of groups) {
    const rows = await engine.executeRaw<{ id: string }>('INSERT INTO access_groups (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id', [g]);
    if (rows.length) created.push(g);
  }
  return created;
}

/** The one active legacy token named `name`; refuses none or several. */
export async function legacyTokenByName(engine: BrainEngine, name: string): Promise<CredentialRef> {
  const rows = await engine.executeRaw<{ id: string; name: string }>(
    'SELECT id::text AS id, name FROM access_tokens WHERE name = $1 AND revoked_at IS NULL ORDER BY created_at', [name]);
  if (rows.length === 1) return { kind: 'token', id: rows[0]!.id, name: rows[0]!.name };
  throw opError('invalid_params', rows.length === 0 ? `No active token named "${name}".` : `${rows.length} active tokens are named "${name}".`,
    rows.length === 0 ? 'List tokens with gbrain auth list, then bind one by name.' : 'Bind one of them by id: gbrain auth rescope --id <uuid> --member <id> (ids from gbrain auth list).',
    { why: 'A binding names exactly one credential.' });
}

export interface AddMemberResult { member: MemberRecord; groups_created: string[]; bound: CredentialRef | null }

export async function addMember(engine: BrainEngine, rawId: unknown, opts: { name?: string; groups?: readonly string[]; bindToken?: string } = {}): Promise<AddMemberResult> {
  const id = assertAccessId(rawId);
  const groups = (opts.groups ?? []).map(g => assertAccessId(g, 'group'));
  const existing = await getMember(engine, id);
  if (existing?.status === 'removed') {
    throw retired(id, 'Choose a new member id (for example with a numeric suffix).',
      'Pages and audit history may still name the removed id; reusing it would hand that history to a different person.');
  }
  if (existing) {
    throw memberInvalid(`Member "${id}" already exists (${existing.status}).`, 'exists',
      existing.status === 'disabled' ? `Enable it with gbrain access member enable ${id}.` : `Change its groups with gbrain access group add <group> --members ${id}.`,
      'add creates a member once; it never edits an existing one.');
  }
  const bindTarget = opts.bindToken ? await legacyTokenByName(engine, opts.bindToken) : null;
  let created: string[] = [];
  await engine.transaction(async tx => {
    await tx.executeRaw('INSERT INTO access_members (id, display_name) VALUES ($1, $2)', [id, opts.name ?? null]);
    created = await ensureGroups(tx, groups);
    for (const g of groups) await tx.executeRaw('INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [g, id]);
    if (bindTarget) await tx.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id::text = $1', [bindTarget.id, id]);
  });
  return { member: (await getMember(engine, id))!, groups_created: created, bound: bindTarget };
}

async function setDisabled(engine: BrainEngine, rawId: unknown, disabled: boolean): Promise<MemberRecord> {
  const member = await existingMember(engine, rawId, disabled ? 'disabled' : 'enabled');
  if (member.status === 'removed') throw retired(member.id, 'Add a new member id instead.', 'A removed member stays removed; enabling it would hand its history back.');
  await engine.executeRaw(`UPDATE access_members SET disabled_at = ${disabled ? 'COALESCE(disabled_at, now())' : 'NULL'}, updated_at = now() WHERE id = $1`, [member.id]);
  return (await getMember(engine, member.id))!;
}

export const disableMember = (engine: BrainEngine, id: unknown) => setDisabled(engine, id, true);
export const enableMember = (engine: BrainEngine, id: unknown) => setDisabled(engine, id, false);

/** Credentials whose stored binding names `id` (active tokens, clients not deleted). */
export async function boundCredentials(engine: BrainEngine, id: string): Promise<CredentialRef[]> {
  const tokens = await engine.executeRaw<{ id: string; name: string }>(
    'SELECT id::text AS id, name FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL ORDER BY name', [id]);
  const clients = await engine.executeRaw<{ id: string; name: string }>(
    "SELECT client_id AS id, client_name AS name FROM oauth_clients WHERE member_id = $1 AND (to_jsonb(oauth_clients)->>'deleted_at') IS NULL ORDER BY client_id", [id]);
  return [...tokens.map(t => ({ kind: 'token' as const, ...t })), ...clients.map(c => ({ kind: 'client' as const, ...c }))];
}

/** Pages whose readers name `principal` (member:<id> or group:<g>), bounded. */
async function pagesNaming(engine: BrainEngine, principal: string): Promise<{ pages: PageRef[]; truncated: boolean }> {
  const rows = await engine.executeRaw<PageRef>(
    `SELECT slug, source_id FROM pages WHERE frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id, slug LIMIT ${PREVIEW_PAGE_LIMIT + 1}`, [principal]);
  return { pages: rows.slice(0, PREVIEW_PAGE_LIMIT), truncated: rows.length > PREVIEW_PAGE_LIMIT };
}

export async function previewRemoveMember(engine: BrainEngine, rawId: unknown): Promise<MemberRemovalPreview> {
  const member = await existingMember(engine, rawId, 'removed');
  const { pages, truncated } = await pagesNaming(engine, `member:${member.id}`);
  return {
    member, bound_credentials: await boundCredentials(engine, member.id), pages, pages_truncated: truncated,
    note: `Removing "${member.id}" is permanent: the id can never be reused, its group memberships are dropped, credentials bound to it are refused at verification, and pages naming it become unreadable to it. gbrain access member disable ${member.id} is the reversible option.`,
  };
}

export async function removeMember(engine: BrainEngine, rawId: unknown): Promise<MemberRemovalPreview> {
  const preview = await previewRemoveMember(engine, rawId);
  if (preview.member.status === 'removed') return preview;
  await engine.transaction(async tx => {
    await tx.executeRaw('UPDATE access_members SET tombstoned_at = now(), disabled_at = COALESCE(disabled_at, now()), updated_at = now() WHERE id = $1', [preview.member.id]);
    await tx.executeRaw('DELETE FROM access_group_members WHERE member_id = $1', [preview.member.id]);
  });
  return { ...preview, member: (await getMember(engine, preview.member.id))! };
}

export interface GroupRecord { id: string; members: string[] }

export async function listGroups(engine: BrainEngine, id?: string): Promise<GroupRecord[]> {
  const rows = await engine.executeRaw<{ id: string; members: string[] }>(
    `SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id) FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
     ${id ? 'WHERE g.id = $1' : ''} GROUP BY g.id ORDER BY g.id`, id ? [id] : []);
  return rows.map(r => ({ id: r.id, members: r.members ?? [] }));
}

async function existingGroup(engine: BrainEngine, raw: unknown): Promise<GroupRecord> {
  const id = assertAccessId(raw, 'group');
  const [group] = await listGroups(engine, id);
  if (group) return group;
  throw memberInvalid(`No group "${id}" exists on this brain.`, 'unknown_group', 'List groups with gbrain access group list.', 'Only an existing group can change.');
}

/** Creates the group when missing and adds `members` (each an existing member that was not removed). */
export async function addGroup(engine: BrainEngine, rawId: unknown, members: readonly string[] = []): Promise<{ group: GroupRecord; created: boolean }> {
  const id = assertAccessId(rawId, 'group');
  for (const m of members) {
    const rec = await existingMember(engine, m, 'added to a group');
    if (rec.status === 'removed') throw retired(rec.id, 'Add a new member id instead.', 'A removed member cannot join a group.');
  }
  let created = false;
  await engine.transaction(async tx => {
    created = (await ensureGroups(tx, [id])).length > 0;
    for (const m of members) await tx.executeRaw('INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, m]);
  });
  return { group: (await listGroups(engine, id))[0]!, created };
}

/** Removes `members` from an existing group. */
export async function removeGroupMembers(engine: BrainEngine, rawId: unknown, members: readonly string[]): Promise<GroupRecord> {
  const group = await existingGroup(engine, rawId);
  for (const m of members) await engine.executeRaw('DELETE FROM access_group_members WHERE group_id = $1 AND member_id = $2', [group.id, assertAccessId(m)]);
  return (await listGroups(engine, group.id))[0]!;
}

export interface GroupRemovalPreview { group: GroupRecord; pages: PageRef[]; pages_truncated: boolean; note: string }

export async function previewRemoveGroup(engine: BrainEngine, rawId: unknown): Promise<GroupRemovalPreview> {
  const group = await existingGroup(engine, rawId);
  const { pages, truncated } = await pagesNaming(engine, `group:${group.id}`);
  return { group, pages, pages_truncated: truncated, note: `Pages naming group:${group.id} become readable by nobody through that group until it is added again.` };
}

export async function removeGroup(engine: BrainEngine, rawId: unknown): Promise<GroupRemovalPreview> {
  const preview = await previewRemoveGroup(engine, rawId);
  await engine.executeRaw('DELETE FROM access_groups WHERE id = $1', [preview.group.id]);
  return preview;
}

/** The normalized `may_act_for` list (member:<id>, group:<g>, guest or *); `none` clears it (null). */
export function parseMayActFor(raw: string): string[] | null {
  if (raw.trim() === 'none') return null;
  const out = new Set<string>();
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    if (entry === '*' || entry === 'guest') { out.add(entry); continue; }
    const p = normalizePrincipal(entry);
    if (!p) {
      throw memberInvalid(`"${entry}" is not a valid --may-act-for entry.`, 'ill_formed',
        'Use member ids, group:<id>, guest or *, comma-separated (for example alice-example,group:team-a), or none to clear it.',
        'may_act_for names the audiences a shared agent may act for; each entry must parse as a principal.');
    }
    out.add(p);
  }
  if (out.size === 0) throw memberInvalid('--may-act-for needs at least one entry, or none to clear it.', 'ill_formed', 'Pass a comma-separated list or none.', 'An empty list is ambiguous.');
  return [...out].sort();
}

/** A `--member <id>|none` value: null clears the binding; an id is validated (existence is checked when it is applied). */
export function parseMemberFlag(raw: string): string | null {
  return raw.trim() === 'none' ? null : assertAccessId(raw);
}

export interface BindingPatch { member?: string | null; mayActFor?: string[] | null }
export interface BindingResult { member: string | null; may_act_for: string[] | null; changed: boolean }

/**
 * Applies a member / may_act_for binding to one credential. `member` must
 * name an enabled member (null unbinds). The binding is not a grant axis: it
 * changes no scope, source or operation.
 */
export async function bindCredential(engine: BrainEngine, target: { kind: 'token' | 'client'; id: string }, patch: BindingPatch, opts: { dryRun?: boolean } = {}): Promise<BindingResult> {
  if (patch.member != null) await requireEnabledMember(engine, patch.member);
  const table = target.kind === 'token' ? 'access_tokens' : 'oauth_clients';
  const key = target.kind === 'token' ? 'id::text' : 'client_id';
  const [before] = await engine.executeRaw<{ member_id: string | null; may_act_for: string[] | null }>(
    `SELECT member_id, may_act_for FROM ${table} WHERE ${key} = $1`, [target.id]);
  if (!before) {
    throw opError('invalid_params', `No ${target.kind === 'token' ? 'token' : 'OAuth client'} "${target.id}" exists.`,
      target.kind === 'token' ? 'List tokens with gbrain auth list.' : 'List clients with gbrain auth clients --json.');
  }
  const member = patch.member === undefined ? before.member_id : patch.member;
  const mayActFor = patch.mayActFor === undefined ? before.may_act_for : patch.mayActFor;
  const changed = member !== before.member_id || JSON.stringify(mayActFor ?? null) !== JSON.stringify(before.may_act_for ?? null);
  if (changed && !opts.dryRun) {
    await engine.executeRaw(`UPDATE ${table} SET member_id = $2, may_act_for = $3::text[] WHERE ${key} = $1`, [target.id, member, mayActFor]);
  }
  return { member, may_act_for: mayActFor ?? null, changed };
}

/** A credential bound to a member that cannot read: verification refuses it. */
export class MemberBindingRefused extends Error {
  readonly code = 'access_member_disabled';
  constructor(readonly memberId: string, readonly reason: 'disabled' | 'removed' | 'missing' | 'malformed') {
    super(`access_member_disabled: this credential is bound to member "${memberId}", which is ${reason === 'malformed' ? 'not a valid member id' : reason}. `
      + 'Ask the brain operator to enable the member (gbrain access member enable <id>) or rebind the credential (gbrain auth rescope ... --member <id>|none).');
  }
}

/**
 * The verify join: the live member a credential's stored `member_id` names,
 * with its groups. Null for an unbound credential (no member_id, or a schema
 * that predates the column). A binding to a disabled, removed or missing
 * member throws MemberBindingRefused, and so does an unreadable member table.
 */
export async function verifiedMember(sql: SqlQuery, memberId: unknown): Promise<{ id: string; groups: string[] } | null> {
  if (memberId == null) return null;
  if (typeof memberId !== 'string' || !ACCESS_ID_RE.test(memberId)) throw new MemberBindingRefused(String(memberId), 'malformed');
  const [row] = await sql`SELECT m.id, m.disabled_at, m.tombstoned_at,
    COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
    FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
    WHERE m.id = ${memberId} GROUP BY m.id`;
  if (!row) throw new MemberBindingRefused(memberId, 'missing');
  if (row.tombstoned_at != null) throw new MemberBindingRefused(memberId, 'removed');
  if (row.disabled_at != null) throw new MemberBindingRefused(memberId, 'disabled');
  return { id: memberId, groups: (Array.isArray(row.groups) ? row.groups as string[] : []).filter(g => ACCESS_ID_RE.test(g)) };
}

/** A stored `may_act_for` value as AuthInfo carries it: the text array, or null. */
export function storedMayActFor(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
}
