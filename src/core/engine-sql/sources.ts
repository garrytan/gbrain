/**
 * Sources: one SQL implementation for both engines (refactor wave 1,
 * W1-extended). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/sources.json`); PGLite runs the same statements
 * (docs/designs/refactor-wave-1/w1-inventory.md). `listAllSources` was
 * unscoped on master (EO4 inventory), so it takes `LegacyUnscopedRead`.
 */
import type { SourceDetailRow, SourceRow } from '../engine.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { jsonbParam, type SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { ANY_OWNER_ONLY_SQL, OWNER_ONLY_LINEAGE_PRESENT_SQL } from '../access/owner-only.ts';
import { quarantineFilterFragment } from '../quarantine.ts';

export async function listAllSources(exec: LegacyUnscopedRead, opts?: {
  includeArchived?: boolean;
  localPathOnly?: boolean;
}): Promise<SourceRow[]> {
    // v0.38: lean per-source enumeration for autopilot dispatch + doctor.
    // Filters at SQL so the autopilot tick stays one query regardless of
    // how many archived rows exist. ORDER BY (id='default') DESC, id
    // matches sources-ops.listSources for operator-output stability.
    // localPathOnly skips pure-DB sources so autopilot fan-out doesn't
    // dispatch jobs that would fall back to the global sync.repo_path, and
    // the storage shelf, whose cycle is always skipped (GST-1943).
    const includeArchived = opts?.includeArchived === true;
    const localPathOnly = opts?.localPathOnly === true;
    const { rows } = await exec.run(sqlFragment`
      SELECT id, name, local_path, last_sync_at, config
        FROM sources
       WHERE (${includeArchived} OR archived IS NOT TRUE)
         AND (${!localPathOnly} OR (local_path IS NOT NULL AND config->>'role' IS DISTINCT FROM 'storage_manifest'))
       ORDER BY (id = 'default') DESC, id
    `);
    return rows.map((r) => ({
      id: r.id as string,
      name: (r.name as string | null) ?? null,
      local_path: (r.local_path as string | null) ?? null,
      last_sync_at: r.last_sync_at ? new Date(r.last_sync_at as string) : null,
      config: typeof r.config === 'string' ? JSON.parse(r.config) : ((r.config as Record<string, unknown> | null) ?? {}),
    }));
  }

export async function updateSourceConfig(exec: SqlExecutor, sourceId: string, patch: Record<string, unknown>): Promise<boolean> {
    // Atomic single-statement merge. The previous read-then-write form dropped
    // concurrent updates: two callers patching different keys could both read
    // the same old config and the later `SET config = ...` clobbered the
    // earlier patch. These keys are written by background cycle/autopilot
    // paths, so the merge must happen inside the UPDATE.
    //
    // The shared SQL coercion normalizes historical bad shapes inline (so
    // `config` is re-read against the row-locked latest version — a detached
    // read/normalize/write cycle would reintroduce the lost-update race under
    // READ COMMITTED): older code paths
    // could store config as a JSONB string (double-encoded) or as a JSONB array
    // of patch objects. We coerce those to a flat object before the `||` merge
    // so doctor and source routing keep getting flat keys.
    //
    // String branch guard: a JSONB string whose inner text is NOT itself valid
    // JSON (one of the historical bad shapes this path repairs) would make the
    // bare `::jsonb` cast raise `invalid input syntax for type json`, failing
    // the whole UPDATE. Postgres has no `try_cast`, so the cast goes through
    // gbrain_try_jsonb (NULL on unparseable text; Postgres 15+, unlike IS JSON,
    // #7112): parseable inner text is double-encoded config and gets parsed;
    // unparseable text falls back to `{}`.
    // The guard keeps the merge a single atomic statement (no extra round-trip,
    // no lost-update race).
    //
    // MUST bind the patch through jsonbParam (postgres.js `sql.json` on
    // Postgres) — a JSON.stringify'd string bound to `$1::jsonb` through
    // postgres-js's positional path DOUBLE-ENCODES into a JSONB STRING
    // shape instead of OBJECT. `||` between JSONB object + JSONB string
    // yields a JSONB ARRAY (concat semantics for non-matching types),
    // which wipes every existing config key.
    const { affectedRows } = await exec.run(sqlFragment`
      UPDATE sources
         SET config = ${trustedSql(SOURCE_CONFIG_OBJECT_SQL)}
           || ${jsonbParam(patch)}
       WHERE id = ${sourceId}
    `);
    return affectedRows > 0;
  }

/** One source row with the columns a source check reads: its checkout path, raw config and archived flag. */
export interface SourceCheckRow { id: string; local_path: string | null; config: unknown; archived: boolean }

/** The source row, or null (`SELECT id, local_path, config, archived FROM sources WHERE id=$1`). Unscoped on master. */
export async function readSourceRow(exec: LegacyUnscopedRead, sourceId: string): Promise<SourceCheckRow | null> {
  const [row] = await exec.executeRaw<SourceCheckRow>('SELECT id, local_path, config, archived FROM sources WHERE id=$1', [sourceId]);
  return row ?? null;
}

/** The source row read `FOR UPDATE`, so it cannot change before the caller's transaction ends; null when absent. */
export async function lockSourceRow(exec: SqlExecutor, sourceId: string): Promise<SourceCheckRow | null> {
  const [row] = await exec.executeRaw<SourceCheckRow>('SELECT id, local_path, config, archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
  return row ?? null;
}

/**
 * Whether a writer binding claims the source's current incarnation (classic sync refuses a claimed source while managed
 * persistence is off). False for an unknown source. The text is the statement sync-authority.ts ran through executeRaw.
 */
export const SOURCE_CLAIMED_SQL = `SELECT
    EXISTS(SELECT 1 FROM persistence_source_bindings WHERE source_id=s.id AND source_incarnation=s.incarnation) AS claimed
    FROM sources s WHERE s.id=$1`;

/** True when a writer binding claims the source's current incarnation; false when none does or the source is unknown. Unscoped on master. */
export async function isSourceClaimed(exec: LegacyUnscopedRead, sourceId: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ claimed: boolean }>(SOURCE_CLAIMED_SQL, [sourceId]);
  return row?.claimed === true;
}

/** The chunker version the source's last full sync stamped, or null. Unscoped on master. */
export async function readSourceChunkerVersion(exec: LegacyUnscopedRead, sourceId: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ chunker_version: string | null }>('SELECT chunker_version FROM sources WHERE id = $1', [sourceId]);
  return row?.chunker_version ?? null;
}

/** Stamps the chunker version a full sync of the source used; an unknown source changes nothing. */
export async function setSourceChunkerVersion(exec: SqlExecutor, sourceId: string, version: string): Promise<void> {
  await exec.executeRaw('UPDATE sources SET chunker_version = $1 WHERE id = $2', [version, sourceId]);
}

/**
 * Ids of live sources whose last sync is more than seven days old by the database clock (`now()`), by id: the
 * advisor's stale-sync read. Unscoped on master. Throws on a schema without `last_sync_at` or `archived`.
 */
export async function listStaleSyncSourceIds(exec: LegacyUnscopedRead): Promise<string[]> {
  const rows = await exec.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE last_sync_at IS NOT NULL AND last_sync_at < now() - interval '7 days' AND NOT archived ORDER BY id`,
  );
  return rows.map(r => r.id);
}

/** One source with the columns import and contextual retrieval read, or null for an unknown id. Rows come back as the driver returns them. */
export async function getSource(exec: LegacyUnscopedRead, sourceId: string): Promise<SourceDetailRow | null> {
  const rows = await exec.executeRaw<SourceDetailRow>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at,
            contextual_retrieval_mode, trust_frontmatter_overrides
     FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0] ?? null;
}

/**
 * Local paths of every source that has one, unscoped on master (`withSourceFilesystemLock` read it through
 * `executeRaw`). Empty strings are dropped as well as NULLs.
 */
export async function listSourceLocalPaths(exec: LegacyUnscopedRead): Promise<string[]> {
  const { rows } = await exec.query<{ local_path: string }>(`SELECT local_path FROM sources WHERE local_path IS NOT NULL AND local_path <> ''`);
  return rows.map(r => r.local_path);
}

/** One live source's roots on a host: a managed import refuses a path inside another source's (import-prepare.ts). */
export interface SourceImportRoot { id: string; local_path: string | null; worktree_path: string | null; relative_path: string | null }
/** The statement `assertImportPaths` ran through `executeRaw`, byte for byte (batchSharedReads keys its memo on it). */
export const SOURCE_IMPORT_ROOTS_SQL = `SELECT s.id,s.local_path,h.local_path AS worktree_path,b.relative_path FROM sources s
      LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid WHERE NOT s.archived`;

/**
 * Every live source with its own local path and, when its binding is at its current incarnation, the binding's
 * relative path and host `hostId`'s worktree path (null when absent). Unscoped: the import checks every source. No order.
 */
export async function listSourceImportRoots(exec: LegacyUnscopedRead, hostId: string): Promise<SourceImportRoot[]> {
  return exec.executeRaw<SourceImportRoot>(SOURCE_IMPORT_ROOTS_SQL, [hostId]);
}

/**
 * How many live (not archived) sources are bound to a local repository, unscoped (the readiness sync probe read it
 * through `executeRaw`). An empty path counts as unbound, as NULL does.
 */
export async function countRepoBoundSources(exec: LegacyUnscopedRead): Promise<number> {
  const rows = await exec.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM sources WHERE NOT archived AND local_path IS NOT NULL AND local_path <> ''`);
  return Number(rows[0]?.n ?? 0);
}

/** A source with a local path and its archived flag (`listLocalPathSources`). */
export interface LocalPathSourceRow { id: string; local_path: string; archived: boolean }

/** One source row for request-scoped source resolution, with the brain-wide `default` emptiness flag (`listSourceRoutingRows`). */
export interface SourceRoutingRow { id: string; local_path: string | null; archived: boolean; config: unknown; default_has_pages: boolean }

/** Live page counts of `default` against every other source (`countDefaultSourceSplit`). */
export interface DefaultSourceSplit { defaultPages: number; nonDefaultPages: number; nonDefaultSources: number }

/**
 * Sources that have a local path, with `archived`, in no particular order. Unscoped on master (source resolution
 * tier 4 read it through `executeRaw`). Throws on a brain older than the `archived` column; the caller falls back.
 */
export async function listLocalPathSources(exec: LegacyUnscopedRead): Promise<LocalPathSourceRow[]> {
  return exec.executeRaw<LocalPathSourceRow>(`SELECT id, local_path, archived FROM sources WHERE local_path IS NOT NULL`);
}

/** The engine's own executeRaw (or a persistence view's), so access/owner-only.ts runs the same statement on either. */
export interface OwnerOnlyRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/**
 * Does the brain hold an owner-only source, archived ones included, or (with `lineage` on, the v320 lineage function
 * the schema carries, see access/owner-only.ts `ownerOnlyLineageReadable`) a row derived from a removed one? No row counts as yes (fail closed).
 */
export async function readOwnerOnlySourcesPresent(exec: OwnerOnlyRead, lineage: boolean = false): Promise<boolean> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(lineage ? OWNER_ONLY_LINEAGE_PRESENT_SQL : ANY_OWNER_ONLY_SQL)} AS present`);
  const [row] = await exec.executeRaw<{ present: boolean }>(text, params);
  return row?.present !== false;
}

/** One source's raw `config` for the owner-only test, or null when the source is missing (`sourceIsOwnerOnly`). */
export async function readOwnerOnlySourceConfig(exec: OwnerOnlyRead, sourceId: string): Promise<{ config: unknown } | null> {
  const rows = await exec.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [sourceId]);
  return rows[0] ?? null;
}

/** The live (not archived) source a plain-directory sync reads (`plainDirectorySyncRoot`). */
export interface PlainSyncSourceRow { local_path: string | null; last_commit: string | null; config: { kind?: unknown } | null }

/** The registered path, last commit and config of a source that is not archived, or null. */
export async function readPlainSyncSource(exec: LegacyUnscopedRead, sourceId: string): Promise<PlainSyncSourceRow | null> {
  const [row] = await exec.executeRaw<PlainSyncSourceRow>('SELECT local_path,last_commit,config FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  return row ?? null;
}

/**
 * Every source row ordered by id, each carrying whether `default` holds a live page, in one statement (the request
 * config snapshot's `sources` read, #7147). Unscoped on master.
 */
export async function listSourceRoutingRows(exec: LegacyUnscopedRead): Promise<SourceRoutingRow[]> {
  return exec.executeRaw<SourceRoutingRow>(
    `SELECT id, local_path, archived, config, EXISTS (SELECT 1 FROM pages WHERE source_id = 'default' AND deleted_at IS NULL) AS default_has_pages FROM sources ORDER BY id`,
  );
}

/**
 * Live pages in `default`, live pages elsewhere, and the number of non-default sources holding a live page (the
 * default-write guard). Soft-deleted pages are left out. Unscoped on master.
 */
export async function countDefaultSourceSplit(exec: LegacyUnscopedRead): Promise<DefaultSourceSplit> {
  const rows = await exec.executeRaw<{
    default_pages: number | string | bigint | null;
    non_default_pages: number | string | bigint | null;
    non_default_sources: number | string | bigint | null;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN source_id = 'default' THEN 1 ELSE 0 END), 0) AS default_pages,
       COALESCE(SUM(CASE WHEN source_id <> 'default' THEN 1 ELSE 0 END), 0) AS non_default_pages,
       COUNT(DISTINCT source_id) FILTER (WHERE source_id <> 'default') AS non_default_sources
     FROM pages
     WHERE deleted_at IS NULL`,
  );
  const r = rows[0];
  return {
    defaultPages: Number(r?.default_pages) || 0,
    nonDefaultPages: Number(r?.non_default_pages) || 0,
    nonDefaultSources: Number(r?.non_default_sources) || 0,
  };
}

/** Pages of one source (`SELECT COUNT(*)::int AS n FROM pages WHERE source_id=$1`); soft-deleted pages count only with `includeDeleted`. Unscoped on master. */
export async function countSourcePages(exec: LegacyUnscopedRead, sourceId: string, opts?: { includeDeleted?: boolean }): Promise<number> {
  const sql = opts?.includeDeleted === true
    ? 'SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1'
    : 'SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL';
  const [row] = await exec.executeRaw<{ n: number }>(sql, [sourceId]);
  return Number(row?.n ?? 0);
}

/**
 * Records that the source's git sync reached `commit` and stamps `last_sync_at` with the database clock, in one UPDATE.
 * `newestContentAt` (the HEAD committer time, ISO) is written in the same UPDATE when given; `null` clears it and
 * `undefined` leaves it alone. An unknown source changes nothing (sync-anchor.ts `writeSyncAnchor`).
 */
export async function advanceSourceCommit(exec: SqlExecutor, sourceId: string, commit: string, newestContentAt?: string | null): Promise<void> {
  if (newestContentAt !== undefined) {
    await exec.executeRaw(
      `UPDATE sources SET last_commit = $1, last_sync_at = now(), newest_content_at = $3 WHERE id = $2`,
      [commit, sourceId, newestContentAt],
    );
    return;
  }
  await exec.executeRaw(
    `UPDATE sources SET last_commit = $1, last_sync_at = now() WHERE id = $2`,
    [commit, sourceId],
  );
}

/** A stored page a sync size-state read reports (`readPageSizeRows`); `state`/`reason` are its page_embedding_budget row. */
export interface PageSizeRow { slug: string; bytes: number | string | null; segmented: boolean; frontmatter: Record<string, unknown> | null; state: 'held' | 'capped' | null; reason: string | null }

const PAGE_SIZE_ROWS_SQL = `SELECT p.slug, (CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)::bigint AS bytes, p.body_storage = 'segmented' AS segmented, p.frontmatter, b.state, b.reason
       FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL
        AND (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' OR (CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END) > $2 OR p.body_storage = 'segmented' OR b.page_id IS NOT NULL) ORDER BY p.slug`;
const PAGE_SIZE_ROWS_FOR_SLUGS_SQL = `SELECT p.slug, (CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)::bigint AS bytes, p.body_storage = 'segmented' AS segmented, p.frontmatter, b.state, b.reason
       FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug = ANY($3::text[])
        AND (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' OR (CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END) > $2 OR p.body_storage = 'segmented' OR b.page_id IS NOT NULL) ORDER BY p.slug`;

/**
 * The live pages of one source (only `slugs` when given) that carry embed_skip, have a body over `maxBytes`, are
 * segmented or have a page_embedding_budget row, by slug: the rows page-embedding-budget.ts readPageSizeStates maps.
 */
export async function readPageSizeRows(exec: LegacyUnscopedRead, sourceId: string, maxBytes: number, slugs: readonly string[] | null): Promise<PageSizeRow[]> {
  return slugs
    ? exec.executeRaw<PageSizeRow>(PAGE_SIZE_ROWS_FOR_SLUGS_SQL, [sourceId, maxBytes, [...slugs]])
    : exec.executeRaw<PageSizeRow>(PAGE_SIZE_ROWS_SQL, [sourceId, maxBytes]);
}

/** A text-free purged change-reason pair (`reason_purge_tombstones`): the commit and repository path a purge found it under. */
export interface ReasonPurgeTombstone { commit_sha: string; path: string }

/**
 * The source's tombstoned (commit, path) pairs, by commit then path; with `pair`, that pair when it is stored, else
 * none: the reads a sync's reason scan, the purged-reason repair and a version snapshot check (reason-trailers.ts,
 * repair/purged-change-reasons.ts, page-state/versions.ts).
 */
export async function readReasonPurgeTombstones(exec: LegacyUnscopedRead, sourceId: string, pair?: ReasonPurgeTombstone): Promise<ReasonPurgeTombstone[]> {
  return pair
    ? exec.executeRaw<ReasonPurgeTombstone>('SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1 AND commit_sha = $2 AND path = $3', [sourceId, pair.commit_sha, pair.path])
    : exec.executeRaw<ReasonPurgeTombstone>('SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1 ORDER BY commit_sha, path', [sourceId]);
}

/**
 * Stores each pair not stored yet and returns how many it added (facts/purge-reasons.ts `recordReasonTombstones`). No
 * pairs add nothing; an unknown source throws (the `sources` foreign key) and stores nothing.
 */
export async function writeReasonPurgeTombstones(exec: SqlExecutor, sourceId: string, pairs: readonly ReasonPurgeTombstone[]): Promise<number> {
  if (!pairs.length) return 0;
  return (await exec.executeRaw(`INSERT INTO reason_purge_tombstones(source_id, commit_sha, path)
    SELECT $1, t.c, t.p FROM unnest($2::text[], $3::text[]) AS t(c, p) ON CONFLICT DO NOTHING RETURNING 1`,
  [sourceId, pairs.map(pair => pair.commit_sha), pairs.map(pair => pair.path)])).length;
}

/** Sets the page's embedding hold to `held` with `reason`, adding its page_embedding_budget row when it has none (page-embedding-budget.ts). */
export async function holdPageEmbedding(exec: SqlExecutor, pageId: number, reason: string): Promise<void> {
  await exec.executeRaw(`INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'held', $2)
    ON CONFLICT (page_id) DO UPDATE SET state = 'held', reason = EXCLUDED.reason, updated_at = now()`, [pageId, reason]);
}

/** A live page with a file origin (`listSourcePathPages`). */
export interface SourcePathPageRow { slug: string; source_path: string }

/** The live pages of one source that have a `source_path`, in no set order: the pages a full sync reconciles (sync/full.ts). */
export async function listSourcePathPages(exec: LegacyUnscopedRead, sourceId: string): Promise<SourcePathPageRow[]> {
  return exec.executeRaw<SourcePathPageRow>(
    `SELECT slug, source_path FROM pages WHERE source_id = $1 AND source_path IS NOT NULL AND deleted_at IS NULL`,
    [sourceId],
  );
}

/** The slugs of one source's live quarantined pages, in no set order: the pages link and timeline extraction skips (quarantine.ts `quarantinedSlugs`). */
export async function listQuarantinedSlugs(exec: LegacyUnscopedRead, sourceId: string): Promise<string[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT slug FROM pages WHERE source_id = ${sourceId} AND deleted_at IS NULL AND NOT ${trustedSql(quarantineFilterFragment('pages'))}`);
  const rows = await exec.executeRaw<{ slug: string }>(text, params);
  return rows.map(row => row.slug);
}

/** A live page a rename's identity check compares (`readRenameIdentityRows`). */
export interface RenameIdentityRow { slug: string; source_path: string | null; title: string | null }

/**
 * The live pages of one source whose source_path is in `paths` or whose slug is in `slugs`, in no set order
 * (sync-rename-identity.ts). A value the database cannot encode throws the driver's error (22021/22P05), which the
 * caller retries path by path.
 */
export async function readRenameIdentityRows(exec: LegacyUnscopedRead, sourceId: string, paths: readonly string[], slugs: readonly string[]): Promise<RenameIdentityRow[]> {
  return exec.executeRaw<RenameIdentityRow>(
    `SELECT slug, source_path, title FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND (source_path = ANY($2::text[]) OR slug = ANY($3::text[]))`,
    [sourceId, [...paths], [...slugs]],
  );
}

/** A live page that holds a frontmatter id or a title (`readLiveIdentityHolders`). */
export interface LiveIdentityHolderRow { slug: string; source_path: string | null; fm_id: string | null; title: string | null }

/**
 * The live pages of one source whose frontmatter id is in `ids` or whose title is in `titles`, in no set order
 * (sync-rename-identity.ts). A value the database cannot encode throws the driver's error, which the caller handles.
 */
export async function readLiveIdentityHolders(exec: LegacyUnscopedRead, sourceId: string, ids: readonly string[], titles: readonly string[]): Promise<LiveIdentityHolderRow[]> {
  return exec.executeRaw<LiveIdentityHolderRow>(
    `SELECT slug, source_path, frontmatter->>'id' AS fm_id, title FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND (frontmatter->>'id' = ANY($2::text[]) OR title = ANY($3::text[]))`,
    [sourceId, [...ids], [...titles]],
  );
}

/** The columns `insertSource` writes; the table fills the rest with its defaults. */
export interface SourceInsert { id: string; name: string; local_path: string | null; config: Record<string, unknown> }

/**
 * Inserts one source row. A taken id or name throws the table's unique-key error and writes nothing. The config binds
 * through jsonbParam, never a JSON.stringify'd string into `::jsonb` (postgres.js would double-encode it).
 */
export async function insertSource(exec: SqlExecutor, row: SourceInsert): Promise<void> {
  await exec.run(sqlFragment`
    INSERT INTO sources (id, name, local_path, config)
         VALUES (${row.id}, ${row.name}, ${row.local_path}, ${jsonbParam(row.config)})
  `);
}
