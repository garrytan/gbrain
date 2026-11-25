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

/**
 * Where a member lookup reads the member id (access/caller.ts memberIdentityFor): the id itself, the trimmed config
 * value of the key, a live legacy token's member, or a live OAuth client's member.
 */
export type MemberBindingVia = 'member' | 'stdio_config' | 'legacy_token' | 'oauth_client';
/** The engine's own executeRaw, so a statement fault a test injects on the engine reaches the access read. */
export interface MemberLookupRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
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
