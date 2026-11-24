/**
 * Doctor reads over `sources`: the statements `gbrain doctor` checks (and the helpers they call) ran through
 * `executeRaw`, each with the same text and parameters, on the engine's own `executeRaw`; only their home moved. The
 * Rust engine answers the same members from its source records (rust/crates/gbrain-store/src/cli_reads/doctor_sources.rs,
 * rust/docs/store/cli-reads-doctor-src.md).
 *
 * `readDoctorSources(variant, scope)` is every statement that reads the `sources` table alone. Each variant is one or
 * more constant statements (only the constant connector kind list CONNECTOR_KIND_LIST_SQL is spliced in), pinned against the text the caller built before by
 * test/doctor-reads-sql.test.ts. A variant that had a catch-and-retry fallback keeps it here, in order.
 */
import { CONNECTOR_KIND_LIST_SQL } from '../persistence/connector-kinds.ts';
import type { EngineRawRead } from './doctor-reads.ts';

/**
 * The members of this file. Each replaced statements doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_SRC_MEMBERS: readonly string[] = ['readDoctorSources', 'listGuestSourceRows', 'listCheckoutRoots', 'listPendingRoster',
  'listOwnedContentRows', 'countDefaultSourceFiles'];

/** `id, local_path, config` of a source; `config` as the driver returns it (an object, or JSON text on a historical row). */
export interface SourceRootRow { id: string; local_path: string | null; config: unknown }
export interface SourceIdRow { id: string }
export interface SourcePathRow { id: string; local_path: string }
export interface SourceConfigShapeRow { id: string; typ: string | null }
export interface SourceGitRow { id: string; local_path: string | null; last_commit: string | null }
export interface SourceConnectorRow { id: string; incarnation: string; local_path: string | null; config: unknown }
export interface SourcePathStateRow { id: string; local_path: string | null; archived: boolean }
export interface SourceShelfRow { local_path: string | null; config: unknown }
export interface SourceKindRow { id: string; local_path: string | null; kind: string | null }
export interface SourceConnectorKeyRow { id: string; incarnation: string; local_path: string | null; config: unknown; archived: boolean }
export interface SourceOptOutRow { config: unknown; incarnation: string }
export interface SourceDetachedRow { local_path: string | null; strategy: string | null; last_commit: string | null }
export interface SourceClaimRow { id: string; claimed: boolean; lifted: boolean }
/** A source the sync-freshness roster reads; the `upstream_*` columns read null on a schema that lacks them. */
export interface SourceFreshnessRow {
  id: string; name: string; local_path: string | null; last_sync_at: Date | null; last_commit: string | null; chunker_version: string | null;
  newest_content_at: Date | null; config: unknown; upstream_checked_at: Date | null; upstream_commit: string | null; upstream_behind: number | null;
}

/** The rows each variant answers. */
export interface DoctorSourceRows {
  /** Live sources with a checkout path, by id. */
  roots_live_ordered: SourceRootRow;
  /** Live sources with a checkout path, in no order; a schema without `archived` answers every source with a path. */
  roots_live_fallback: SourceRootRow;
  /** Ids of live sources with a checkout path (`scope.sourceIds` confines them). */
  live_path_ids: SourceIdRow;
  /** Sources whose config is not a JSON object. */
  config_shape: SourceConfigShapeRow;
  /** Live sources other than `default` with a non-empty path, by id. */
  relative_paths: SourcePathRow;
  /** Ids of live sources with no path (or an empty one), by id. */
  pathless_live: SourceIdRow;
  /** Sources with a path, archived ones included, by id (`scope.sourceIds` confines them). */
  paths_scoped: SourcePathRow;
  /** Live git-canonical sources, by id. */
  strict_git: SourceGitRow;
  /** Live Google sources, by id. */
  google_connectors: SourceConnectorRow;
  /** Sources whose config says guest, by id. */
  guest_marked_ids: SourceIdRow;
  /** The first two source ids. */
  first_two_ids: SourceIdRow;
  /** Every source id, by id. */
  all_ids: SourceIdRow;
  /** Ids of the sources that hold a live page, by id. */
  ids_with_live_pages: SourceIdRow;
  /** Every source's path and archived flag. */
  local_path_state: SourcePathStateRow;
  /** The storage source (`scope.sourceId`) unless archived. */
  storage_shelf: SourceShelfRow;
  /** One source (`scope.sourceId`), archived or not, with its config kind. */
  brain_writer_by_id: SourceKindRow;
  /** Live sources with a path and their config kind, by id (a schema without `archived` answers every source with a path). */
  brain_writer_live: SourceKindRow;
  /** Every live source with its incarnation. */
  live_incarnations: SourceConnectorRow;
  /** Every connector source (archived too) with its incarnation. */
  connector_keys: SourceConnectorKeyRow;
  /** Live sources with a path for the sync-freshness roster (`scope.sourceIds` confines them); older schemas fall back in order. */
  freshness: SourceFreshnessRow;
  /** One live source's (`scope.sourceId`) config and incarnation. */
  shared_skills_view: SourceOptOutRow;
  /** One live source's (`scope.sourceId`) path, sync strategy and last synced commit. */
  detached: SourceDetachedRow;
  /** Ids of live sources whose own contextual retrieval mode is the synopsis tier, by id. */
  synopsis_ids: SourceIdRow;
  /** Live non-connector sources with whether each is claimed and whether its claim lift finished, by id. */
  claim_candidates: SourceClaimRow;
}

export type DoctorSourceVariant = keyof DoctorSourceRows;

/** Which rows a variant reads: `sourceIds` confines an id-list variant (absent or null reads every source), `sourceId` names one. */
export interface DoctorSourceScope { sourceIds?: readonly string[] | null; sourceId?: string }

type Attempt = readonly [sql: string, params?: unknown[]];
type Plan = (scope: DoctorSourceScope) => readonly Attempt[];

const ROOTS_LIVE_ORDERED = 'SELECT id, local_path, config FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL ORDER BY id COLLATE "C"';
const ROOTS_LIVE = 'SELECT id, local_path, config FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE';
const ROOTS_ANY = 'SELECT id, local_path, config FROM sources WHERE local_path IS NOT NULL';
const LIVE_PATH_IDS = 'SELECT id FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL';
const LIVE_PATH_IDS_SCOPED = 'SELECT id FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL AND id = ANY($1::text[])';
const KIND_LIVE = "SELECT id, local_path, config->>'kind' AS kind FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE ORDER BY id COLLATE \"C\"";
const KIND_ANY = "SELECT id, local_path, config->>'kind' AS kind FROM sources WHERE local_path IS NOT NULL ORDER BY id COLLATE \"C\"";
const FRESH_UPSTREAM = 'SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at, config, upstream_checked_at, upstream_commit, upstream_behind FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE';
const FRESH_UPSTREAM_SCOPED = 'SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at, config, upstream_checked_at, upstream_commit, upstream_behind FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE AND id = ANY($1::text[])';
const FRESH_BARE = 'SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at, config, NULL AS upstream_checked_at, NULL AS upstream_commit, NULL AS upstream_behind FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE';
const FRESH_BARE_SCOPED = 'SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at, config, NULL AS upstream_checked_at, NULL AS upstream_commit, NULL AS upstream_behind FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE AND id = ANY($1::text[])';
const FRESH_ANY = 'SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at, config, NULL AS upstream_checked_at, NULL AS upstream_commit, NULL AS upstream_behind FROM sources WHERE local_path IS NOT NULL';
const FRESH_ANY_SCOPED = 'SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at, config, NULL AS upstream_checked_at, NULL AS upstream_commit, NULL AS upstream_behind FROM sources WHERE local_path IS NOT NULL AND id = ANY($1::text[])';

const one = (sql: string, params?: unknown[]): readonly Attempt[] => [[sql, params]];

function requireSourceId(variant: string, scope: DoctorSourceScope): string {
  if (typeof scope.sourceId !== 'string') throw new Error(`readDoctorSources: ${variant} needs a sourceId`);
  return scope.sourceId;
}

const PLANS: { readonly [V in DoctorSourceVariant]: Plan } = {
  roots_live_ordered: () => one(ROOTS_LIVE_ORDERED),
  roots_live_fallback: () => [[ROOTS_LIVE], [ROOTS_ANY]],
  live_path_ids: (scope) => (scope.sourceIds ? one(LIVE_PATH_IDS_SCOPED, [scope.sourceIds]) : one(LIVE_PATH_IDS)),
  config_shape: () => one("SELECT id, jsonb_typeof(config) AS typ FROM sources WHERE jsonb_typeof(config) <> 'object'"),
  relative_paths: () => one("SELECT id, local_path FROM sources WHERE id <> 'default' AND local_path IS NOT NULL AND local_path <> '' AND archived IS NOT TRUE ORDER BY id COLLATE \"C\""),
  pathless_live: () => one("SELECT id FROM sources WHERE (local_path IS NULL OR local_path = '') AND archived IS NOT TRUE ORDER BY id COLLATE \"C\""),
  paths_scoped: (scope) => one('SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND ($1::text[] IS NULL OR id = ANY($1::text[])) ORDER BY id COLLATE "C"', [scope.sourceIds ?? null]),
  strict_git: () => one("SELECT id, local_path, last_commit FROM sources WHERE NOT archived AND COALESCE(config->>'canonical','')='git' ORDER BY id COLLATE \"C\""),
  google_connectors: () => one("SELECT id, incarnation::text AS incarnation, local_path, config FROM sources WHERE archived IS NOT TRUE AND config->>'kind' = 'google' ORDER BY id COLLATE \"C\""),
  guest_marked_ids: () => one("SELECT id FROM sources WHERE COALESCE(config->>'guest' = 'true', false) ORDER BY id COLLATE \"C\""),
  first_two_ids: () => one('SELECT id FROM sources ORDER BY id COLLATE "C" LIMIT 2'),
  all_ids: () => one('SELECT id FROM sources ORDER BY id COLLATE "C"'),
  ids_with_live_pages: () => one('SELECT s.id FROM sources s WHERE EXISTS (SELECT 1 FROM pages p WHERE p.source_id = s.id AND p.deleted_at IS NULL) ORDER BY s.id COLLATE "C"'),
  local_path_state: () => one('SELECT id, local_path, archived FROM sources'),
  storage_shelf: (scope) => one('SELECT local_path, config FROM sources WHERE id = $1 AND archived IS NOT TRUE', [requireSourceId('storage_shelf', scope)]),
  brain_writer_by_id: (scope) => one("SELECT id, local_path, config->>'kind' AS kind FROM sources WHERE id = $1", [requireSourceId('brain_writer_by_id', scope)]),
  brain_writer_live: () => [[KIND_LIVE], [KIND_ANY]],
  live_incarnations: () => one('SELECT id,incarnation::text AS incarnation,local_path,config FROM sources WHERE archived IS NOT TRUE'),
  connector_keys: () => one(`SELECT id,incarnation::text,local_path,config,archived FROM sources WHERE config->>'kind' IN ${CONNECTOR_KIND_LIST_SQL}`),
  freshness: (scope) => (scope.sourceIds
    ? [[FRESH_UPSTREAM_SCOPED, [scope.sourceIds]], [FRESH_BARE_SCOPED, [scope.sourceIds]], [FRESH_ANY_SCOPED, [scope.sourceIds]]]
    : [[FRESH_UPSTREAM], [FRESH_BARE], [FRESH_ANY]]),
  shared_skills_view: (scope) => one('SELECT config,incarnation FROM sources WHERE id=$1 AND NOT archived', [requireSourceId('shared_skills_view', scope)]),
  detached: (scope) => one("SELECT local_path, config->>'strategy' AS strategy, last_commit FROM sources WHERE id=$1 AND archived IS NOT TRUE", [requireSourceId('detached', scope)]),
  synopsis_ids: () => one("SELECT id FROM sources WHERE contextual_retrieval_mode = 'per_chunk_synopsis' AND NOT archived ORDER BY id COLLATE \"C\""),
  claim_candidates: () => one(`SELECT s.id, (s.config ? 'trust_claimed_at' AND s.config->>'trust_tier' = 'operator_curated' AND COALESCE(s.config->>'kind', '') NOT IN ${CONNECTOR_KIND_LIST_SQL}) AS claimed, `
    + `(s.config ? 'trust_claim_lifted_at') AS lifted FROM sources s WHERE NOT s.archived AND COALESCE(s.config->>'kind', '') NOT IN ${CONNECTOR_KIND_LIST_SQL} ORDER BY s.id COLLATE "C"`),
};

/** Rows of one variant. A variant with fallbacks tries each statement in turn and throws the last one's error. */
export async function readDoctorSources<V extends DoctorSourceVariant>(raw: EngineRawRead, variant: V, scope: DoctorSourceScope = {}): Promise<DoctorSourceRows[V][]> {
  const plan = PLANS[variant];
  if (!plan) throw new Error(`readDoctorSources: '${String(variant)}' is not a doctor source variant`);
  const attempts = plan(scope);
  for (let i = 0; i < attempts.length; i++) {
    const [sql, params] = attempts[i]!;
    try { return await raw<DoctorSourceRows[V]>(sql, params); } catch (error) { if (i === attempts.length - 1) throw error; }
  }
  throw new Error(`readDoctorSources: ${variant} has no statement`);
}

/** A checkout root of the coordination-lock check: a source's path with its id, or a host-bound path with none. */
export interface CheckoutRootRow { root: string; source_id: string | null }

/** Live sources' roots, and the roots this host's worktree bindings hold (`hostId` is the local host's uuid). */
export async function listCheckoutRoots(raw: EngineRawRead, hostId: string | null): Promise<CheckoutRootRow[]> {
  return raw<CheckoutRootRow>(`
      SELECT DISTINCT local_path AS root,id AS source_id FROM sources WHERE local_path IS NOT NULL AND NOT COALESCE(archived,false)
      UNION SELECT DISTINCT h.local_path,NULL FROM persistence_host_bindings h WHERE h.host_id=$1::uuid`, [hostId]);
}

/** A guest source with its guest_sources writers and trust ceiling (null without a guest_sources row). */
export interface GuestSourceRow { id: string; local_path: string | null; config: unknown; writers: string[] | null; ceiling: string | null }

/**
 * Sources whose config says guest or that have a guest_sources row, by id. Throws the missing-table error on a schema
 * behind the guest-notes migration; the caller falls back to `readDoctorSources('guest_marked_ids')`.
 */
export async function listGuestSourceRows(raw: EngineRawRead): Promise<GuestSourceRow[]> {
  return raw<GuestSourceRow>(
    'SELECT s.id, s.local_path, s.config, g.writers, g.trust_ceiling AS ceiling FROM sources s LEFT JOIN guest_sources g ON g.source_id = s.id '
    + "WHERE (COALESCE(s.config->>'guest' = 'true', false) OR EXISTS (SELECT 1 FROM guest_sources gs WHERE gs.source_id = s.id)) ORDER BY s.id COLLATE \"C\"");
}

/** A source of the sync roster: its last synced commit, whether a worktree binding manages it, and the root this host reads it at. */
export interface PendingRosterRow { id: string; last_commit: string | null; config: unknown; managed: unknown; root: string | null }

/** Live sources that are bound to a worktree or have a path, by id; `sourceIds` null reads every source. */
export async function listPendingRoster(raw: EngineRawRead, sourceIds: readonly string[] | null, hostId: string | null): Promise<PendingRosterRow[]> {
  return raw<PendingRosterRow>(
    `SELECT s.id, s.last_commit, s.config, (b.source_id IS NOT NULL) AS managed, COALESCE(h.local_path, s.local_path) AS root
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = b.worktree_id AND h.host_id::text = $2
      WHERE s.archived IS NOT TRUE AND (b.source_id IS NOT NULL OR s.local_path IS NOT NULL)
        AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
      ORDER BY s.id COLLATE "C"`, [sourceIds ?? null, hostId]);
}

/** One gbrain-owned content source with its receipt, owner binding and the persistence work it still has. */
export interface OwnedContentRow {
  id: string; incarnation: string; local_path: string; config: unknown; last_commit: string | null;
  brain_id: string; receipt: string; owner_root: string; relative_path: string; pending: number; recovering: number;
}

/** Sources with a complete owner binding and a shared-skills receipt; `inheritsPersistence` also reads a brain whose persistence is off. */
export async function listOwnedContentRows(raw: EngineRawRead, sourceIds: readonly string[] | null, inheritsPersistence: boolean): Promise<OwnedContentRow[]> {
  return raw<OwnedContentRow>(`SELECT s.id,s.incarnation,s.local_path,s.config,s.last_commit,p.brain_id,c.value AS receipt,
      h.local_path AS owner_root,b.relative_path,
      ((SELECT COUNT(*) FROM persistence_requests r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation
        AND r.state IN ('queued','running') AND r.recovery IS NULL)
       +(SELECT COUNT(*) FROM persistence_effects e WHERE e.source_id=s.id AND e.source_incarnation=s.incarnation
        AND e.kind='withdrawal-mirror' AND e.state IN ('queued','running') AND e.recovery IS NULL))::integer AS pending,
      ((SELECT COUNT(*) FROM persistence_requests r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation
        AND (r.state='recovering' OR r.recovery IS NOT NULL))
       +(SELECT COUNT(*) FROM persistence_effects e WHERE e.source_id=s.id AND e.source_incarnation=s.incarnation
        AND e.recovery IS NOT NULL))::integer AS recovering
    FROM sources s JOIN persistence_brain p ON p.singleton=1 AND (p.enabled OR $2::boolean)
    JOIN config c ON c.key='shared_skills.content.v1.'||s.id||'.'||s.incarnation::text
    JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
    JOIN persistence_worktrees w ON w.id=b.worktree_id AND w.state='active' AND w.owner_host_id IS NOT NULL
    JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=w.owner_host_id
    WHERE NOT s.archived AND s.local_path IS NOT NULL AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS (SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain')`,
  [sourceIds ?? null, inheritsPersistence]);
}

/** Live pages of the `default` source and how many record a source path. */
export interface DefaultSourceFiles { live: number; file_backed: number }

/** Live pages of the `default` source, and those backed by a file. */
export async function countDefaultSourceFiles(raw: EngineRawRead): Promise<DefaultSourceFiles> {
  const [row] = await raw<{ live: number | string; file_backed: number | string }>(
    `SELECT COUNT(*)::int AS live,
              COUNT(*) FILTER (WHERE source_path IS NOT NULL)::int AS file_backed
         FROM pages
        WHERE source_id = 'default' AND deleted_at IS NULL`);
  return { live: Number(row?.live ?? 0), file_backed: Number(row?.file_backed ?? 0) };
}
