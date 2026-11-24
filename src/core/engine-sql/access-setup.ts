/**
 * Access setup and policy-store reads and writes outside access/policy.ts: one SQL implementation for both engines.
 * The member keys and owner setup of commands/access-serves.ts, the policy-store migration journal of
 * access/policy-migrate.ts, the policy sources of access/policy-transfer.ts and the people folders of access/serves.ts.
 * Each statement is the text its caller ran through `executeRaw` at 6e123afe98, byte for byte
 * (test/engine-sql-caller-raw-sql-pins.test.ts). Every member runs on the executor it is given, so a member of a
 * transaction-bound engine runs on that transaction.
 */
import { accessAllowedSql, liveCoverageSql, privacyPartSql } from '../search/private-visibility.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** The engine's own executeRaw (a transaction-bound engine inside a transaction). */
export interface AccessSetupExec {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** A live access token as the member-key setup reads it; `federated_read` is a text[] value, `permissions` JSON. */
export interface LiveAccessTokenRow {
  member_id: string | null;
  token_hash: string;
  source_grant: string | null;
  source_id: string | null;
  federated_read: unknown;
  permissions: unknown;
}

/** A live member-bound key whose fixed read list holds a source that is not its write source. */
export interface MemberKeyReadingRow { name: string; member_id: string; federated_read: unknown }

/** An unfinished policy-store migration of a source; `receipts` is the journaled JSON object. */
export interface AccessMigrationRow { id: string; phase: string; direction: string; receipts: Record<string, unknown> }

/** The open pages of one (source, top-level folder, type, privacy part) group (access/open-pages.ts). */
export interface OpenPageCount { source: string; folder: string; type: string | null; visible: boolean; pages: number }

/** A prefix of a source the open-page count leaves out. */
export interface OpenPageExclusion { source: string; prefix: string }

/** The live pages of top-level people/<folder>/ folders, per source. */
export interface PeopleFolderCount { source_id: string; folder: string; pages: number }

export const UNBOUND_TOKEN_NAMES_SQL = 'SELECT DISTINCT name COLLATE "C" AS name FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NULL ORDER BY name';
export const UNBOUND_CLIENT_IDS_SQL = 'SELECT client_id FROM oauth_clients WHERE deleted_at IS NULL AND member_id IS NULL ORDER BY client_id COLLATE "C"';
export const LIVE_TOKEN_SQL = 'SELECT member_id, token_hash, source_grant, source_id, federated_read, permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL';
export const UNARCHIVED_SOURCE_IDS_SQL = 'SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE';
export const RECORD_SETUP_READS_SQL = "UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object('setup_reads', $2::text[]) WHERE name = $1 AND revoked_at IS NULL AND (permissions IS NULL OR jsonb_typeof(permissions) = 'object')";
export const KEYS_READING_SOURCE_SQL = "SELECT name, member_id, federated_read FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NOT NULL AND source_grant = 'federated' AND source_id <> $1 AND $1 = ANY(federated_read) ORDER BY name COLLATE \"C\"";
export const COMPANY_PAGE_COUNTS_SQL = "SELECT count(*)::int AS pages, count(*) FILTER (WHERE slug LIKE 'company/calls/%')::int AS calls FROM pages WHERE source_id = $1 AND deleted_at IS NULL";
export const REVOKE_TOKEN_SQL = 'UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL';
export const UNFINISHED_MIGRATION_SQL = `SELECT id, phase, direction, receipts FROM access_policy_migrations WHERE source_id = $1 AND phase <> 'switched' ORDER BY created_at DESC LIMIT 1`;
export const INSERT_MIGRATION_SQL = `INSERT INTO access_policy_migrations (id, source_id, direction, phase) VALUES ($1, $2, $3, 'started')`;
export const RECORD_MIGRATION_PHASE_SQL = 'UPDATE access_policy_migrations SET phase = $2, receipts = $3::text::jsonb, updated_at = now() WHERE id = $1';
export const SWITCH_MIGRATION_SQL = `UPDATE access_policy_migrations SET phase = 'switched', receipts = $2::text::jsonb, updated_at = now() WHERE id = $1`;
export const POLICY_STATE_SOURCES_SQL = 'SELECT source_id FROM access_policy_state ORDER BY source_id COLLATE "C"';
export const PEOPLE_FOLDER_PAGES_SQL = `SELECT source_id, split_part(slug, '/', 2) AS folder, count(*)::int AS pages FROM pages
      WHERE deleted_at IS NULL AND slug LIKE 'people/%/%' GROUP BY 1, 2 ORDER BY source_id COLLATE "C", split_part(slug, '/', 2) COLLATE "C"`;

/** Live tokens bound to no member, by name. */
export async function listUnboundTokenNames(exec: AccessSetupExec): Promise<string[]> {
  return (await exec.executeRaw<{ name: string }>(UNBOUND_TOKEN_NAMES_SQL)).map(r => r.name);
}

/** Live OAuth clients bound to no member, by client id. */
export async function listUnboundClientIds(exec: AccessSetupExec): Promise<string[]> {
  return (await exec.executeRaw<{ client_id: string }>(UNBOUND_CLIENT_IDS_SQL)).map(r => r.client_id);
}

/** The live token named `name`, or null. */
export async function readLiveAccessToken(exec: AccessSetupExec, name: string): Promise<LiveAccessTokenRow | null> {
  const [row] = await exec.executeRaw<LiveAccessTokenRow>(LIVE_TOKEN_SQL, [name]);
  return row ?? null;
}

/** The ids of `ids` that name a source that is not archived (in no set order). */
export async function filterUnarchivedSourceIds(exec: AccessSetupExec, ids: readonly string[]): Promise<string[]> {
  return (await exec.executeRaw<{ id: string }>(UNARCHIVED_SOURCE_IDS_SQL, [ids])).map(r => r.id);
}

/** Keeps `reads` as the source list setup gave the live token `name`, beside its other permission fields. */
export async function recordTokenSetupReads(exec: AccessSetupExec, name: string, reads: readonly string[]): Promise<void> {
  await exec.executeRaw(RECORD_SETUP_READS_SQL, [name, reads]);
}

/** Live member-bound keys whose fixed read list holds `sourceId` though it is not their write source, by name. */
export async function listKeysReadingSource(exec: AccessSetupExec, sourceId: string): Promise<MemberKeyReadingRow[]> {
  return exec.executeRaw<MemberKeyReadingRow>(KEYS_READING_SOURCE_SQL, [sourceId]);
}

/** The live pages of `sourceId`, and how many of them are under company/calls/. */
export async function countCompanyPages(exec: AccessSetupExec, sourceId: string): Promise<{ pages: number; calls: number }> {
  const [row] = await exec.executeRaw<{ pages: number | string; calls: number | string }>(COMPANY_PAGE_COUNTS_SQL, [sourceId]);
  return { pages: Number(row?.pages ?? 0), calls: Number(row?.calls ?? 0) };
}

/** Revokes the live token with id `id` (a revoked or missing one changes nothing). */
export async function revokeAccessTokenById(exec: AccessSetupExec, id: string): Promise<void> {
  await exec.executeRaw(REVOKE_TOKEN_SQL, [id]);
}

/** The newest migration of `sourceId` that has not switched, or null; `receipts` is parsed when it comes back as text. */
export async function readUnfinishedAccessMigration(exec: AccessSetupExec, sourceId: string): Promise<AccessMigrationRow | null> {
  const [row] = await exec.executeRaw<{ id: string; phase: string; direction: string; receipts: unknown }>(UNFINISHED_MIGRATION_SQL, [sourceId]);
  if (!row) return null;
  return { ...row, receipts: (typeof row.receipts === 'string' ? JSON.parse(row.receipts) : row.receipts) as Record<string, unknown> ?? {} };
}

/** Starts migration `id` of `sourceId` in `direction` ('to_git' or 'to_database'), at phase 'started'. */
export async function insertAccessMigration(exec: AccessSetupExec, id: string, sourceId: string, direction: string): Promise<void> {
  await exec.executeRaw(INSERT_MIGRATION_SQL, [id, sourceId, direction]);
}

/** Journals `phase` and `receipts` on migration `id`. */
export async function recordAccessMigrationPhase(exec: AccessSetupExec, id: string, phase: string, receipts: Record<string, unknown>): Promise<void> {
  await exec.executeRaw(RECORD_MIGRATION_PHASE_SQL, [id, phase, JSON.stringify(receipts)]);
}

/** Marks migration `id` switched with `receipts`. */
export async function switchAccessMigration(exec: AccessSetupExec, id: string, receipts: Record<string, unknown>): Promise<void> {
  await exec.executeRaw(SWITCH_MIGRATION_SQL, [id, JSON.stringify(receipts)]);
}

/** Every source that holds access state, by id. */
export async function listAccessPolicySources(exec: AccessSetupExec): Promise<string[]> {
  return (await exec.executeRaw<{ source_id: string }>(POLICY_STATE_SOURCES_SQL)).map(r => r.source_id);
}

/** The live pages under each top-level people/<folder>/ folder, by source then folder. */
export async function countPeopleFolderPages(exec: AccessSetupExec): Promise<PeopleFolderCount[]> {
  return (await exec.executeRaw<{ source_id: string; folder: string; pages: number | string }>(PEOPLE_FOLDER_PAGES_SQL))
    .map(r => ({ source_id: r.source_id, folder: r.folder, pages: Number(r.pages) }));
}

/** The open-page predicate over pages alias `p`: live, and the read path's floor with an empty identity admits it. */
export const openPageSql = (p: string) => {
  const floor = accessAllowedSql(p, [], []);
  // Inside a caller record (openPages carries the brain's schema version in one) the floor reads the record's coverage, which
  // names no pending prefix; a page under one is not open, so read them live as the floor does outside a record.
  return `${p}.deleted_at IS NULL AND ${floor}${floor.includes('access_pending_coverage') ? '' : liveCoverageSql(p)}`;
};

/**
 * The statement access/open-pages.ts openPages ran through `executeRaw`, rendered in the current access context (the
 * caller runs it outside any caller record): the open pages of `sources`, less each excluded prefix, grouped by source,
 * top-level folder ('(root)' for a slug with no '/'), type and whether privacyPartSql admits the page.
 */
export function openPagesStatement(sources: readonly string[], exclude: readonly OpenPageExclusion[]): { text: string; params: unknown[] } {
  const excluded = exclude.map(x => sqlFragment` AND NOT (p.source_id = ${x.source} AND starts_with(p.slug, ${x.prefix}))`);
  return renderFragment(sqlFragment`SELECT p.source_id AS source, CASE WHEN strpos(p.slug, '/') > 0 THEN split_part(p.slug, '/', 1) ELSE '(root)' END AS folder,
              p.type AS type, (${trustedSql(privacyPartSql('p'))}) AS visible, count(*)::int AS pages
         FROM pages p
        WHERE ${trustedSql(openPageSql('p'))} AND p.source_id = ANY(${[...sources]}::text[])${joinFragments(excluded, '')}
        GROUP BY 1, 2, 3, 4`);
}

/** The open pages of `sources` (openPagesStatement), one row per group in no set order; an empty list reads nothing. */
export async function countOpenPages(exec: AccessSetupExec, sources: readonly string[], exclude: readonly OpenPageExclusion[]): Promise<OpenPageCount[]> {
  if (!sources.length) return [];
  const { text, params } = openPagesStatement(sources, exclude);
  return (await exec.executeRaw<{ source: string; folder: string; type: string | null; visible: unknown; pages: number | string }>(text, params))
    .map(r => ({ source: r.source, folder: r.folder, type: r.type, visible: r.visible === true, pages: Number(r.pages) }));
}
