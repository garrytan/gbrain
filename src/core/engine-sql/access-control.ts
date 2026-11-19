/**
 * Folder access reads: one SQL implementation for both engines. The access functions
 * (`gbrain_access_*`) are created by the schema migrations; a caller that wants a failed read
 * to count as restricted catches the error itself (`search/private-visibility.ts`).
 */
import type { LegacyUnscopedRead } from './brands.ts';

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

/**
 * Which members to read: the one member with this id (any status), the members declaring this email (any status), or
 * every member (removed ones only when asked).
 */
export type AccessMemberLookup = { id: string } | { email: string } | { includeRemoved: boolean };

/** The member columns and groups access/members.ts reads. */
const ACCESS_MEMBER_SELECT = `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id`;

/** The statements access/members.ts getMember, memberByEmail and listMembers ran through executeRaw. */
export const ACCESS_MEMBER_SQL = {
  by_id: `${ACCESS_MEMBER_SELECT} WHERE m.id = $1 GROUP BY m.id`,
  by_email: `${ACCESS_MEMBER_SELECT} WHERE m.email = $1 GROUP BY m.id ORDER BY m.id`,
  live: `${ACCESS_MEMBER_SELECT} WHERE m.tombstoned_at IS NULL GROUP BY m.id ORDER BY m.id`,
  all: `${ACCESS_MEMBER_SELECT} GROUP BY m.id ORDER BY m.id`,
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
