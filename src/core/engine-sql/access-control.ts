/**
 * Folder access reads: one SQL implementation for both engines. The access functions
 * (`gbrain_access_*`) are created by the schema migrations; a caller that wants a failed read
 * to count as restricted catches the error itself (`search/private-visibility.ts`).
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { edgeTrimSql } from '../edge-whitespace.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/**
 * Whether a page known by its slug sits under an applied folder rule, under a pending or invalid folder prefix, or
 * this database role cannot read the folder access tables. Judged against the applied rules, not a page row's stamp.
 */
export async function isFolderRestricted(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ restricted: boolean }>(
    'SELECT (gbrain_access_folder_rules($1, $2) IS NOT NULL OR gbrain_access_pending_covers($1, $2) OR gbrain_access_state_unreadable()) AS restricted', [sourceId, slug]);
  return row?.restricted === true;
}

/** The newest applied folder-rule revision of one source, null when no revision of it has been applied. */
export interface AppliedPolicyRevision {
  source_id: string;
  rev: number | null;
}

/** The statement whoami and `_meta.access` (access/caller.ts appliedAccessSummary) ran through executeRaw. */
export const APPLIED_POLICY_REVISIONS_SQL = `SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id COLLATE "C"`;

/** Each source with folder access state and its newest applied revision, by source id. */
export async function listAppliedPolicyRevisions(exec: LegacyUnscopedRead): Promise<AppliedPolicyRevision[]> {
  const rows = await exec.executeRaw<{ source_id: string; rev: number | string | null }>(APPLIED_POLICY_REVISIONS_SQL);
  return rows.map(r => ({ source_id: r.source_id, rev: r.rev === null ? null : Number(r.rev) }));
}

/**
 * Where a member lookup reads the member id (access/caller.ts memberIdentityFor): the id itself, the trimmed config
 * value of the key, a live legacy token's member, or a live OAuth client's member.
 */
export type MemberBindingVia = 'member' | 'stdio_config' | 'legacy_token' | 'oauth_client';

/** The same set under the name main's callers and tests import (`LiveMemberVia`). */
export type LiveMemberVia = MemberBindingVia;
/** The engine's own executeRaw, so a statement fault a test injects on the engine reaches the access read. */
export interface MemberLookupRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/**
 * Where a caller's may_act_for list is stored: a live legacy token row (id), a live OAuth client row (client id), or the
 * config value a stdio server reads (config key, mcp.stdio_may_act_for).
 */
export type MayActForVia = 'legacy_token' | 'oauth_client' | 'stdio_config';

/** The statements access/caller.ts mayActForOf ran through executeRaw, by where the list is stored. */
export const MAY_ACT_FOR_SQL: Record<MayActForVia, string> = {
  legacy_token: 'SELECT may_act_for FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL',
  oauth_client: 'SELECT may_act_for FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL',
  stdio_config: 'SELECT value FROM config WHERE key = $1',
};

/**
 * The stored may_act_for of one caller: a live token's or client's list (null when the row is revoked, deleted, absent
 * or holds no list), or the stdio config text as stored (null when the key is unset). The caller parses the text.
 */
export async function readMayActFor(exec: MemberLookupRead, via: MayActForVia, key: string): Promise<string[] | string | null> {
  if (via === 'stdio_config') {
    const [row] = await exec.executeRaw<{ value: string | null }>(MAY_ACT_FOR_SQL.stdio_config, [key]);
    return row?.value ?? null;
  }
  const [row] = await exec.executeRaw<{ may_act_for: unknown }>(MAY_ACT_FOR_SQL[via], [key]);
  return Array.isArray(row?.may_act_for) ? row!.may_act_for as string[] : null;
}

/** Which credential a queued remote job's principal names: an OAuth client or a legacy access token. */
export type JobPrincipalKind = 'oauth_client' | 'legacy_token';

/**
 * The statements minions/submission-authority.ts assertCurrentRemoteJobPrincipal ran through executeRaw, by principal
 * kind. Neither filters on revocation: the caller reads deleted_at or revoked_at itself and names which one denied the job.
 */
export const JOB_PRINCIPAL_SQL: Record<JobPrincipalKind, string> = {
  oauth_client: 'SELECT client_id, deleted_at, scope, source_id, bound_slug_prefixes, surface, allowed_operations FROM oauth_clients WHERE client_id = $1',
  legacy_token: 'SELECT * FROM access_tokens WHERE id = $1',
};

/** The stored row of a remote job's principal (revoked and deleted rows included), or null when there is none. */
export async function readJobPrincipal(exec: MemberLookupRead, principal: { kind: JobPrincipalKind; id: string }): Promise<Record<string, unknown> | null> {
  const [row] = await exec.executeRaw<Record<string, unknown>>(JOB_PRINCIPAL_SQL[principal.kind], [principal.id]);
  return row ?? null;
}

/** A live (enabled, not tombstoned) access member and its groups, by group id. */
export interface LiveMemberRow {
  id: string;
  groups: string[];
}

/**
 * The statement access/caller.ts liveIdentity ran through executeRaw for `via`, with `key` bound as its one parameter
 * ($1); the text is pinned byte for byte by test/engine-sql-caller-raw-sql-pins.test.ts.
 */
export function liveMemberStatement(via: MemberBindingVia, key: string): { text: string; params: unknown[] } {
  const member = via === 'member' ? sqlFragment`${key}`
    : via === 'stdio_config' ? sqlFragment`SELECT ${trustedSql(edgeTrimSql('value'))} FROM config WHERE key = ${key}`
    : via === 'legacy_token' ? sqlFragment`SELECT member_id FROM access_tokens WHERE id::text = ${key} AND revoked_at IS NULL`
    : sqlFragment`SELECT member_id FROM oauth_clients WHERE client_id = ${key} AND deleted_at IS NULL`;
  return renderFragment(sqlFragment`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${member}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`);
}

/**
 * The live member `key` names through `via`, or null when there is none (unknown, disabled, tombstoned, unbound). A
 * failure is thrown unchanged: the caller tells a schema older than the member tables from a transient failure.
 */
export async function readLiveMember(exec: MemberLookupRead, via: MemberBindingVia, key: string): Promise<LiveMemberRow | null> {
  const { text, params } = liveMemberStatement(via, key);
  const [row] = await exec.executeRaw<LiveMemberRow>(text, params);
  return row ?? null;
}

/** An applied folder rule and the readers it names. */
export interface FolderRuleRow {
  source_id: string;
  rule_id: string;
  readable_by: string[];
}

/** A folder prefix that reads as nobody: a narrowing being stamped, an invalid policy file, or `!unreadable`. */
export interface FolderCoverageRow {
  source_id: string;
  prefix: string;
}

/** The applied folder rules whose readers meet `readers`, and every prefix that reads as nobody. */
export interface FolderAccessRows {
  rules: FolderRuleRow[];
  coverage: FolderCoverageRow[];
}

/** The statement access/caller.ts folderAccessForAll ran for the rules any of `readers` ($1) meets; pinned byte for byte. */
export const FOLDER_RULES_READABLE_BY_SQL = 'SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]';

/**
 * The statement access/caller.ts folderAccessForAll ran for the folder coverage; a database role that cannot read the
 * folder access tables adds `!unreadable` (covers everything). Pinned byte for byte.
 */
export const FOLDER_COVERAGE_SQL = `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id COLLATE "C", prefix COLLATE "C"`;

/**
 * The folder access rows a caller's record is built from (access/caller.ts folderAccessForAll): the applied rules any
 * of `readers` meets (none read when `readers` is empty) and the folder coverage. A failure is thrown unchanged: the
 * caller counts it as nothing satisfied and everything covered.
 */
export async function readFolderAccess(exec: MemberLookupRead, readers: readonly string[]): Promise<FolderAccessRows> {
  const rules = readers.length ? await exec.executeRaw<FolderRuleRow>(FOLDER_RULES_READABLE_BY_SQL, [[...readers]]) : [];
  const coverage = await exec.executeRaw<FolderCoverageRow>(FOLDER_COVERAGE_SQL);
  return { rules, coverage };
}

/** The enabled members and the existing groups an asserted audience names. */
export interface AudiencePrincipalRows {
  members: LiveMemberRow[];
  groups: string[];
}

/** The statements access/caller.ts resolveAudienceIdentities ran through executeRaw: the members, then the groups. */
export const AUDIENCE_MEMBERS_SQL = `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = ANY($1::text[]) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`;
export const AUDIENCE_GROUPS_SQL = 'SELECT id FROM access_groups WHERE id = ANY($1::text[])';

/**
 * Which of `memberIds` are enabled, untombstoned members (each with its groups) and which of `groupIds` are existing
 * groups. An empty list reads nothing. A failure is thrown unchanged; the caller reads every entry as unknown.
 */
export async function readAudiencePrincipals(exec: MemberLookupRead, memberIds: readonly string[], groupIds: readonly string[]): Promise<AudiencePrincipalRows> {
  const members = memberIds.length ? await exec.executeRaw<LiveMemberRow>(AUDIENCE_MEMBERS_SQL, [memberIds]) : [];
  const groups = groupIds.length ? (await exec.executeRaw<{ id: string }>(AUDIENCE_GROUPS_SQL, [groupIds])).map(r => r.id) : [];
  return { members: members.map(r => ({ id: r.id, groups: r.groups ?? [] })), groups };
}

/** One access_members row with its groups (sorted group ids), as access/members.ts turns it into a MemberRecord. */
export interface AccessMemberRow {
  id: string;
  display_name: string | null;
  email: string | null;
  kind: string | null;
  labelled_only: boolean | null;
  disabled_at: unknown;
  tombstoned_at: unknown;
  created_at: unknown;
  groups: string[];
}

/**
 * Which members to read: the one member with this id (any status), the members declaring this email (any status), or
 * every member (removed ones only when asked).
 */
export type AccessMemberLookup = { id: string } | { email: string } | { includeRemoved: boolean };

/**
 * The statements access/members.ts getMember, memberByEmail and listMembers ran through executeRaw, each spelled out
 * as one literal (the engine-sql dynamic-SQL guard): the member columns and groups, then the filter.
 */
export const ACCESS_MEMBER_SQL = {
  by_id: `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.id = $1 GROUP BY m.id`,
  by_email: `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.email = $1 GROUP BY m.id ORDER BY m.id COLLATE "C"`,
  live: `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.tombstoned_at IS NULL GROUP BY m.id ORDER BY m.id COLLATE "C"`,
  all: `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id GROUP BY m.id ORDER BY m.id COLLATE "C"`,
} as const;

/**
 * The member rows `by` names, by id: one member by exact id (none when absent), the members whose declared email is
 * exactly `email` (the caller case-folds it), or every member, where a removed
 * (tombstoned) member is filtered out in the statement unless `includeRemoved`. A failure is thrown unchanged.
 */
export async function readAccessMembers(exec: MemberLookupRead, by: AccessMemberLookup): Promise<AccessMemberRow[]> {
  if ('id' in by) return exec.executeRaw<AccessMemberRow>(ACCESS_MEMBER_SQL.by_id, [by.id]);
  if ('email' in by) return exec.executeRaw<AccessMemberRow>(ACCESS_MEMBER_SQL.by_email, [by.email]);
  return exec.executeRaw<AccessMemberRow>(by.includeRemoved ? ACCESS_MEMBER_SQL.all : ACCESS_MEMBER_SQL.live);
}

/** One live credential: an active (not revoked) legacy token or an OAuth client that is not deleted. */
export interface AccessCredentialRow {
  kind: 'token' | 'client';
  id: string;
  name: string;
}

/** Which credentials to read: the active legacy tokens named `tokenName`, or the credentials bound to member `memberId`. */
export type AccessCredentialLookup = { tokenName: string } | { memberId: string };

/** The statements access/members.ts legacyTokenByName and boundCredentials (tokens, then clients) ran through executeRaw. */
export const ACCESS_CREDENTIAL_SQL = {
  token_by_name: 'SELECT id::text AS id, name FROM access_tokens WHERE name = $1 AND revoked_at IS NULL ORDER BY created_at, id',
  tokens_by_member: 'SELECT id::text AS id, name FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL ORDER BY name COLLATE "C", id',
  clients_by_member: "SELECT client_id AS id, client_name AS name FROM oauth_clients WHERE member_id = $1 AND (to_jsonb(oauth_clients)->>'deleted_at') IS NULL ORDER BY client_id COLLATE \"C\"",
} as const;

/**
 * The live credentials `by` names: the active legacy tokens whose name is exactly `tokenName` (oldest first), or the
 * active tokens (by name) and then the clients that are not deleted (by client id) whose stored binding is exactly
 * `memberId`. Revoked tokens and deleted clients are filtered out in the statement. A failure is thrown unchanged.
 */
export async function readAccessCredentials(exec: MemberLookupRead, by: AccessCredentialLookup): Promise<AccessCredentialRow[]> {
  type Row = { id: string; name: string };
  if ('tokenName' in by) return (await exec.executeRaw<Row>(ACCESS_CREDENTIAL_SQL.token_by_name, [by.tokenName])).map(r => ({ kind: 'token', id: r.id, name: r.name }));
  const tokens = await exec.executeRaw<Row>(ACCESS_CREDENTIAL_SQL.tokens_by_member, [by.memberId]);
  const clients = await exec.executeRaw<Row>(ACCESS_CREDENTIAL_SQL.clients_by_member, [by.memberId]);
  return [...tokens.map(t => ({ kind: 'token' as const, id: t.id, name: t.name })), ...clients.map(c => ({ kind: 'client' as const, id: c.id, name: c.name }))];
}

/** The statement access/members.ts audienceMemberIds ran through executeRaw. */
export const AUDIENCE_KIND_MEMBERS_SQL = `SELECT id FROM access_members WHERE kind = 'audience' AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id COLLATE "C"`;

/**
 * The ids of the enabled, untombstoned members of kind `audience`, by id. A person, a disabled member and a removed
 * member are filtered out in the statement. A failure is thrown unchanged; the caller reads it as none.
 */
export async function listAudienceAccessMembers(exec: MemberLookupRead): Promise<string[]> {
  return (await exec.executeRaw<{ id: string }>(AUDIENCE_KIND_MEMBERS_SQL)).map(r => r.id);
}

/** A group and its member ids, by member id. */
export interface AccessGroupRow { id: string; members: string[] }

/**
 * The statements access/members.ts listGroups ran through executeRaw: every group, or the one group `$1` names, each
 * spelled out as one literal (the engine-sql dynamic-SQL guard).
 */
export const ACCESS_GROUP_SQL = {
  all: `SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id COLLATE "C") FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
      GROUP BY g.id ORDER BY g.id COLLATE "C"`,
  by_id: `SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id COLLATE "C") FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
     WHERE g.id = $1 GROUP BY g.id ORDER BY g.id COLLATE "C"`,
} as const;

/**
 * Every access group with its member ids, by id; or, given an id, the one group with exactly that id (never a member
 * id, another case or an injected predicate). A group with no members carries none.
 */
export async function readAccessGroups(exec: MemberLookupRead, id: string | null): Promise<AccessGroupRow[]> {
  const rows = id === null ? await exec.executeRaw<AccessGroupRow>(ACCESS_GROUP_SQL.all) : await exec.executeRaw<AccessGroupRow>(ACCESS_GROUP_SQL.by_id, [id]);
  return rows.map(r => ({ id: r.id, members: r.members ?? [] }));
}

/** A page by slug and source. */
export interface PageNamingReaderRow { slug: string; source_id: string }

/** The most pages listPagesNamingReader returns: access/members.ts pagesNaming shows 50 and reads one more to see a cut. */
export const PAGES_NAMING_READER_LIMIT = 51;

/** The statement access/members.ts pagesNaming ran through executeRaw, spelled out as one literal (LIMIT is PAGES_NAMING_READER_LIMIT). */
export const PAGES_NAMING_READER_SQL = `SELECT slug, source_id FROM pages WHERE frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 51`;

/** The most live pages listPagesNamingReader returns: access-read-by-nobody.ts checks 200 and reads one more to see a cut. */
export const LIVE_PAGES_NAMING_READER_LIMIT = 201;

/** The statement access-read-by-nobody.ts pagesReadByNobodyNaming ran through executeRaw (LIMIT is LIVE_PAGES_NAMING_READER_LIMIT). */
export const LIVE_PAGES_NAMING_READER_SQL = `SELECT slug, source_id FROM pages WHERE deleted_at IS NULL AND frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 201`;

/**
 * The pages, in every source and by (source, slug), whose normalized readers (`gbrain_access_readers`) name exactly
 * `principal` (`member:<id>` or `group:<id>`), at most PAGES_NAMING_READER_LIMIT of them. Soft-deleted pages count, as
 * before. `live` leaves soft-deleted pages out and returns at most LIVE_PAGES_NAMING_READER_LIMIT.
 */
export async function listPagesNamingReader(exec: MemberLookupRead, principal: string, opts: { live?: boolean } = {}): Promise<PageNamingReaderRow[]> {
  const rows = await exec.executeRaw<PageNamingReaderRow>(opts.live ? LIVE_PAGES_NAMING_READER_SQL : PAGES_NAMING_READER_SQL, [principal]);
  return rows.map(r => ({ slug: r.slug, source_id: r.source_id }));
}

/** One live credential bound to the brain owner: its kind, id, display name and grant row (guests/owner-credentials.ts). */
export interface OwnerCredentialRow { kind: 'client' | 'token'; id: string; name: string; row: unknown }

/** The statement guests/owner-credentials.ts ownerCredentials ran through executeRaw (its token row is tokenGrantJsonSql('t')). */
export const OWNER_CREDENTIAL_ROWS_SQL = "SELECT * FROM (SELECT 'token' AS kind, t.id::text AS id, t.name, jsonb_build_object('id', t.id, 'scopes', t.scopes, 'permissions', t.permissions, 'private_pages', t.private_pages, 'private_facts', t.private_facts, 'grant_revision', t.grant_revision, 'read_shared_revision', to_jsonb(t)->'read_shared_revision', 'source_grant', t.source_grant, 'source_id', t.source_id, 'federated_read', t.federated_read, 'allowed_operations', t.allowed_operations, 'takes_holders', t.takes_holders, 'min_trust', t.min_trust) AS row FROM access_tokens t WHERE t.member_id = $1 AND t.revoked_at IS NULL UNION ALL SELECT 'client' AS kind, c.client_id AS id, COALESCE(c.client_name, c.client_id) AS name, to_jsonb(c) - 'client_secret_hash' AS row FROM oauth_clients c WHERE c.member_id = $1 AND (to_jsonb(c)->>'deleted_at') IS NULL) q ORDER BY kind COLLATE \"C\", name COLLATE \"C\", id COLLATE \"C\"";

/**
 * The live credentials bound to member `memberId`: tokens that are not revoked and clients that are not deleted, each
 * with the row its grant is read from, by byte order of kind, name and id. A failure is thrown unchanged.
 */
export function listOwnerCredentialRows(exec: MemberLookupRead, memberId: string): Promise<OwnerCredentialRow[]> {
  return exec.executeRaw<OwnerCredentialRow>(OWNER_CREDENTIAL_ROWS_SQL, [memberId]);
}
