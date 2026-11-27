/**
 * The reads the CLI import and extract paths ran through `executeRaw` before they had typed members
 * (docs/research/rust-cli-executeraw-map.md, "Source lists and source rows", "Guest-source checks", "Extract reads").
 * Each function keeps the statement text its call site ran, so PGLite and Postgres answer exactly as before; a Rust
 * brain answers from its store (rust/crates/gbrain-store/src/cli_reads/import.rs).
 */
import type { PageTrustLookup, PageTrustRow, RowTrustLookup, RowTrustRow } from '../engine.ts';
import { guestSourceSql } from '../guests/note.ts';
import { activationSuppressedSql, contestedRefSql } from '../eligibility/sql.ts';
import { precedenceSql } from '../eligibility/precedence.ts';
import { isMissingSchemaObject } from '../utils.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { RawQuery } from './executor.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { GuestSourceLookupRow, SourceIncarnationRow, SourceRecordRow } from '../engine.ts';
import { GUEST_SOURCES_HIDDEN_SQL } from '../guests/note.ts';

/** The guest sources among `sourceIds` (guestSourceSql), in no particular order. */
export async function listGuestSourceIds(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const { text, params } = renderFragment(sqlFragment`SELECT s.id FROM sources s WHERE s.id = ANY(${[...new Set(sourceIds)]}::text[])
    AND ${trustedSql(guestSourceSql('s.config', 's.id'))}`);
  const rows = await exec.executeRaw<{ id: string }>(text, params);
  return rows.map(row => row.id);
}

/** The guest flag of a brain whose schema is behind the guest-notes migration: the config record alone (guests/marker.ts withGuestSourceSql). */
const CONFIG_GUEST_SQL = "COALESCE(s.config->>'guest' = 'true', false)";

const guestSqlFor = (tableGuest: boolean) => (config: string, id: string): string => (tableGuest ? guestSourceSql(config, id) : `COALESCE(${config}->>'guest' = 'true', false)`);

// C3 (source precedence, eligibility/precedence.ts): each page's class rides with its trust fields.
const trustColumns = (tableGuest: boolean) => sqlFragment`pages.id, pages.source_id, pages.slug, trust_tier, write_origin, ${trustedSql(activationSuppressedSql('pages', 'pages'))} AS flagged,
  ${trustedSql(tableGuest ? guestSourceSql('s.config', 'pages.source_id') : CONFIG_GUEST_SQL)} AS guest,
  ${trustedSql(precedenceSql({ source: 's', sourceId: 'pages.source_id', guest: guestSqlFor(tableGuest)('s.config', 'pages.source_id'), page: 'pages' }))} AS precedence
  FROM pages LEFT JOIN sources s ON s.id = pages.source_id`;

const ROW_TRUST_TABLES = { facts: 'facts', takes: 'takes', timeline_entries: 'timeline_entries' } as const;

/**
 * The trust rows of fact, take or timeline rows by id: the statement `stampRowTrust` (eligibility/stamp.ts) ran through
 * `executeRaw`. A timeline row has no supersede proposals, so its `contested` is null.
 */
export async function readRowTrustRows(exec: LegacyUnscopedRead, lookup: RowTrustLookup): Promise<RowTrustRow[]> {
  const table = ROW_TRUST_TABLES[lookup.table];
  if (!table) throw new Error(`readRowTrustRows: unknown table ${JSON.stringify(lookup.table)}`);
  if (lookup.ids.length === 0) return [];
  if (table === 'facts') {
    // C3: a fact's precedence is its source's class, or approved when it came from an allowed-claims page. A brain whose
    // schema is behind the guest-notes migration reads the guest flag from the config alone, as withGuestSourceSql does.
    const read = async (tableGuest: boolean): Promise<RowTrustRow[]> => {
      const { text, params } = renderFragment(sqlFragment`SELECT r.id, r.trust_tier, r.write_origin, ${trustedSql(activationSuppressedSql(table, 'r'))} AS flagged,
        ${trustedSql(contestedRefSql(table, 'r'))} AS contested, ${trustedSql(precedenceSql({ source: 'rs', sourceId: 'r.source_id', guest: guestSqlFor(tableGuest)('rs.config', 'r.source_id'), page: 'rp' }))} AS precedence
        FROM facts r LEFT JOIN sources rs ON rs.id = r.source_id
        LEFT JOIN pages rp ON rp.source_id = r.source_id AND rp.slug = r.source_markdown_slug AND rp.deleted_at IS NULL WHERE r.id = ANY(${[...lookup.ids]}::bigint[])`);
      return (await exec.executeRaw<RowTrustRow>(text, params)).map(row => ({ ...row, id: Number(row.id) }));
    };
    try { return await read(true); } catch (e) {
      if (!isMissingSchemaObject(e, 'table', 'guest_sources')) throw e;
      return read(false);
    }
  }
  const { text, params } = renderFragment(sqlFragment`SELECT r.id, r.trust_tier, r.write_origin, ${trustedSql(activationSuppressedSql(table, 'r'))} AS flagged,
    ${trustedSql(table === 'timeline_entries' ? 'NULL' : contestedRefSql(table, 'r'))} AS contested FROM ${trustedSql(table)} r WHERE r.id = ANY(${[...lookup.ids]}::bigint[])`);
  return (await exec.executeRaw<RowTrustRow>(text, params)).map(row => ({ ...row, id: Number(row.id) }));
}

/**
 * The trust rows of pages by id and by (source_id, slug): `byId` marks the rows found by id. A brain whose schema is
 * behind the guest-notes migration reads the guest flag from the config alone, as withGuestSourceSql does.
 */
export async function readPageTrustRows(exec: LegacyUnscopedRead, lookup: PageTrustLookup): Promise<PageTrustRow[]> {
  const ids = lookup.ids ?? [];
  const keys = lookup.keys ?? [];
  const read = async (tableGuest: boolean): Promise<PageTrustRow[]> => {
    const found: PageTrustRow[] = [];
    if (ids.length) {
      const { text, params } = renderFragment(sqlFragment`SELECT ${trustColumns(tableGuest)} WHERE pages.id = ANY(${[...ids]}::int[])`);
      for (const row of await exec.executeRaw<Omit<PageTrustRow, 'byId'>>(text, params)) found.push({ ...row, byId: true });
    }
    if (keys.length) {
      const { text, params } = renderFragment(sqlFragment`SELECT ${trustColumns(tableGuest)}
          WHERE ${trustedSql(lookup.includeDeleted ? '' : 'pages.deleted_at IS NULL AND ')}(pages.source_id, pages.slug) IN (SELECT * FROM unnest(${keys.map(k => k.source_id)}::text[], ${keys.map(k => k.slug)}::text[]))`);
      for (const row of await exec.executeRaw<Omit<PageTrustRow, 'byId'>>(text, params)) found.push({ ...row, byId: false });
    }
    return found;
  };
  try { return await read(true); } catch (e) {
    if (!isMissingSchemaObject(e, 'table', 'guest_sources')) throw e;
    return read(false);
  }
}

/**
 * Every source, `default` first, then by id (as `loadAllSources` orders them), with the columns `loadAllSources` reads. A brain whose schema lacks
 * `newest_content_at` (pre-v109) is read again without it, and one that also lacks `archived` (pre-v0.26.5) with the historical minimal columns, so a brain
 * that has `archived` always reports it.
 */
export async function listSourceRecords(exec: RawQuery, attempt: <T>(run: (exec: RawQuery) => Promise<T>) => Promise<T> = run => run(exec)): Promise<SourceRecordRow[]> {
  // `attempt` runs one shape as its own read: an engine that reads under a deadline puts each in its own transaction, which a missing-column error would otherwise leave failed for the next shape.
  const read = (sql: string) => attempt(e => e.executeRaw<SourceRecordRow>(sql));
  try {
    return await read(
      `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived, newest_content_at
         FROM sources
       ORDER BY (id = 'default') DESC, id`,
    );
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
  }
  try {
    return await read(
      `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived
         FROM sources
       ORDER BY (id = 'default') DESC, id`,
    );
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
  }
  return read(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
       FROM sources
     ORDER BY (id = 'default') DESC, id`,
  );
}

/** One source's config and incarnation, or null for an unknown id (the company-brain profile read). */
export async function readSourceIncarnation(exec: RawQuery, sourceId: string): Promise<SourceIncarnationRow | null> {
  const [row] = await exec.executeRaw<SourceIncarnationRow>('SELECT config,incarnation FROM sources WHERE id=$1', [sourceId]);
  return row ?? null;
}

/** Whether the source's current incarnation has a company-brain ingestion receipt. */
export async function hasCompanyBrainReceipt(exec: RawQuery, sourceId: string): Promise<boolean> {
  const rows = await exec.executeRaw(`SELECT r.id FROM source_ingestion_receipts r JOIN sources s ON s.id=r.source_id AND s.incarnation=r.source_incarnation
      WHERE r.source_id=$1 AND r.profile='company-brain' LIMIT 1`, [sourceId]);
  return rows.length > 0;
}

/**
 * The guest_sources row of `sourceId` (null fields when it has none) and whether row-level security hides
 * guest_sources from the role. A schema behind the guest-notes migration throws the missing-table error.
 */
export async function readGuestSourceRow(exec: RawQuery, sourceId: string): Promise<GuestSourceLookupRow> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(GUEST_SOURCES_HIDDEN_SQL)} AS hidden, g.source_id, g.writers, g.trust_ceiling
    FROM (SELECT 1) AS one LEFT JOIN guest_sources g ON g.source_id = ${sourceId}`);
  const [row] = await exec.executeRaw<GuestSourceLookupRow>(text, params);
  return row ?? { hidden: false, source_id: null, writers: null, trust_ceiling: null };
}

/** Driver-tolerant 42703 detector (the copy sources-load.ts keeps for its single-row read). */
function isUndefinedColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === '42703') return true;
  return typeof e.message === 'string' && /column .* does not exist/i.test(e.message);
}

/** Whether any source is a guest source (guestSourceSql), read as `read_source` like search's read policy. */
export async function hasGuestSource(exec: LegacyUnscopedRead): Promise<boolean> {
  const [row] = await exec.executeRaw<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM sources read_source WHERE ${guestSourceSql('read_source.config', 'read_source.id')}) AS present`);
  return row?.present !== false;
}

/** The database clock as a UTC ISO string with microseconds, independent of the session's DateStyle. */
export async function readDatabaseClock(exec: LegacyUnscopedRead): Promise<string> {
  const [row] = await exec.executeRaw<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
  return row!.at;
}
