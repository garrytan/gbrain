/**
 * Sources: one SQL implementation for both engines (refactor wave 1,
 * W1-extended). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/sources.json`); PGLite runs the same statements
 * (docs/designs/refactor-wave-1/w1-inventory.md). `listAllSources` was
 * unscoped on master (EO4 inventory), so it takes `LegacyUnscopedRead`.
 */
import type { SourceDetailRow, SourceRow } from '../engine.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { jsonbParam, type RawQuery, type SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { ANY_OWNER_ONLY_SQL, OWNER_ONLY_LINEAGE_PRESENT_SQL } from '../access/owner-only.ts';
import { remoteReadFloorSql } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';

export async function listAllSources(exec: LegacyUnscopedRead, opts?: {
  includeArchived?: boolean;
  localPathOnly?: boolean;
}): Promise<SourceRow[]> {
    // v0.38: lean per-source enumeration for autopilot dispatch + doctor.
    // Filters at SQL so the autopilot tick stays one query regardless of
    // how many archived rows exist. ORDER BY (id='default') DESC, id
    // matches sources-ops.listSources for operator-output stability. COLLATE "C" on the id tie-break keeps a Postgres
    // server with a linguistic locale (en_US.utf8) in the byte order PGLite and the Rust engine give.
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
       ORDER BY (id = 'default') DESC, id COLLATE "C"
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

/** Sets the source's display `name` (`sources rename`). Returns whether the source exists; an unknown id changes nothing. */
export async function renameSource(exec: SqlExecutor, sourceId: string, name: string): Promise<boolean> {
  const { affectedRows } = await exec.run(sqlFragment`UPDATE sources SET name = ${name} WHERE id = ${sourceId}`);
  return affectedRows > 0;
}

/** One active source with its raw config (`listActiveSourceConfigs`). */
export interface ActiveSourceConfigRow { id: string; config: unknown; archived: boolean }

/**
 * The active sources with their raw config, by id: the read that scopes a legacy remote caller to the sources it may see
 * (`SELECT id, config, archived FROM sources WHERE archived = false ORDER BY id`, as master issued it). Unscoped on master.
 */
export async function listActiveSourceConfigs(exec: RawQuery): Promise<ActiveSourceConfigRow[]> {
  return exec.executeRaw<ActiveSourceConfigRow>(`SELECT id, config, archived FROM sources WHERE archived = false ORDER BY id`);
}

/** One source row with the columns a source check reads: its checkout path, raw config and archived flag. */
export interface SourceCheckRow { id: string; local_path: string | null; config: unknown; archived: boolean }

/** The source row, or null (`SELECT id, local_path, config, archived FROM sources WHERE id=$1`). Unscoped on master. */
export async function readSourceRow(exec: RawQuery, sourceId: string): Promise<SourceCheckRow | null> {
  const [row] = await exec.executeRaw<SourceCheckRow>('SELECT id, local_path, config, archived FROM sources WHERE id=$1', [sourceId]);
  return row ?? null;
}

/** The source row read `FOR UPDATE`, so it cannot change before the caller's transaction ends; null when absent. */
export async function lockSourceRow(exec: SqlExecutor, sourceId: string): Promise<SourceCheckRow | null> {
  const [row] = await exec.executeRaw<SourceCheckRow>('SELECT id, local_path, config, archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
  return row ?? null;
}

/**
 * Takes the source row's lock (`SELECT id FROM sources WHERE id=$1 FOR UPDATE`) for the rest of the caller's transaction,
 * reading nothing back; an unknown source is a no-op. The publication transaction of a `sourceExclusive` mutation takes it
 * before any other publication statement (persistence/coordinator.ts).
 */
export async function lockSourceForUpdate(exec: SqlExecutor, sourceId: string): Promise<void> {
  await exec.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
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

/** The 0-change sync heartbeat statement (src/core/sync-upstream.ts), verbatim. */
export const SOURCE_SYNC_HEARTBEAT_SQL = 'UPDATE sources SET last_sync_at = now() WHERE id = $1';

/**
 * The 0-change sync heartbeat: stamps `last_sync_at` with the database clock and leaves `last_commit` alone, so doctor's
 * sync freshness sees a quiet source as synced. An unknown source changes nothing.
 */
export async function writeSourceSyncHeartbeat(exec: SqlExecutor, sourceId: string): Promise<void> {
  await exec.executeRaw(SOURCE_SYNC_HEARTBEAT_SQL, [sourceId]);
}

/** What sync observed of the checkout's Git upstream (`observeUpstream` in sync-upstream.ts). */
export interface SourceUpstreamObservation { checkedAt: string; commit: string; behind: number | null }
/** The statement `recordUpstreamObservation` (src/core/sync-upstream.ts) sends, verbatim. */
export const SOURCE_UPSTREAM_OBSERVATION_SQL = `UPDATE sources SET upstream_checked_at = CASE WHEN upstream_commit = $3 AND upstream_checked_at > $2::timestamptz THEN upstream_checked_at ELSE $2::timestamptz END,
  upstream_commit=$3,upstream_behind=$4 WHERE id=$1`;

/**
 * The sync's upstream observation: sets `upstream_checked_at` (an ISO time), `upstream_commit` and `upstream_behind`
 * (null when the synced commit is unknown). A check time never moves back for the same upstream commit (#9933): a failed
 * fetch empties FETCH_HEAD and the reflog can be older than the no-change fetch already recorded. An unknown source
 * changes nothing.
 */
export async function writeSourceUpstreamObservation(exec: SqlExecutor, sourceId: string, observed: SourceUpstreamObservation): Promise<void> {
  await exec.executeRaw(SOURCE_UPSTREAM_OBSERVATION_SQL, [sourceId, observed.checkedAt, observed.commit, observed.behind]);
}

/** The commit the source's last sync advanced to (`last_commit`), or null before the first sync and for an unknown source. */
export async function readSourceLastCommit(exec: LegacyUnscopedRead, sourceId: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]);
  return row?.last_commit ?? null;
}

/**
 * Advances the source's sync anchor: stamps last_commit and last_sync_at (the database clock), and newest_content_at
 * too when `newestContentAt` is given (null clears it; undefined keeps it). An unknown source changes nothing.
 */
export async function advanceSourceCommit(exec: SqlExecutor, sourceId: string, commit: string, newestContentAt?: string | null): Promise<void> {
  if (newestContentAt !== undefined) {
    await exec.executeRaw(
      `UPDATE sources SET last_commit = $1, last_sync_at = now(), newest_content_at = $3 WHERE id = $2`,
      [commit, sourceId, newestContentAt],
    );
  } else {
    await exec.executeRaw(
      `UPDATE sources SET last_commit = $1, last_sync_at = now() WHERE id = $2`,
      [commit, sourceId],
    );
  }
}

/**
 * Every source id, archived sources included, in byte order of the id: the read scope of a caller with no source
 * (ops/backlinks-paged.ts). `COLLATE "C"` keeps a Postgres server with a linguistic locale (en_US.utf8) in the order
 * PGLite and the Rust engine give. Unscoped on master.
 */
export async function listSourceIds(exec: LegacyUnscopedRead): Promise<string[]> {
  const rows = await exec.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id COLLATE "C"');
  return rows.map(r => r.id);
}

/** The only source's id, or null when the brain has none or more than one (corpus-source.ts, sweep, doctor memory_writeback). Unscoped on master. */
export async function readSoleSourceId(exec: LegacyUnscopedRead): Promise<string | null> {
  // The order never reaches output: an id is returned only when exactly one row exists, so no order changes the result.
  const rows = await exec.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id LIMIT 2');
  return rows.length === 1 ? rows[0]!.id : null;
}

/** `default` when it exists, else the lowest id in byte order, else null (doctor origin_twins). Unscoped on master. */
export async function readFirstSourceId(exec: LegacyUnscopedRead): Promise<string | null> {
  const [row] = await exec.executeRaw<{ id: string }>(`SELECT id FROM sources ORDER BY (id = 'default') DESC, id COLLATE "C" LIMIT 1`);
  return row?.id ?? null;
}

/**
 * Locks every source row (`FOR UPDATE`, or `FOR SHARE`) until the caller's transaction ends (persistence deactivation,
 * pre-activation release, skill activation).
 */
export async function lockAllSourceRows(exec: SqlExecutor, mode: 'update' | 'share'): Promise<void> {
  // Plain ORDER BY id on purpose, not COLLATE "C": the same lock order as topology-locks.ts and core-guard.ts, so no deadlock.
  await exec.executeRaw(mode === 'update' ? 'SELECT id FROM sources ORDER BY id FOR UPDATE' : 'SELECT id FROM sources ORDER BY id FOR SHARE');
}

/**
 * `markSourceSynced` options. `incarnation` stamps only while the source is still that incarnation (a managed sync
 * run's guard). `newestContentAt` (a timestamptz text) also sets `newest_content_at`; null keeps the stored value
 * (`COALESCE`), as a connector run that saw nothing newer does.
 */
export interface SourceSyncStampOptions { incarnation?: string; newestContentAt?: string | null }

/**
 * Sets the source's last sync time to the database clock (`now()`): the stamp a clean `gbrain import` of a folder
 * source makes (#1691), a no-change sync's heartbeat and a connector's clean run. With `incarnation`, only a source
 * still of that incarnation is stamped. Returns whether a source was stamped; an unknown source (or another
 * incarnation) changes nothing.
 */
export async function markSourceSynced(exec: SqlExecutor, sourceId: string, opts: SourceSyncStampOptions = {}): Promise<boolean> {
  const newest = opts.newestContentAt;
  let rows: Array<{ id: string }>;
  if (newest === undefined) {
    rows = opts.incarnation === undefined
      ? await exec.executeRaw<{ id: string }>('UPDATE sources SET last_sync_at = now() WHERE id = $1 RETURNING id', [sourceId])
      : await exec.executeRaw<{ id: string }>('UPDATE sources SET last_sync_at = now() WHERE id = $1 AND incarnation = $2::uuid RETURNING id', [sourceId, opts.incarnation]);
  } else {
    rows = opts.incarnation === undefined
      ? await exec.executeRaw<{ id: string }>('UPDATE sources SET last_sync_at = now(), newest_content_at = COALESCE($2::timestamptz, newest_content_at) WHERE id = $1 RETURNING id', [sourceId, newest])
      : await exec.executeRaw<{ id: string }>('UPDATE sources SET last_sync_at = now(), newest_content_at = COALESCE($3::timestamptz, newest_content_at) WHERE id = $1 AND incarnation = $2::uuid RETURNING id', [sourceId, opts.incarnation, newest]);
  }
  return rows.length > 0;
}

/** `advanceSyncCheckpoint` input: the managed sync checkpoint of src/core/persistence/sync-prepare.ts. */
export interface SyncCheckpointAdvance {
  sourceId: string;
  /** The source incarnation the run started under; another incarnation changes nothing. */
  incarnation: string;
  /** The commit the checkpoint moves to (`last_commit`); null re-stamps a checkpoint still at a null `from` (a first sync's unfinished slice). */
  commit: string | null;
  /** The `last_commit` the run started from (null before the first sync). */
  from: string | null;
  /** Also accept a checkpoint already at `commit` (an overtaken run, and every pass stamp). */
  acceptAtCommit: boolean;
  /** The slug mode the run used; written to `config.slug_root_mode`. */
  slugMode: string;
  /** An empty scope: both modes give the same slugs, so a pinned mode stays and never refuses. */
  keepPinnedSlugMode: boolean;
}

/**
 * The managed sync checkpoint: when the source is still `incarnation` and its `last_commit` is still `from` (or already
 * `commit` with `acceptAtCommit`), and its pinned slug mode allows the run, sets `last_commit`, `last_sync_at` (the
 * database clock), `newest_content_at` (the newest `updated_at` of the source's live pages, or null) and
 * `config.slug_root_mode`. A refused checkpoint changes nothing; `pinnedSlugMode` then names a pinned mode that
 * differs from the run's (not read when the run keeps the pinned mode), else null.
 */
export async function advanceSyncCheckpoint(exec: SqlExecutor, input: SyncCheckpointAdvance): Promise<{ advanced: boolean; pinnedSlugMode: string | null }> {
  const { rows: changed } = await exec.run<{ id: string }>(advanceSyncCheckpointFragment(input));
  if (changed.length > 0) return { advanced: true, pinnedSlugMode: null };
  if (input.keepPinnedSlugMode) return { advanced: false, pinnedSlugMode: null };
  const [row] = await exec.executeRaw<{ mode: string | null }>(PINNED_SLUG_MODE_SQL, [input.sourceId, input.incarnation]);
  return { advanced: false, pinnedSlugMode: row?.mode != null && row.mode !== input.slugMode ? row.mode : null };
}

const PINNED_SLUG_MODE_SQL = "SELECT config->>'slug_root_mode' AS mode FROM sources WHERE id = $1 AND incarnation = $2::uuid";
function advanceSyncCheckpointFragment(input: SyncCheckpointAdvance): SqlFragment {
  return sqlFragment`
    UPDATE sources SET last_commit = ${input.commit}, last_sync_at = now(),
      config = jsonb_set(${trustedSql(SOURCE_CONFIG_OBJECT_SQL)}, '{slug_root_mode}',
        to_jsonb(CASE WHEN ${input.keepPinnedSlugMode}::boolean THEN COALESCE(config->>'slug_root_mode', ${input.slugMode}::text) ELSE ${input.slugMode}::text END)),
      newest_content_at = (SELECT MAX(updated_at) FROM pages WHERE source_id = ${input.sourceId} AND deleted_at IS NULL)
    WHERE id = ${input.sourceId} AND incarnation = ${input.incarnation}::uuid
      AND (last_commit IS NOT DISTINCT FROM ${input.from}::text OR (${input.acceptAtCommit}::boolean AND last_commit = ${input.commit}))
      AND (${input.keepPinnedSlugMode}::boolean OR config->>'slug_root_mode' IS NULL OR config->>'slug_root_mode' = ${input.slugMode})
    RETURNING id`;
}
/** Every statement `advanceSyncCheckpoint` can send (the checkpoint update of `sources` and the pinned-mode read; the fragment's values are placeholders, its text is fixed): the shadow write sampler judges the member by them (shadow/write-capture.ts). */
export const ADVANCE_SYNC_CHECKPOINT_SQL: readonly string[] = [
  renderFragment(advanceSyncCheckpointFragment({ sourceId: '', incarnation: '', commit: null, from: null, acceptAtCommit: false, slugMode: '', keepPinnedSlugMode: false } as SyncCheckpointAdvance)).text,
  PINNED_SLUG_MODE_SQL,
];

/**
 * Ids of live sources whose last sync is more than seven days old by the database clock (`now()`), by id: the
 * advisor's stale-sync read. Unscoped on master. Throws on a schema without `last_sync_at` or `archived`.
 */
export async function listStaleSyncSourceIds(exec: LegacyUnscopedRead): Promise<string[]> {
  const rows = await exec.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE last_sync_at IS NOT NULL AND last_sync_at < now() - interval '7 days' AND NOT archived ORDER BY id COLLATE "C"`,
  );
  return rows.map(r => r.id);
}

/** One source with the columns import and contextual retrieval read, or null for an unknown id. Rows come back as the driver returns them. */
export async function getSource(exec: RawQuery, sourceId: string): Promise<SourceDetailRow | null> {
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

/**
 * How many live (not archived) sources are bound to a local repository, unscoped (the readiness sync probe read it
 * through `executeRaw`). An empty path counts as unbound, as NULL does.
 */
export async function countRepoBoundSources(exec: LegacyUnscopedRead): Promise<number> {
  const rows = await exec.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM sources WHERE NOT archived AND local_path IS NOT NULL AND local_path <> ''`);
  return Number(rows[0]?.n ?? 0);
}

/** A source id and its local path (`listSourcePathRows`). */
export interface SourcePathRow { id: string; local_path: string }

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
/** Every source with a local path, archived ones included, as `{ id, local_path }`, in no particular order: the other
 * sources' directories `sources add` checks an API-backed kind's --dir against (sources-ops.ts insertApiSource). */
export async function listSourcePathRows(exec: LegacyUnscopedRead): Promise<SourcePathRow[]> {
  return exec.executeRaw<SourcePathRow>('SELECT id,local_path FROM sources WHERE local_path IS NOT NULL');
}

export async function listLocalPathSources(exec: RawQuery): Promise<LocalPathSourceRow[]> {
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
export async function listSourceRoutingRows(exec: RawQuery): Promise<SourceRoutingRow[]> {
  return exec.executeRaw<SourceRoutingRow>(
    `SELECT id, local_path, archived, config, EXISTS (SELECT 1 FROM pages WHERE source_id = 'default' AND deleted_at IS NULL) AS default_has_pages FROM sources ORDER BY id COLLATE "C"`,
  );
}

/**
 * Live pages in `default`, live pages elsewhere, and the number of non-default sources holding a live page (the
 * default-write guard). Soft-deleted pages are left out. Unscoped on master.
 */
export async function countDefaultSourceSplit(exec: RawQuery): Promise<DefaultSourceSplit> {
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

/** The stored frontmatter id and title of one live page, by id. */
export interface PageIdentityRow { fm_id: string | null; title: string | null }

export const PAGE_IDENTITY_SQL = `SELECT frontmatter->>'id' AS fm_id, title FROM pages WHERE id = $1 AND deleted_at IS NULL`;

/** The frontmatter id and title of live page `pageId`; null for a missing or soft-deleted page. Unscoped on master. */
export async function readPageIdentity(exec: LegacyUnscopedRead, pageId: number): Promise<PageIdentityRow | null> {
  const [row] = await exec.executeRaw<PageIdentityRow>(PAGE_IDENTITY_SQL, [pageId]);
  return row ?? null;
}

/** Pages of one source (`SELECT COUNT(*)::int AS n FROM pages WHERE source_id=$1`); soft-deleted pages count only with `includeDeleted`. Unscoped on master. */
export async function countSourcePages(exec: LegacyUnscopedRead, sourceId: string, opts?: { includeDeleted?: boolean }): Promise<number> {
  const sql = opts?.includeDeleted === true
    ? 'SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1'
    : 'SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL';
  const [row] = await exec.executeRaw<{ n: number }>(sql, [sourceId]);
  return Number(row?.n ?? 0);
}

/** A stored page a sync size-state read reports (`readPageSizeRows`); `state`/`reason` are its page_embedding_budget row. */
export interface PageSizeRow { slug: string; bytes: number | string | null; segmented: boolean; frontmatter: Record<string, unknown> | null; state: 'held' | 'capped' | null; reason: string | null }

const PAGE_SIZE_ROWS_SQL = `SELECT p.slug, (CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)::bigint AS bytes, p.body_storage = 'segmented' AS segmented, p.frontmatter, b.state, b.reason
       FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL
        AND (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' OR (CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END) > $2 OR p.body_storage = 'segmented' OR b.page_id IS NOT NULL) ORDER BY p.slug COLLATE "C"`;
const PAGE_SIZE_ROWS_FOR_SLUGS_SQL = `SELECT p.slug, (CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)::bigint AS bytes, p.body_storage = 'segmented' AS segmented, p.frontmatter, b.state, b.reason
       FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug = ANY($3::text[])
        AND (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' OR (CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END) > $2 OR p.body_storage = 'segmented' OR b.page_id IS NOT NULL) ORDER BY p.slug COLLATE "C"`;

/**
 * The live pages of one source (only `slugs` when given) that carry embed_skip, have a body over `maxBytes`, are
 * segmented or have a page_embedding_budget row, in slug byte order (COLLATE "C", so a Postgres brain on a locale
 * collation answers in PGLite's order): the rows page-embedding-budget.ts readPageSizeStates maps.
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

/**
 * Adds one to the source's purge epoch and returns the new value as stored, or null for an unknown source: the bump a
 * fact, page or replayed purge makes in its transaction, so a request prepared under the old epoch is refused
 * (belief/purge.ts `bumpPurgeEpoch`) and a cached sync reason scan is not reused (reason-trailers.ts).
 */
export async function advanceSourcePurgeEpoch(exec: SqlExecutor, sourceId: string): Promise<string | number | null> {
  const [row] = await exec.executeRaw<{ purge_epoch: string | number }>('UPDATE sources SET purge_epoch = purge_epoch + 1 WHERE id = $1 RETURNING purge_epoch', [sourceId]);
  return row?.purge_epoch ?? null;
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

/** What `readSourcesNotReadable` counts (sources-not-readable.ts): world facts too (recall, query), and the remote read floor. */
export interface SourcesNotReadableOpts { facts: boolean; excludePrivate: boolean }

/**
 * Whether an unscoped remote read over `readable` reads nothing while other sources hold pages: no live, unquarantined
 * page in `readable` (with `facts`, no active world fact either) and such a page in some other source that is not
 * archived. `excludePrivate` adds the remote read floor (`remoteReadFloorSql('p')`) for the caller in context to both
 * sides. Unscoped on master.
 */
export async function readSourcesNotReadable(exec: LegacyUnscopedRead, readable: readonly string[], opts: SourcesNotReadableOpts): Promise<boolean> {
  const ids = [...readable];
  const visible = opts.excludePrivate
    ? sqlFragment` AND ${trustedSql(quarantineFilterFragment('p'))} AND ${trustedSql(remoteReadFloorSql('p'))}`
    : sqlFragment` AND ${trustedSql(quarantineFilterFragment('p'))}`;
  const facts = opts.facts
    ? sqlFragment` OR EXISTS (SELECT 1 FROM facts WHERE source_id = ANY(${ids}::text[]) AND visibility = 'world'
                       AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()))`
    : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.source_id = ANY(${ids}::text[]) AND p.deleted_at IS NULL${visible})${facts} THEN false
                   ELSE EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id
                                 WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE AND NOT (p.source_id = ANY(${ids}::text[]))${visible})
              END AS refuse`);
  const [row] = await exec.executeRaw<{ refuse: boolean }>(text, params);
  return row?.refuse === true;
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

/** A source id and its incarnation as text (`listSourceIncarnations`). */
export interface SourceIncarnationListRow { id: string; incarnation: string }

/** The incarnation of each known source of `sourceIds`, in byte order of id (a repair preview hash binds it). */
export async function listSourceIncarnations(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<SourceIncarnationListRow[]> {
  return exec.executeRaw<SourceIncarnationListRow>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"', [[...sourceIds]]);
}

/**
 * An archived source is purge-eligible only when both archive timestamps are real
 * and its window has elapsed. A missing or epoch timestamp (#5452) cannot prove the
 * 72h recovery window was honored, so it never reads as expired.
 */
export const EXPIRED_ARCHIVE_SQL = `archived = true AND archived_at > '1970-01-02'::timestamptz
  AND archive_expires_at > '1970-01-02'::timestamptz AND archive_expires_at <= now()`;
export const UNVERIFIED_ARCHIVE_SQL = `archived = true AND (archived_at IS NULL OR archived_at <= '1970-01-02'::timestamptz
  OR archive_expires_at IS NULL OR archive_expires_at <= '1970-01-02'::timestamptz)`;

/**
 * #7072: a source delete removes its pages only through the pages -> sources
 * ON DELETE CASCADE. True when that cascade fires on this brain: the foreign key
 * exists on pages.source_id, cascades, and its delete trigger on sources is enabled
 * for this session. Where it does not, a delete would leave the pages live with no
 * sources row, unwritable and outside every per-source audit.
 */
const PAGES_CASCADE_SQL = `EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_trigger t ON t.tgconstraint = c.oid AND t.tgrelid = c.confrelid
   WHERE c.contype = 'f' AND c.conrelid = 'pages'::regclass AND c.confrelid = 'sources'::regclass AND c.confdeltype = 'c'
     AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'pages'::regclass AND a.attname = 'source_id')]
     AND t.tgfoid = 'pg_catalog."RI_FKey_cascade_del"'::regproc
     AND (t.tgenabled = 'A' OR (t.tgenabled = 'O' AND current_setting('session_replication_role') <> 'replica')))`;

/**
 * #9068: CTEs that remove what names a removed source's pages outside a foreign key, for `sourceId`, each only
 * when `gate` holds: the source's retrieval_event_pages, retrieval_event_links, retrieval_feedback and
 * context_volunteer_events rows, and each eval candidate's captured slugs that no other source the candidate covers
 * still has a page for (retrieval_weights and mention_gazetteer_entries cascade from sources). #9146: also the
 * source's core_edit_notices and write_gate_holds with the holds' receipts (take_proposals, open_loops, page_aliases,
 * slug_aliases and slug_rename_history cascade from sources). Every removal runs
 * them in the statement that deletes the sources row (gated on that delete), so the source and those rows go
 * together, then again in a later statement: that statement reads past a feedback write or eval capture that held one
 * of the source's page rows while the delete waited for it (a later one finds no page).
 */
export function removedSourceScrubCtes(sourceId: string, gate: SqlFragment): SqlFragment {
  const elsewhereU = sqlFragment`EXISTS (SELECT 1 FROM pages pg WHERE pg.slug = u.s AND pg.source_id = ANY(c.source_ids) AND pg.source_id <> ${sourceId})`;
  const elsewhereR = sqlFragment`EXISTS (SELECT 1 FROM pages pg WHERE pg.slug = r.s AND pg.source_id = ANY(c.source_ids) AND pg.source_id <> ${sourceId})`;
  return sqlFragment`scrub_retrieval_event_pages AS (DELETE FROM retrieval_event_pages WHERE source_id = ${sourceId} AND ${gate}),
       scrub_retrieval_event_links AS (DELETE FROM retrieval_event_links WHERE source_id = ${sourceId} AND ${gate}),
       scrub_retrieval_feedback AS (DELETE FROM retrieval_feedback WHERE source_id = ${sourceId} AND ${gate}),
       scrub_context_volunteer_events AS (DELETE FROM context_volunteer_events WHERE source_id = ${sourceId} AND ${gate}),
       scrub_core_edit_notices AS (DELETE FROM core_edit_notices WHERE source_id = ${sourceId} AND ${gate}),
       scrub_write_gate_holds AS (DELETE FROM write_gate_holds WHERE source_id = ${sourceId} AND ${gate} RETURNING id::text AS id),
       scrub_write_gate_receipts AS (DELETE FROM write_gate_receipts r USING scrub_write_gate_holds h WHERE r.target_table = 'write_gate_holds' AND r.target_id = h.id),
       scrub_eval_candidates AS (UPDATE eval_candidates c
      SET retrieved_slugs = ARRAY(SELECT u.s FROM unnest(c.retrieved_slugs) WITH ORDINALITY AS u(s, n) WHERE ${elsewhereU} ORDER BY u.n)
      WHERE ${sourceId} = ANY(c.source_ids) AND EXISTS (SELECT 1 FROM unnest(c.retrieved_slugs) AS r(s) WHERE NOT ${elsewhereR}) AND ${gate})`;
}

/**
 * The source lifecycle's remove/purge statements (it runs them in its own topology transaction): delete one
 * incarnation's sources row with the removedSourceScrubCtes rows, and the later ungated rescrub. Text and params.
 */
export function sourceIncarnationDeleteStatement(sourceId: string, incarnation: string): { text: string; params: unknown[] } {
  return renderFragment(sqlFragment`WITH gone AS (DELETE FROM sources WHERE id = ${sourceId} AND incarnation = ${incarnation}::uuid RETURNING id),
       ${removedSourceScrubCtes(sourceId, sqlFragment`EXISTS (SELECT 1 FROM gone)`)} SELECT 1`);
}
export function removedSourceRescrubStatement(sourceId: string): { text: string; params: unknown[] } {
  return renderFragment(sqlFragment`WITH ${removedSourceScrubCtes(sourceId, sqlFragment`true`)} SELECT 1`);
}

/** What `deleteSourceRecord` did: whether the row went, and how many pages blocked it (then nothing was deleted). */
export interface SourceDeleteResult { deleted: boolean; stranded: number }

/**
 * Deletes a `sources` row with that incarnation's persistence source binding (#5732; the binding has no FK, and a
 * kept one would make a same-id replacement read as claimed), the source's managed-sync cursors (`op_checkpoints`,
 * #8741) and the removedSourceScrubCtes rows, in one statement; a second statement repeats the scrub once the row is
 * gone, unless a source with this id exists again by then. A source with pages goes only when the pages cascade
 * (#7072); otherwise nothing is deleted and `stranded` counts the pages. `expiredArchiveOnly` deletes only an
 * archived source whose window has elapsed (EXPIRED_ARCHIVE_SQL). An unknown source returns `deleted: false`.
 */
export async function deleteSourceRecord(exec: SqlExecutor, id: string, opts: { expiredArchiveOnly?: boolean } = {}): Promise<SourceDeleteResult> {
  const expired = opts.expiredArchiveOnly ? sqlFragment`AND ${trustedSql(EXPIRED_ARCHIVE_SQL)}` : sqlFragment``;
  const { rows } = await exec.run<{ id: string | null; stranded: number }>(sqlFragment`
    WITH stranded AS (SELECT count(*)::int AS n FROM pages WHERE source_id = ${id} AND NOT ${trustedSql(PAGES_CASCADE_SQL)}),
       gone AS (DELETE FROM sources WHERE id = ${id} ${expired} AND (SELECT n FROM stranded) = 0 RETURNING id, incarnation),
       unbound AS (DELETE FROM persistence_source_bindings b USING gone
                    WHERE b.source_id = gone.id AND b.source_incarnation = gone.incarnation),
       cursors AS (DELETE FROM op_checkpoints c USING gone
                    WHERE c.op = 'managed-sync' AND c.completed_keys->0->>'sourceId' = gone.id),
       ${removedSourceScrubCtes(id, sqlFragment`EXISTS (SELECT 1 FROM gone)`)}
     SELECT id, 0 AS stranded FROM gone
     UNION ALL SELECT NULL, n FROM stranded WHERE n > 0 AND EXISTS (SELECT 1 FROM sources WHERE id = ${id} ${expired})`);
  const stranded = rows.find(row => row.id === null);
  if (stranded) return { deleted: false, stranded: Number(stranded.stranded) };
  if (!rows.length) return { deleted: false, stranded: 0 };
  await exec.run(sqlFragment`WITH ${removedSourceScrubCtes(id, sqlFragment`NOT EXISTS (SELECT 1 FROM sources WHERE id = ${id})`)} SELECT 1`);
  return { deleted: true, stranded: 0 };
}

/** The counts a source delete would remove (`sources remove` preview); null for an unknown source. */
export interface SourceDeleteImpact { id: string; name: string; pages: number; chunks: number; embeddings: number; files: number; facts: number }

/**
 * One source's id and name with the rows a delete would remove: pages (soft-deleted ones too), their chunks, the
 * chunks with an embedding, its files (0 on a brain without the `files` table) and its facts (0 on a brain from
 * before the `facts` table). Null for an unknown source.
 */
export async function readSourceDeleteImpact(exec: LegacyUnscopedRead, sourceId: string): Promise<SourceDeleteImpact | null> {
  const [src] = (await exec.run<{ id: string; name: string }>(sqlFragment`SELECT id, name FROM sources WHERE id = ${sourceId}`)).rows;
  if (!src) return null;
  const [counts] = (await exec.run<{ pages: number; chunks: number; embeddings: number }>(
    // chunk-visibility-ok: a source delete removes every chunk row of its pages, staged and retired ones too
    sqlFragment`SELECT (SELECT COUNT(*)::int FROM pages WHERE source_id = ${sourceId}) AS pages,
            (SELECT COUNT(*)::int FROM content_chunks cc JOIN pages p ON cc.page_id = p.id WHERE p.source_id = ${sourceId}) AS chunks,
            (SELECT COUNT(*)::int FROM content_chunks cc JOIN pages p ON cc.page_id = p.id
              WHERE p.source_id = ${sourceId} AND cc.embedding IS NOT NULL) AS embeddings`,
  )).rows;
  const [probe] = (await exec.run<{ files: boolean; facts: boolean }>(
    sqlFragment`SELECT to_regclass('public.files') IS NOT NULL AS files, to_regclass('public.facts') IS NOT NULL AS facts`,
  )).rows;
  const count = async (fragment: SqlFragment) => Number((await exec.run<{ n: number }>(fragment)).rows[0]?.n ?? 0);
  return {
    id: src.id, name: src.name,
    pages: Number(counts?.pages ?? 0), chunks: Number(counts?.chunks ?? 0), embeddings: Number(counts?.embeddings ?? 0),
    files: probe?.files ? await count(sqlFragment`SELECT COUNT(*)::int AS n FROM files WHERE source_id = ${sourceId}`) : 0,
    facts: probe?.facts ? await count(sqlFragment`SELECT COUNT(*)::int AS n FROM facts WHERE source_id = ${sourceId}`) : 0,
  };
}
