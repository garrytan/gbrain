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
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id`;

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

/** A live (enabled, not tombstoned) access member and its groups, by group id. */
export interface LiveMemberRow {
  id: string;
  groups: string[];
}

/** The engine's own executeRaw, so a statement fault a test injects on the engine reaches the member lookup. */
export interface MemberLookupRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
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
  return renderFragment(sqlFragment`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
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

/** An applied folder rule whose readers name one of the caller's principals. */
export interface FolderRuleRow {
  source_id: string;
  rule_id: string;
  readable_by: string[];
}

/** A pending or invalid folder prefix (`''` for the whole source); `'!unreadable'` when this role cannot read them. */
export interface FolderCoverageRow {
  source_id: string;
  prefix: string;
}

/** The rows a caller's folder access is built from (access/caller.ts folderAccessForAll). */
export interface FolderAccessRows {
  rules: FolderRuleRow[];
  coverage: FolderCoverageRow[];
}

/** The statements access/caller.ts folderAccessForAll ran through executeRaw: the rules, then the coverage. */
export const FOLDER_RULES_FOR_READERS_SQL = 'SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]';
export const FOLDER_COVERAGE_SQL = `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`;

/**
 * The applied rules whose readers name any of `readers` (none read when `readers` is empty) and every pending or invalid
 * prefix by source and prefix. A failure is thrown unchanged; the caller reads it as satisfying nothing and covering everything.
 */
export async function readFolderAccess(exec: MemberLookupRead, readers: readonly string[]): Promise<FolderAccessRows> {
  const rules = readers.length ? await exec.executeRaw<FolderRuleRow>(FOLDER_RULES_FOR_READERS_SQL, [[...readers]]) : [];
  const coverage = await exec.executeRaw<FolderCoverageRow>(FOLDER_COVERAGE_SQL);
  return {
    rules: rules.map(r => ({ source_id: r.source_id, rule_id: r.rule_id, readable_by: r.readable_by ?? [] })),
    coverage: coverage.map(c => ({ source_id: c.source_id, prefix: c.prefix })),
  };
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

/** The enabled members and the existing groups an asserted audience names. */
export interface AudiencePrincipalRows {
  members: LiveMemberRow[];
  groups: string[];
}

/** The statements access/caller.ts resolveAudienceIdentities ran through executeRaw: the members, then the groups. */
export const AUDIENCE_MEMBERS_SQL = `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
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

/** Which members to read: the one member with this id (any status), or every member (removed ones only when asked). */
export type AccessMemberLookup = { id: string } | { includeRemoved: boolean };

/** The member columns and groups access/members.ts reads (MEMBER_SELECT there is this text). */
export const ACCESS_MEMBER_SELECT = `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id`;

/** The statements access/members.ts getMember and listMembers ran through executeRaw. */
export const ACCESS_MEMBER_SQL = {
  // Written out in full, not spliced from ACCESS_MEMBER_SELECT: a composed string may not carry a hand-written $n
  // (check:engine-sql-dynamic). The text is the select above plus the id filter.
  by_id: `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.id = $1 GROUP BY m.id`,
  live: `${ACCESS_MEMBER_SELECT} WHERE m.tombstoned_at IS NULL GROUP BY m.id ORDER BY m.id`,
  all: `${ACCESS_MEMBER_SELECT} GROUP BY m.id ORDER BY m.id`,
} as const;

/**
 * The member rows `by` names, by id: one member by exact id (none when absent), or every member, where a removed
 * (tombstoned) member is filtered out in the statement unless `includeRemoved`. A failure is thrown unchanged.
 */
export async function readAccessMembers(exec: MemberLookupRead, by: AccessMemberLookup): Promise<AccessMemberRow[]> {
  if ('id' in by) return exec.executeRaw<AccessMemberRow>(ACCESS_MEMBER_SQL.by_id, [by.id]);
  return exec.executeRaw<AccessMemberRow>(by.includeRemoved ? ACCESS_MEMBER_SQL.all : ACCESS_MEMBER_SQL.live);
}
