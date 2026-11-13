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
 *
 * GST-1158: a member may carry one operator-declared email (case-folded,
 * unique per brain), only so the operator can find the member when linking a
 * trusted system's id (`memberByEmail`). It never creates a member or a link.
 *
 * Audience members (GBRA-108 design 2): a member's kind is `person` (the default) or `audience` (a group chat, a
 * shared assistant). An owner read treats an audience member's own member page, its older versions, its derived pages
 * and its facts as if its readers named the owner (search/private-visibility.ts). Only the trusted local operator
 * sets it (`gbrain access member kind`, `member add --kind`); a remote caller is refused.
 */
import type { BrainEngine } from '../engine.ts';
import type { SqlQuery } from '../sql-query.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { hostOnlyError } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { ACCESS_ID_RE, identityFor, normalizePrincipal } from './principals.ts';
import { ACTOR_DEFERRED_OPS, DEFAULT_ATTEST_OPS } from './actor-model.ts';
import { applyAttestSources, SCOPE_ATTEST_OPS } from './attest-sources.ts';

export interface MemberRecord {
  id: string;
  display_name: string | null;
  email: string | null;
  status: 'enabled' | 'disabled' | 'removed';
  /** GBRA-108 design 2: person (the default) or audience (a group chat, a shared assistant; the owner reads its member page). */
  kind: MemberKind;
  /** GBRA-108 design 1: reads only pages that name it (access/labelled-only.ts); false by default. */
  labelled_only: boolean;
  groups: string[];
  created_at: string | null;
}

export type MemberKind = 'person' | 'audience';
export const MEMBER_KINDS: readonly MemberKind[] = ['person', 'audience'];

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

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

/** GST-1158: a declared email, trimmed and case-folded (ASCII only); throws access_member_invalid (invalid_email) otherwise. */
export function assertMemberEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().replace(/[A-Z]/g, c => c.toLowerCase()) : '';
  if (email.length <= 254 && EMAIL_RE.test(email) && !/[\x00-\x1f\x7f]/.test(email)) return email;
  throw memberInvalid('That is not a valid email address.', 'invalid_email',
    'Use one address with a single @ and no spaces, at most 254 characters (for example alice@example.com).',
    'An email only finds the member an operator links, so one canonical spelling keeps that lookup exact.');
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
    email: (row.email as string | null) ?? null,
    status: row.tombstoned_at != null ? 'removed' : row.disabled_at != null ? 'disabled' : 'enabled',
    kind: row.kind === 'audience' ? 'audience' : 'person',
    labelled_only: row.labelled_only === true,
    groups: Array.isArray(row.groups) ? (row.groups as string[]) : [],
    created_at: iso(row.created_at),
  };
}

const MEMBER_SELECT = `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
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

export async function existingMember(engine: BrainEngine, raw: unknown, action: string): Promise<MemberRecord> {
  const id = assertAccessId(raw);
  const member = await getMember(engine, id);
  if (member) return member;
  throw memberInvalid(`No member "${id}" exists on this brain.`, 'unknown',
    `Check the id with gbrain access member list, or add it: gbrain access member add ${id}.`,
    `Only an existing member can be ${action}; an unknown id is refused rather than read as unbound.`);
}

async function assertEmailFree(engine: BrainEngine, email: string, memberId: string): Promise<void> {
  const [row] = await engine.executeRaw<{ id: string }>('SELECT id FROM access_members WHERE email = $1', [email]);
  if (!row || row.id === memberId) return;
  throw memberInvalid(`Member "${row.id}" already declares that email.`, 'email_taken',
    `Check the address, or clear it there first: gbrain access member set ${row.id} --email none.`,
    'An email finds exactly one member, so it is unique per brain.');
}

/** A write that lost a race for one email (23505 on access_members_email_key, both engines' error shapes) refuses as assertEmailFree does. */
async function refuseEmailRace(engine: BrainEngine, error: unknown, email: string | null, memberId: string): Promise<never> {
  const e = (error ?? {}) as Record<string, unknown>;
  if (email !== null && String(e.code) === '23505' && (e.constraint_name ?? e.constraint) === 'access_members_email_key') await assertEmailFree(engine, email, memberId);
  throw error;
}

/** GST-1158: the one member whose declared email is `raw`; not_found when none, refused when several. Never creates one. */
export async function memberByEmail(engine: BrainEngine, raw: unknown): Promise<MemberRecord> {
  const email = assertMemberEmail(raw);
  const rows = await engine.executeRaw<Record<string, unknown>>(`${MEMBER_SELECT} WHERE m.email = $1 GROUP BY m.id ORDER BY m.id`, [email]);
  if (rows.length === 1) return toRecord(rows[0]!);
  if (!rows.length) {
    throw opError('not_found', 'No member declares that email.',
      `List members and their emails with gbrain access member list, then declare it on the right member: gbrain access member set followed by that member's id and --email ${email}.`,
      { why: 'An email only finds a member an operator declared it on; it never creates a member or a link.', fix: MEMBER_LIST_FIX });
  }
  throw memberInvalid(`${rows.length} members declare that email.`, 'email_ambiguous',
    'Link by member id instead (gbrain access member link <id> --qm <canonical id>), and clear the duplicate with gbrain access member set <id> --email none.',
    'A link by email is made only when exactly one member declares it.');
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

export async function addMember(engine: BrainEngine, rawId: unknown, opts: { name?: string; email?: unknown; groups?: readonly string[]; bindToken?: string; kind?: unknown; remote?: boolean } = {}): Promise<AddMemberResult> {
  const id = assertAccessId(rawId);
  const kind = opts.kind === undefined ? 'person' : assertMemberKind(opts.kind);
  if (kind !== 'person') assertLocalKindChange(opts, id, kind);
  const groups = (opts.groups ?? []).map(g => assertAccessId(g, 'group'));
  const email = opts.email === undefined ? null : assertMemberEmail(opts.email);
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
  if (email !== null) await assertEmailFree(engine, email, id);
  const bindTarget = opts.bindToken ? await legacyTokenByName(engine, opts.bindToken) : null;
  let created: string[] = [];
  await engine.transaction(async tx => {
    await tx.executeRaw('INSERT INTO access_members (id, display_name, email, kind) VALUES ($1, $2, $3, $4)', [id, opts.name ?? null, email, kind]);
    created = await ensureGroups(tx, groups);
    for (const g of groups) await tx.executeRaw('INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [g, id]);
    if (bindTarget) await tx.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id::text = $1', [bindTarget.id, id]);
  }).catch(error => refuseEmailRace(engine, error, email, id));
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

/** GST-1158: declares (or, with null, clears) a member's email; refuses an invalid address or one another member declares. */
export async function setMemberEmail(engine: BrainEngine, rawId: unknown, rawEmail: unknown): Promise<{ member: MemberRecord; changed: boolean }> {
  const member = await existingMember(engine, rawId, 'changed');
  if (member.status === 'removed') throw retired(member.id, 'Add a new member id instead.', 'A removed member stays removed; its email was cleared when it was removed.');
  const email = rawEmail === null ? null : assertMemberEmail(rawEmail);
  if (email === member.email) return { member, changed: false };
  if (email !== null) await assertEmailFree(engine, email, member.id);
  const updated = await engine.executeRaw<{ id: string }>('UPDATE access_members SET email = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL RETURNING id', [member.id, email]).catch(error => refuseEmailRace(engine, error, email, member.id));
  if (!updated.length) throw retired(member.id, 'Add a new member id instead.', 'A removed member stays removed; its email was cleared when it was removed.');
  return { member: (await getMember(engine, member.id))!, changed: true };
}

/** A member kind (person or audience), validated; throws access_member_invalid otherwise. */
export function assertMemberKind(raw: unknown): MemberKind {
  if (raw === 'person' || raw === 'audience') return raw;
  throw memberInvalid(`"${String(raw ?? '')}" is not a member kind.`, 'ill_formed', 'Use person or audience.',
    'An audience member (a group chat, a shared assistant) is read by the owner as its own; every other member is a person.');
}

/** Refuses a kind change from anything but the trusted local operator (remote strictly false), before anything is written. */
function assertLocalKindChange(ctx: { remote?: boolean }, id: string, kind: MemberKind): void {
  if (ctx.remote === false) return;
  throw hostOnlyError({ remote: true, transport: 'http' }, 'permission_denied',
    'Only the brain operator on the brain host marks a member as an audience or a person, so nothing was changed.',
    ['gbrain', 'access', 'member', 'kind', id, kind],
    'An audience member\'s own member page, derived pages and facts are read by the brain owner. Whether the owner reads them is the brain operator\'s decision, never an agent\'s.');
}

/**
 * GBRA-108 design 2: marks a member as an audience (a group chat, a shared assistant) or a person. Only the trusted
 * local operator may (setOwnerReadsRestricted's rule): a remote caller is refused before anything is written.
 */
export async function setMemberKind(engine: BrainEngine, rawId: unknown, rawKind: unknown, ctx: { remote?: boolean }): Promise<{ member: MemberRecord; changed: boolean }> {
  const id = assertAccessId(rawId);
  const kind = assertMemberKind(rawKind);
  assertLocalKindChange(ctx, id, kind);
  const member = await existingMember(engine, id, 'changed');
  if (member.status === 'removed') throw retired(member.id, 'Add a new member id instead.', 'A removed member stays removed.');
  if (member.kind === kind) return { member, changed: false };
  await engine.executeRaw('UPDATE access_members SET kind = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL', [member.id, kind]);
  return { member: (await getMember(engine, member.id))!, changed: true };
}

/** GBRA-108 design 2: the enabled audience members, sorted; empty when none or unreadable (nothing widens). */
export async function audienceMemberIds(engine: Pick<BrainEngine, 'executeRaw'>): Promise<string[]> {
  try {
    const rows = await engine.executeRaw<{ id: string }>(
      "SELECT id FROM access_members WHERE kind = 'audience' AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id");
    return rows.map(r => r.id).filter(id => ACCESS_ID_RE.test(id));
  } catch {
    return [];
  }
}

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
    await tx.executeRaw('UPDATE access_members SET tombstoned_at = now(), disabled_at = COALESCE(disabled_at, now()), email = NULL, updated_at = now() WHERE id = $1', [preview.member.id]);
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

/** GST-359 C1: attestActor names the system whose actor header this credential may send (null clears it, attestOps and attestRead). */
/** GST-1113: attestSources lists the scope sources an attested memory_write may name (null clears it; access/attest-sources.ts). */
/** GST-363: readsUnscoped true sets reads_unscoped (kept when already set), false clears it; undefined leaves it. */
export interface BindingPatch { member?: string | null; mayActFor?: string[] | null; attestActor?: string | null; attestOps?: string[] | null; attestSources?: string[] | null; attestRead?: 'person' | 'scope' | null; readsUnscoped?: boolean }
export interface BindingResult { member: string | null; may_act_for: string[] | null; attest_actor?: string; attest_ops?: string[] | null; attest_sources?: string[] | null; attest_read?: 'person' | 'scope' | null; reads_unscoped?: boolean; changed: boolean }

function attestRefused(message: string, suggestion: string): OperationError {
  return opError('invalid_params', message, suggestion, { why: 'Only a credential bound to no member that authenticates as itself (a client-credentials client with a secret, or a legacy token) may name the people a trusted system serves.' });
}

/**
 * Applies a member / may_act_for binding to one credential. `member` must
 * name an enabled member (null unbinds). The binding is not a grant axis: it
 * changes no scope, source or operation.
 */
export async function bindCredential(engine: BrainEngine, target: { kind: 'token' | 'client'; id: string }, patch: BindingPatch, opts: { dryRun?: boolean } = {}): Promise<BindingResult> {
  if (patch.member != null) await requireEnabledMember(engine, patch.member);
  const table = target.kind === 'token' ? 'access_tokens' : 'oauth_clients';
  const key = target.kind === 'token' ? 'id::text' : 'client_id';
  // GST-1113: lock the credential row first and read it under the lock (grant rescopes lock it first too), so a
  // concurrent rescope commits before or after this change, never between its checks and its write.
  return engine.transaction(async tx => {
    const unscopedPatch = patch.readsUnscoped !== undefined;
    const [before] = await tx.executeRaw<{ member_id: string | null; may_act_for: string[] | null; attest_actor: string | null; attest_ops: string[] | null; attest_sources: string[] | null; attest_read: 'person' | 'scope' | null; grant_types?: string[] | null; confidential?: boolean; reads_unscoped?: unknown }>(
      `SELECT member_id, may_act_for, attest_actor, attest_ops, attest_sources, attest_read${target.kind === 'client' ? ', grant_types, client_secret_hash IS NOT NULL AS confidential' : ''}${unscopedPatch ? ', reads_unscoped' : ''} FROM ${table} WHERE ${key} = $1 FOR UPDATE`, [target.id]);
    if (!before) {
      throw opError('invalid_params', `No ${target.kind === 'token' ? 'token' : 'OAuth client'} "${target.id}" exists.`,
        target.kind === 'token' ? 'List tokens with gbrain auth list.' : 'List clients with gbrain auth clients --json.');
    }
    const member = patch.member === undefined ? before.member_id : patch.member;
    const mayActFor = patch.mayActFor === undefined ? before.may_act_for : patch.mayActFor;
    const attestActor = patch.attestActor === undefined ? before.attest_actor : patch.attestActor;
    const attestOps = attestActor === null ? null : patch.attestOps === undefined ? before.attest_ops : patch.attestOps;
    const attestSources = attestActor === null ? null : patch.attestSources === undefined ? before.attest_sources : patch.attestSources?.length ? [...new Set(patch.attestSources)].sort() : null;
    const attestRead = attestActor === null ? null : patch.attestRead === undefined ? before.attest_read : patch.attestRead;
    const what = target.kind === 'token' ? 'This token' : `OAuth client ${target.id}`;
    if (patch.attestOps != null && attestActor === null) throw attestRefused('--attest-ops needs the attest right.', 'Pass --attest-actor qm with it.');
    if (patch.attestSources != null && attestActor === null) throw attestRefused('--attest-sources needs the attest right.', 'Pass --attest-actor qm with it.');
    if (patch.attestRead != null && attestActor === null) throw attestRefused('--attest-read needs the attest right.', 'Pass --attest-actor qm with it.');
    if (attestSources && attestRead === 'person') throw attestRefused(`${what} lists scope sources (--attest-sources), so the sources it names are read as the scope, never as the person.`, 'Drop --attest-read person, or use a separate credential for the person\'s own conversations.');
    // GST-1113: a credential that writes scope memory runs only the memory operations as a person, never a general read.
    const outside = attestSources ? (attestOps ?? DEFAULT_ATTEST_OPS).filter(op => !SCOPE_ATTEST_OPS.has(op)) : [];
    if (outside.length) throw attestRefused(`${what} lists scope sources (--attest-sources), so its attested operations stay within ${[...SCOPE_ATTEST_OPS].join(', ')}; ${outside.join(', ')} is not.`, 'Drop those operations (--attest-ops), or use a separate credential for them.');

    const deferred = (patch.attestOps ?? []).filter(op => ACTOR_DEFERRED_OPS.has(op));
    if (deferred.length) throw attestRefused(`--attest-ops names ${deferred.join(', ')}, which an attested actor cannot run yet.`, `Leave them out. Not attestable yet: ${[...ACTOR_DEFERRED_OPS].join(', ')}.`);
    if (attestActor !== null && (patch.attestActor !== undefined || patch.member !== undefined)) {
      if (member !== null) throw attestRefused(`${what} is bound to member "${member}", so it cannot attest other people.`, 'Use a credential bound to no member (--member none), or a separate client for the trusted system.');
      if (target.kind === 'client' && (!(before.grant_types ?? []).includes('client_credentials') || before.confidential !== true)) {
        throw attestRefused(`${what} is not a confidential client-credentials client, so it cannot attest people.`,
          'Register one for the trusted system: gbrain auth register-client <name> --grant-types client_credentials, then grant it --attest-actor qm.');
      }
    }
    let changed = member !== before.member_id || JSON.stringify(mayActFor ?? null) !== JSON.stringify(before.may_act_for ?? null)
      || attestActor !== before.attest_actor || JSON.stringify(attestOps ?? null) !== JSON.stringify(before.attest_ops ?? null)
      || JSON.stringify(attestSources ?? null) !== JSON.stringify(before.attest_sources ?? null) || (attestRead ?? null) !== (before.attest_read ?? null);
    if (changed || patch.attestSources != null) {
      // GST-1113: the scope-source checks, the marks and the binding commit together, under this row's lock and then the
      // marked sources' row locks. A restated list also re-marks a listed source that lost its mark.
      if (await applyAttestSources(tx, target, attestSources ?? null, before.attest_sources ?? null, opts)) changed = true;
      if (!opts.dryRun) {
        await tx.executeRaw(`UPDATE ${table} SET member_id = $2, may_act_for = $3::text[], attest_actor = $4, attest_ops = $5::text[], attest_sources = $6::text[], attest_read = $7 WHERE ${key} = $1`,
          [target.id, member, mayActFor, attestActor, attestOps, attestSources, attestRead ?? null]);
      }
    }
    // GST-363: the opt-out records when it was granted; restating it keeps that time.
    const readsUnscoped = unscopedPatch ? patch.readsUnscoped! : undefined;
    if (unscopedPatch && readsUnscoped !== (before.reads_unscoped != null)) {
      changed = true;
      if (!opts.dryRun) await tx.executeRaw(`UPDATE ${table} SET reads_unscoped = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE ${key} = $1`, [target.id, readsUnscoped]);
    }
    return { member, may_act_for: mayActFor ?? null, ...(attestActor ? { attest_actor: attestActor, attest_ops: attestOps ?? null, attest_sources: attestSources ?? null, attest_read: attestRead ?? null } : {}),
      ...(readsUnscoped !== undefined ? { reads_unscoped: readsUnscoped } : {}), changed };
  });
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
