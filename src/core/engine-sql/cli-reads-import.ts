/**
 * The reads the CLI import and extract paths ran through `executeRaw` before they had typed members
 * (docs/research/rust-cli-executeraw-map.md, "Source lists and source rows", "Guest-source checks", "Extract reads").
 * Each function keeps the statement text its call site ran, so PGLite and Postgres answer exactly as before; a Rust
 * brain answers from its store (rust/crates/gbrain-store/src/cli_reads/import.rs).
 */
import type {
  GuestSourceLookupRow, LinkPageMetadataRow, PageAtRevisionRef, PageTrustLookup, PageTrustRow, RowTrustLookup, RowTrustRow,
  SourceIncarnationRow, SourceRecordRow, StoredTimelineRow,
} from '../engine.ts';
import { GUEST_SOURCES_HIDDEN_SQL, guestSourceSql } from '../guests/note.ts';
import { activationSuppressedSql, contestedRefSql } from '../eligibility/sql.ts';
import { precedenceSql } from '../eligibility/precedence.ts';
import { isMissingSchemaObject } from '../utils.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** Driver-tolerant 42703 detector (the copy sources-load.ts keeps for its single-row read). */
function isUndefinedColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === '42703') return true;
  return typeof e.message === 'string' && /column .* does not exist/i.test(e.message);
}

/**
 * Every source, `default` first, then by id in byte order (`COLLATE "C"`, on any Postgres locale), with the columns `loadAllSources` reads. A brain whose schema lacks
 * `archived` or `newest_content_at` (pre-v0.26.5, pre-v109) is read again with the historical minimal columns.
 */
export async function listSourceRecords(exec: LegacyUnscopedRead): Promise<SourceRecordRow[]> {
  try {
    return await exec.executeRaw<SourceRecordRow>(
      `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived, newest_content_at
         FROM sources
       ORDER BY (id = 'default') DESC, id COLLATE "C"`,
    );
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    return exec.executeRaw<SourceRecordRow>(
      `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
         FROM sources
       ORDER BY (id = 'default') DESC, id COLLATE "C"`,
    );
  }
}

/** One source's config and incarnation, or null for an unknown id (the company-brain profile read). */
export async function readSourceIncarnation(exec: LegacyUnscopedRead, sourceId: string): Promise<SourceIncarnationRow | null> {
  const [row] = await exec.executeRaw<SourceIncarnationRow>('SELECT config,incarnation FROM sources WHERE id=$1', [sourceId]);
  return row ?? null;
}

/**
 * #9968: the ids among `sourceIds` whose bound worktree still holds a recovery record (a request on the source's
 * worktree with `recovery IS NOT NULL`; several sources can share one worktree). Master's RETAINED_SQL scope.
 */
export async function readRetainedSources(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const rows = await exec.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id=ANY($1::text[]) AND EXISTS (SELECT 1 FROM persistence_source_bindings b
       JOIN persistence_requests r ON r.worktree_id=b.worktree_id WHERE b.source_id=sources.id AND r.recovery IS NOT NULL)
     ORDER BY id COLLATE "C"`, [[...sourceIds]]);
  return rows.map(r => r.id);
}

/** Whether the source's current incarnation has a company-brain ingestion receipt. */
export async function hasCompanyBrainReceipt(exec: LegacyUnscopedRead, sourceId: string): Promise<boolean> {
  const rows = await exec.executeRaw(`SELECT r.id FROM source_ingestion_receipts r JOIN sources s ON s.id=r.source_id AND s.incarnation=r.source_incarnation
      WHERE r.source_id=$1 AND r.profile='company-brain' LIMIT 1`, [sourceId]);
  return rows.length > 0;
}

/**
 * The guest_sources row of `sourceId` (null fields when it has none) and whether row-level security hides
 * guest_sources from the role. A schema behind the guest-notes migration throws the missing-table error.
 */
export async function readGuestSourceRow(exec: LegacyUnscopedRead, sourceId: string): Promise<GuestSourceLookupRow> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(GUEST_SOURCES_HIDDEN_SQL)} AS hidden, g.source_id, g.writers, g.trust_ceiling
    FROM (SELECT 1) AS one LEFT JOIN guest_sources g ON g.source_id = ${sourceId}`);
  const [row] = await exec.executeRaw<GuestSourceLookupRow>(text, params);
  return row ?? { hidden: false, source_id: null, writers: null, trust_ceiling: null };
}

/**
 * Whether guest_sources holds a row for `sourceId` (guests grant-owner-clients: the source must be set up by `guests
 * init`). The row alone, not guestSourceSql: a source whose config says guest but has no row is not a guest source here.
 */
export async function hasGuestSourceRow(exec: LegacyUnscopedRead, sourceId: string): Promise<boolean> {
  return (await exec.executeRaw('SELECT 1 FROM guest_sources WHERE source_id = $1', [sourceId])).length > 0;
}

/** The guest sources among `sourceIds` (guestSourceSql), in no particular order. */
export async function listGuestSourceIds(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const { text, params } = renderFragment(sqlFragment`SELECT s.id FROM sources s WHERE s.id = ANY(${[...new Set(sourceIds)]}::text[])
    AND ${trustedSql(guestSourceSql('s.config', 's.id'))}`);
  const rows = await exec.executeRaw<{ id: string }>(text, params);
  return rows.map(row => row.id);
}

/** Whether any source is a guest source (guestSourceSql), read as `read_source` like search's read policy. */
export async function hasGuestSource(exec: LegacyUnscopedRead): Promise<boolean> {
  const [row] = await exec.executeRaw<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM sources read_source WHERE ${guestSourceSql('read_source.config', 'read_source.id')}) AS present`);
  return row?.present !== false;
}

/** The guest flag of a brain whose schema is behind the guest-notes migration: the config record alone (guests/marker.ts withGuestSourceSql). */
const configGuestSql = (config: string) => `COALESCE(${config}->>'guest' = 'true', false)`;
/** The guest predicate over caller-given constant aliases: the table-backed one, or the config record alone. */
const guestPredicateSql = (tableGuest: boolean, config: string, id: string) => (tableGuest ? guestSourceSql(config, id) : configGuestSql(config));

const trustColumns = (tableGuest: boolean) => {
  const guest = guestPredicateSql(tableGuest, 's.config', 'pages.source_id');
  return sqlFragment`pages.id, pages.source_id, pages.slug, trust_tier, write_origin, ${trustedSql(activationSuppressedSql('pages', 'pages'))} AS flagged,
  ${trustedSql(guestPredicateSql(tableGuest, 's.config', 'pages.source_id'))} AS guest,
  ${trustedSql(precedenceSql({ source: 's', sourceId: 'pages.source_id', guest, page: 'pages' }))} AS precedence
  FROM pages LEFT JOIN sources s ON s.id = pages.source_id`;
};

const ROW_TRUST_TABLES = { facts: 'facts', takes: 'takes', timeline_entries: 'timeline_entries' } as const;

/**
 * The trust rows of fact, take or timeline rows by id: the statement `stampRowTrust` (eligibility/stamp.ts) ran through
 * `executeRaw`. A timeline row has no supersede proposals, so its `contested` is null. C3: a fact's `precedence` is its
 * source's class, or approved when it came from an allowed-claims page (eligibility/precedence.ts); a take or timeline row has
 * none. A brain whose schema is behind the guest-notes migration reads the guest flag from the config alone.
 */
export async function readRowTrustRows(exec: LegacyUnscopedRead, lookup: RowTrustLookup): Promise<RowTrustRow[]> {
  const table = ROW_TRUST_TABLES[lookup.table];
  if (!table) throw new Error(`readRowTrustRows: unknown table ${JSON.stringify(lookup.table)}`);
  if (lookup.ids.length === 0) return [];
  const run = async (tableGuest: boolean): Promise<RowTrustRow[]> => {
    const guest = guestPredicateSql(tableGuest, 'rs.config', 'r.source_id');
    const { text, params } = renderFragment(table === 'facts'
      ? sqlFragment`SELECT r.id, r.trust_tier, r.write_origin, ${trustedSql(activationSuppressedSql(table, 'r'))} AS flagged,
        ${trustedSql(contestedRefSql(table, 'r'))} AS contested,
        ${trustedSql(precedenceSql({ source: 'rs', sourceId: 'r.source_id', guest, page: 'rp' }))} AS precedence
        FROM facts r LEFT JOIN sources rs ON rs.id = r.source_id
        LEFT JOIN pages rp ON rp.source_id = r.source_id AND rp.slug = r.source_markdown_slug AND rp.deleted_at IS NULL
        WHERE r.id = ANY(${[...lookup.ids]}::bigint[])`
      : sqlFragment`SELECT r.id, r.trust_tier, r.write_origin, ${trustedSql(activationSuppressedSql(table, 'r'))} AS flagged,
        ${trustedSql(table === 'timeline_entries' ? 'NULL' : contestedRefSql(table, 'r'))} AS contested FROM ${trustedSql(table)} r WHERE r.id = ANY(${[...lookup.ids]}::bigint[])`);
    return (await exec.executeRaw<Omit<RowTrustRow, 'precedence'> & { precedence?: string | null }>(text, params))
      .map(row => ({ ...row, id: Number(row.id), precedence: row.precedence ?? null }));
  };
  if (table !== 'facts') return run(true);
  try { return await run(true); } catch (e) {
    if (!isMissingSchemaObject(e, 'table', 'guest_sources')) throw e;
    return run(false);
  }
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

/** The database clock as a UTC ISO string with microseconds, independent of the session's DateStyle. */
export async function readDatabaseClock(exec: LegacyUnscopedRead): Promise<string> {
  const [row] = await exec.executeRaw<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
  return row!.at;
}

/** Every live page (of one source when given) with its aliases and knowledge revision, by source then slug. */
export async function listLinkPageMetadata(exec: LegacyUnscopedRead, sourceId?: string): Promise<LinkPageMetadataRow[]> {
  return exec.executeRaw<LinkPageMetadataRow>(`SELECT slug, source_id, type, title, frontmatter->'aliases' AS aliases, knowledge_revision FROM pages
    WHERE deleted_at IS NULL${sourceId ? ' AND source_id=$1' : ''} ORDER BY source_id COLLATE "C", slug COLLATE "C"`, sourceId ? [sourceId] : []);
}

/** The live pages of one source whose slug is in `slugs`, by slug (a sync's link extraction). */
export async function listLinkPageMetadataForSlugs(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[]): Promise<LinkPageMetadataRow[]> {
  return exec.executeRaw<LinkPageMetadataRow>(`SELECT slug, source_id, type, title, frontmatter->'aliases' AS aliases, knowledge_revision
        FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[]) ORDER BY slug COLLATE "C"`, [sourceId, [...slugs]]);
}

/**
 * The slugs of one source's pages (only those in `slugs` when given) that authored a body or frontmatter `attended`
 * link to themselves, in no set order: the attendance origins link extraction reconciles.
 */
export async function listAttendedOriginSlugs(exec: LegacyUnscopedRead, sourceId: string, slugs?: readonly string[]): Promise<string[]> {
  const scoped = slugs ? sqlFragment` AND o.slug = ANY(${[...slugs]}::text[])` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT o.slug FROM links l
    JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=${sourceId} AND l.link_source IN ('markdown','wikilink-resolved','frontmatter')
      AND l.link_type='attended' AND l.to_page_id=l.origin_page_id${scoped}`);
  return (await exec.executeRaw<{ slug: string }>(text, params)).map(row => row.slug);
}

/** Every stored non-event timeline row of one page, the date as `YYYY-MM-DD`, in no particular order. */
export async function listStoredTimelineRows(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<StoredTimelineRow[]> {
  return exec.executeRaw<StoredTimelineRow>(
    `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary, t.detail FROM timeline_entries t
      JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND t.event_page_id IS NULL`, [sourceId, slug]);
}

/** The live pages among `refs` that are still at the knowledge revision each names, in no particular order. */
export async function filterPagesAtRevision(exec: LegacyUnscopedRead, refs: readonly PageAtRevisionRef[]): Promise<Array<{ slug: string; source_id: string }>> {
  if (refs.length === 0) return [];
  return exec.executeRaw<{ slug: string; source_id: string }>(`SELECT p.slug,p.source_id FROM pages p
      JOIN unnest($1::text[],$2::text[],$3::text[]) AS t(source_id,slug,revision) ON p.source_id=t.source_id AND p.slug=t.slug
      WHERE p.knowledge_revision::text=t.revision AND p.deleted_at IS NULL`, [refs.map(r => r.source_id), refs.map(r => r.slug), refs.map(r => r.revision)]);
}
