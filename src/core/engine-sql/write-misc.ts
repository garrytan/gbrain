/**
 * The statements a page write ran through `executeRaw` that belong to no other storage domain
 * (docs/research/rust-put-write-path.md): the source-state reads of admission, publication and effect recovery, the
 * shared-skillpack screen, the writer-binding read of ownership, the chronicle retire check, the access-member
 * read of `brainServes`, memory-proposal upkeep and the path attach of `sources add`. Each function keeps the statement text its call site ran, so PGLite
 * and Postgres answer exactly as before; a Rust brain answers from its store
 * (rust/crates/gbrain-store/src/write_misc.rs, rust/docs/store/write_misc.md).
 */
import { GUEST_SOURCES_HIDDEN_SQL } from '../guests/note.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { OWNER_MEMBER_KEY } from '../search/private-visibility.ts';
import type { SqlExecutor } from './executor.ts';

/** A source's identity and state as a write reads it (`readSourceState`); `config` is always an object. */
export interface SourceStateRow { incarnation: string; archived: boolean; local_path: string | null; config: Record<string, unknown> }

/** `readSourceState` options. `lock: 'share'` holds the row FOR SHARE until the caller's transaction ends. */
export interface SourceStateOptions { lock?: 'share' }

/**
 * Page admission's source row with, in the same statement, its guest_sources row (GBRA-504). `kind` and `role` are the
 * text of `config.kind` and `config.role`; guest_sources_hidden: row-level security keeps this role from reading
 * guest_sources, so admission refuses.
 */
export interface AdmissionSourceRow {
  incarnation: string; archived: boolean; local_path: string | null; kind: string | null; role: string | null;
  guest_writers: string[] | null; guest_trust_ceiling: string | null; guest_sources_hidden: boolean;
}

/** One shared skillpack bound to its source's current incarnation, with the roots its files live under on this host. */
export interface SharedSkillPackRoot {
  source_id: string; source_incarnation: string; source_root: string | null; worktree_root: string | null; relative_path: string | null;
}

/** Page admission's source read; renderFragment numbers the one bound id `$1`. */
const admissionSource = (sourceId: string) => sqlFragment`SELECT s.incarnation,s.archived,s.local_path,s.config->>'kind' AS kind,s.config->>'role' AS role,g.writers AS guest_writers,g.trust_ceiling AS guest_trust_ceiling,${trustedSql(GUEST_SOURCES_HIDDEN_SQL)} AS guest_sources_hidden FROM sources s LEFT JOIN guest_sources g ON g.source_id=s.id WHERE s.id=${sourceId}`;
/** The admission statement text; the pre-admission cache (persistence/preadmit-cache.ts) keys its entries on it. */
export const ADMISSION_SOURCE_SQL = renderFragment(admissionSource('')).text;

/** A config column as an object: PGLite can return jsonb as text, and a missing config reads as `{}`. */
function configObject(config: unknown): Record<string, unknown> {
  const value = typeof config === 'string' ? JSON.parse(config) as unknown : config;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A source's incarnation, archived flag, local path and config, or null for an unknown id; `lock: 'share'` adds FOR SHARE. */
export async function readSourceState(exec: LegacyUnscopedRead, sourceId: string, opts?: SourceStateOptions): Promise<SourceStateRow | null> {
  const { text, params } = renderFragment(opts?.lock === 'share'
    ? sqlFragment`SELECT incarnation,archived,local_path,config FROM sources WHERE id=${sourceId} FOR SHARE`
    : sqlFragment`SELECT incarnation,archived,local_path,config FROM sources WHERE id=${sourceId}`);
  const [row] = await exec.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; config: unknown }>(text, params);
  return row ? { incarnation: row.incarnation, archived: row.archived, local_path: row.local_path, config: configObject(row.config) } : null;
}

/** Page admission's source and guest_sources row, or null for an unknown id; throws the missing-table error on an old schema. */
export async function readAdmissionSource(exec: LegacyUnscopedRead, sourceId: string): Promise<AdmissionSourceRow | null> {
  const { text, params } = renderFragment(admissionSource(sourceId));
  const [row] = await exec.executeRaw<AdmissionSourceRow>(text, params);
  return row ?? null;
}

/** Whether the schema has the shared_skill_packs table (a brain created before shared skills does not). */
export async function sharedSkillPackTablePresent(exec: LegacyUnscopedRead): Promise<boolean> {
  const [row] = await exec.executeRaw<{ present: boolean }>("SELECT to_regclass('shared_skill_packs') IS NOT NULL AS present");
  return row?.present === true;
}

/**
 * The completed keys of one resumable op's checkpoint (op-checkpoint.ts loadOpCheckpoint): the append-only child rows
 * (`op_checkpoint_paths`) and the legacy `completed_keys` array, deduplicated in first-seen order. A non-array legacy
 * value is skipped, so the child rows still load, and reported as `corruptParent`.
 */
export async function readOpCheckpointKeys(exec: LegacyUnscopedRead, op: string, fingerprint: string): Promise<{ keys: string[]; corruptParent: boolean }> {
  // UNION ALL, not UNION: the Set below dedupes, so no server-side sort runs over a large checkpoint. The legacy arm is
  // gated on jsonb_typeof = 'array' because jsonb_array_elements_text throws on a scalar and would kill the whole union.
  const rows = await exec.executeRaw<{ ckey: unknown; corrupt: number }>(
    `SELECT path AS ckey, 0 AS corrupt FROM op_checkpoint_paths
       WHERE op = $1 AND fingerprint = $2
     UNION ALL
     SELECT jsonb_array_elements_text(completed_keys) AS ckey, 0 AS corrupt FROM op_checkpoints
       WHERE op = $1 AND fingerprint = $2 AND jsonb_typeof(completed_keys) = 'array'
     UNION ALL
     SELECT NULL AS ckey, 1 AS corrupt FROM op_checkpoints
       WHERE op = $1 AND fingerprint = $2 AND jsonb_typeof(completed_keys) <> 'array'`,
    [op, fingerprint],
  );
  const keys = new Set<string>();
  let corruptParent = false;
  for (const r of rows) {
    if (Number(r.corrupt) === 1) corruptParent = true;
    else if (typeof r.ckey === 'string') keys.add(r.ckey);
  }
  return { keys: [...keys], corruptParent };
}

/** One checkpoint parent as `readOpCheckpointRecord` returns it. */
export interface OpCheckpointRecord {
  /** The stored JSON, as written (a JSON array on every write path). */
  completed_keys: unknown;
  /** The stamp on the database clock, ISO 8601 with milliseconds, UTC. */
  updated_at: string;
  /** Whether the stamp is within `freshWithinDays` of the database clock; null when the caller did not ask. */
  fresh: boolean | null;
}

/**
 * The parent row of one checkpoint whose keys are JSON records rather than text keys: the repair runner's cursor
 * (repair/core.ts, op `repair`) and the preview-approval sets (persistence/preview-approval.ts, op
 * `repair-approval`). Freshness is measured on the database clock, the clock the checkpoint purge uses.
 */
export async function readOpCheckpointRecord(exec: LegacyUnscopedRead, op: string, fingerprint: string,
  opts: { freshWithinDays?: number } = {}): Promise<OpCheckpointRecord | null> {
  const days = opts.freshWithinDays === undefined ? null : String(opts.freshWithinDays);
  const [row] = await exec.executeRaw<{ completed_keys: unknown; updated_at: string; fresh: boolean | null }>(
    `SELECT completed_keys,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
            updated_at >= now() - ($3::text || ' days')::interval AS fresh
       FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`,
    [op, fingerprint, days]);
  return row ? { completed_keys: row.completed_keys, updated_at: row.updated_at, fresh: row.fresh ?? null } : null;
}

/**
 * The page clock of the get_health memo (health-memo.ts): the brain id and `page_generation_clock_seq`, which every
 * page insert, update or delete advances, as `<brain id>:<clock>`.
 */
export async function readHealthMemoClock(exec: LegacyUnscopedRead): Promise<string> {
  const [row] = await exec.executeRaw<{ brain: string | null; clock: string | null }>(
    `SELECT (SELECT brain_id::text FROM persistence_brain WHERE singleton = 1) AS brain,
            COALESCE((SELECT last_value FROM page_generation_clock_seq), 0)::text AS clock`);
  return `${row?.brain ?? ''}:${row?.clock ?? ''}`;
}

/** The live sources whose own contextual-retrieval mode is per_chunk_synopsis, by id (synopsis-sweep.ts). */
export async function listSynopsisSourceIds(exec: LegacyUnscopedRead): Promise<string[]> {
  const rows = await exec.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE contextual_retrieval_mode = 'per_chunk_synopsis' AND NOT archived ORDER BY id COLLATE "C"`);
  return rows.map(r => r.id);
}

/**
 * Whether a live markdown page names the synopsis tier in its frontmatter where the frontmatter is trusted: a page of
 * `default`, or of a source that trusts its pages' overrides, that is not archived (synopsis-sweep.ts, #9683: the probe
 * the sweep's single statement used to carry as a NULL row).
 */
export async function hasSynopsisFrontmatterOverride(exec: LegacyUnscopedRead): Promise<boolean> {
  const [row] = await exec.executeRaw<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pages p LEFT JOIN sources s ON s.id = p.source_id
       WHERE p.deleted_at IS NULL AND p.page_kind = 'markdown' AND NOT COALESCE(s.archived, false)
         AND p.frontmatter @> '{"contextual_retrieval":"per_chunk_synopsis"}'::jsonb
         AND (p.source_id = 'default' OR COALESCE(s.trust_frontmatter_overrides, false))) AS present`);
  return row?.present === true;
}

/** Every shared skillpack bound to its source's current incarnation, with its roots on host `hostId`. */
export function listSharedSkillPackRoots(exec: LegacyUnscopedRead, hostId: string): Promise<SharedSkillPackRoot[]> {
  return exec.executeRaw<SharedSkillPackRoot>(`SELECT p.source_id,p.source_incarnation,s.local_path AS source_root,
      h.local_path AS worktree_root,b.relative_path FROM shared_skill_packs p
      JOIN sources s ON s.id=p.source_id AND s.incarnation=p.source_incarnation
      LEFT JOIN persistence_source_bindings b ON b.source_id=p.source_id AND b.source_incarnation=p.source_incarnation
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid`, [hostId]);
}

/** Whether source incarnation `incarnation` of `sourceId` holds a shared skillpack row (ghost-pages.ts, #6910). */
export async function hasSharedSkillPack(exec: LegacyUnscopedRead, sourceId: string, incarnation: string): Promise<boolean> {
  const rows = await exec.executeRaw('SELECT 1 FROM shared_skill_packs WHERE source_id=$1 AND source_incarnation=$2::uuid', [sourceId, incarnation]);
  return rows.length > 0;
}

/**
 * #6910 (shared-skills/knowledge-guard.ts sharedPackMember): whether one of `paths` (source-relative, `/`-separated) is a
 * file of a live skill head's current revision of the source incarnation, or lies under a live skill's `skills/<name>/`.
 */
export async function isSharedSkillPackMember(exec: LegacyUnscopedRead, sourceId: string, incarnation: string, paths: string[]): Promise<boolean> {
  const [row] = await exec.executeRaw<{ member: boolean }>(`SELECT EXISTS (SELECT 1 FROM shared_skill_heads h
      JOIN shared_skill_revisions r ON r.source_id=h.source_id AND r.source_incarnation=h.source_incarnation AND r.pack_id=h.pack_id AND r.name=h.name AND r.revision=h.revision
      WHERE h.source_id=$1 AND h.source_incarnation=$2::uuid AND NOT h.deleted AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements(r.files) f WHERE f->>'path' = ANY($3::text[]))
        OR EXISTS (SELECT 1 FROM unnest($3::text[]) p WHERE starts_with(p, 'skills/' || h.name || '/')))) AS member`, [sourceId, incarnation, paths]);
  return row?.member === true;
}

/** The recorded file aliases of page `slug` of `sourceId`, soft-deleted or live (the knowledge guard's screen, #6910). */
export function readPageFileAliases(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<Array<{ source_path: string | null; source_uri: string | null }>> {
  return exec.executeRaw<{ source_path: string | null; source_uri: string | null }>(
    'SELECT source_path,source_uri FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
}

/** Page `slug` of `sourceId` when it is a tombstone (soft-deleted), with its recorded source path; null otherwise (#7345). */
export async function readPageTombstoneSourcePath(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<{ source_path: string | null } | null> {
  const [row] = await exec.executeRaw<{ source_path: string | null }>(
    'SELECT source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL', [sourceId, slug]);
  return row ?? null;
}

/** A source's #5182 per-host Git-durability opt-in: null until an operator records one. */
export type GitDurabilitySetting = 'enabled' | 'disabled' | null;

/** A source's writer binding as one host sees it (`getWorktreeBinding`); the host columns are null without a host row. */
export interface WorktreeBinding {
  worktree_id: string;
  source_id: string;
  source_incarnation: string;
  relative_path: string;
  topology_generation: string | number;
  owner_host_id: string | null;
  owner_epoch: string | number;
  state: 'active' | 'draining' | 'recovering';
  local_path: string | null;
  coordination_path: string | null;
  /** #5182 per-host Git-durability opt-in: null until an operator records one. */
  git_durability: GitDurabilitySetting;
  /** C-5: when the prepared transfer was recorded (manifest `prepared_at`); null when none is, or an older release prepared it. */
  prepared_at?: string | null;
  /** G2 (git-door.ts): the source is strict (`config.canonical = "git"`), read with the binding so a write pays no extra statement. */
  canonical_git?: boolean | null;
}

/**
 * The source's binding as host `$2` sees it. The legacy sweep's screen (persistence/sync-convergence.ts) memoizes
 * this exact text, so a change here changes what that screen answers once per slice.
 */
export const WORKTREE_BINDING_SQL = `SELECT s.source_id,s.source_incarnation,s.worktree_id,s.relative_path,
    s.topology_generation::text AS topology_generation,w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.state,
    h.local_path,h.coordination_path,h.git_durability,w.manifest->>'prepared_at' AS prepared_at,
    (SELECT COALESCE(src.config->>'canonical','')='git' FROM sources src WHERE src.id=s.source_id) AS canonical_git FROM persistence_source_bindings s
    JOIN persistence_worktrees w ON w.id=s.worktree_id
    LEFT JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=$2::uuid
    WHERE s.source_id=$1`;

/** The source's writer binding with host `hostId`'s paths (null host columns for a null or unbound host); null when the source has none. */
export async function getWorktreeBinding(exec: LegacyUnscopedRead, sourceId: string, hostId: string | null): Promise<WorktreeBinding | null> {
  const [row] = await exec.executeRaw<WorktreeBinding>(WORKTREE_BINDING_SQL, [sourceId, hostId]);
  return row ?? null;
}

/** One worktree host `hostId` binds, with its owner, epoch, state and topology generation: what the topology lock checks a new root against. */
export interface HostTopologyRow {
  worktree_id: string; owner_host_id: string | null; owner_epoch: string | number; state: WorktreeBinding['state'];
  topology_generation: string | number; local_path: string; coordination_path: string;
}

/** Every worktree host `hostId` binds, with its owner, epoch, state and topology generation (persistence/topology-locks.ts), in no set order. */
export function listHostTopologyRows(exec: LegacyUnscopedRead, hostId: string): Promise<HostTopologyRow[]> {
  return exec.executeRaw<HostTopologyRow>(`SELECT w.id AS worktree_id,w.owner_host_id,w.owner_epoch,w.state,w.topology_generation,
        h.local_path,h.coordination_path FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id WHERE h.host_id=$1::uuid`, [hostId]);
}

/** One git effect gbrain is about to commit: its relative path, its source's local path and its worktree's path on the host. */
export interface PendingGitEffectPath { rel: string; source_path: string | null; worktree_path: string | null }

/** The queued and running git effects that name a relative path, at most 10,000, in no set order (doctor foreign_writers; the statement it sent through `executeRaw`). */
export function listPendingGitEffectPaths(exec: LegacyUnscopedRead, hostId: string | null): Promise<PendingGitEffectPath[]> {
  return exec.executeRaw<PendingGitEffectPath>(
      `SELECT e.data->>'relative_path' AS rel, s.local_path AS source_path, h.local_path AS worktree_path
         FROM persistence_effects e LEFT JOIN sources s ON s.id=e.source_id
         LEFT JOIN persistence_host_bindings h ON h.worktree_id=e.worktree_id AND h.host_id=$1::uuid
        WHERE e.kind='git' AND e.state IN ('queued','running') AND e.data ? 'relative_path' LIMIT 10000`, [hostId]);
}

/**
 * Every host binding of `hostId` with a local path, each with the source a worktree binding names on it (null when
 * none), by byte local path (doctor foreign_writers' repository list; the statement it sent through `executeRaw`).
 */
export function listHostRepositoryRoots(exec: LegacyUnscopedRead, hostId: string): Promise<Array<{ local_path: string; source_id: string | null }>> {
  return exec.executeRaw<{ local_path: string; source_id: string | null }>(
        `SELECT h.local_path, s.source_id FROM persistence_host_bindings h LEFT JOIN persistence_source_bindings s ON s.worktree_id=h.worktree_id
          WHERE h.host_id=$1::uuid AND h.local_path IS NOT NULL ORDER BY h.local_path COLLATE "C"`, [hostId]);
}

/** The source bindings of one worktree, by byte source id. */
export function listWorktreeMembers(exec: LegacyUnscopedRead, worktreeId: string): Promise<Array<{ source_id: string; relative_path: string }>> {
  return exec.executeRaw<{ source_id: string; relative_path: string }>(
    'SELECT source_id,relative_path FROM persistence_source_bindings WHERE worktree_id=$1::uuid ORDER BY source_id COLLATE "C"', [worktreeId]);
}

/** Whether the page has an extracted chronicle generation with events. */
export async function hasExtractedEvents(exec: LegacyUnscopedRead, sourceId: string, pageId: number): Promise<boolean> {
  const rows = await exec.executeRaw(
    "SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND state='extracted' AND cardinality(event_hashes) > 0 LIMIT 1",
    [sourceId, pageId]);
  return rows.length > 0;
}

/** The ids of the access members that are neither disabled nor tombstoned, by id. */
export async function listActiveAccessMembers(exec: LegacyUnscopedRead): Promise<string[]> {
  const rows = await exec.executeRaw<{ id: string }>('SELECT id FROM access_members WHERE disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id COLLATE "C"');
  return rows.map(row => row.id);
}

/**
 * Whether any access member carries the labelled-only grant, disabled and removed members included (the one cheap test
 * a write runs before resolving its writer, access/labelled-only.ts anyLabelledOnlyMember). A failed read is thrown;
 * the caller counts it as yes.
 */
export async function hasLabelledOnlyMember(exec: LegacyUnscopedRead): Promise<boolean> {
  return (await exec.executeRaw('SELECT 1 FROM access_members WHERE labelled_only LIMIT 1')).length > 0;
}

/**
 * Whether one of `memberIds` carries the labelled-only grant and is not the configured owner (`access.owner_member`):
 * the read a remote read or write runs to decide its caller is labelled-only (access/labelled-only.ts labelledOnlyFor).
 * A disabled or removed member counts, as the statement reads every row. A failed read is thrown; the caller decides.
 */
export async function hasLabelledOnlyMemberAmong(exec: LegacyUnscopedRead, memberIds: readonly string[]): Promise<boolean> {
  return (await exec.executeRaw(`SELECT 1 FROM access_members WHERE labelled_only AND id = ANY($1::text[])
      AND id IS DISTINCT FROM (SELECT btrim(value) FROM config WHERE key = $2) LIMIT 1`, [[...memberIds], OWNER_MEMBER_KEY])).length > 0;
}

/** `attachSourcePath` options: a non-null `name` replaces the name; a non-null `federated` sets `config.federated`. */
export interface AttachSourcePathOptions { name?: string | null; federated?: boolean | null }

/**
 * Attaches a working tree to an existing source (#3903, `sources add` on a path-less row): sets `local_path`, applies a
 * passed name and federated flag, and keeps every other column, config key and page. An unknown id changes nothing.
 * The federated flag merges through jsonb_build_object on a bound boolean, never a stringified ::jsonb value.
 */
export async function attachSourcePath(exec: SqlExecutor, sourceId: string, localPath: string, opts: AttachSourcePathOptions = {}): Promise<void> {
  await exec.executeRaw(
    `UPDATE sources
        SET local_path = $2,
            name = COALESCE($3, name),
            config = CASE WHEN $4::boolean IS NULL THEN config
                          ELSE COALESCE(config, '{}'::jsonb)
                               || jsonb_build_object('federated', $4::boolean) END
      WHERE id = $1`,
    [sourceId, localPath, opts.name ?? null, opts.federated ?? null],
  );
}

/** Expires every awaiting memory proposal past its expiry with `reason`; returns how many. */
export async function expireMemoryProposals(exec: SqlExecutor, reason: string): Promise<number> {
  const rows = await exec.executeRaw(`UPDATE memory_proposals SET state='expired', reason=$1, decided_by='gbrain:expiry', decided_at=now(), updated_at=now()
      WHERE state='awaiting_owner' AND expires_at<=now() RETURNING 1`, [reason]);
  return rows.length;
}

/** The oldest `limit` memory proposals still awaiting their owner, as stored rows. */
export function listAwaitingMemoryProposals(exec: LegacyUnscopedRead, limit: number): Promise<Array<Record<string, unknown>>> {
  return exec.executeRaw<Record<string, unknown>>(`SELECT * FROM memory_proposals WHERE state='awaiting_owner'
    ORDER BY created_at LIMIT $1`, [limit]);
}

/** The memory proposal a principal holds under `requestId` (a uuid), as its stored row, or null. */
export async function readMemoryProposal(exec: LegacyUnscopedRead, principalKind: string, principalId: string, requestId: string): Promise<Record<string, unknown> | null> {
  const [row] = await exec.executeRaw<Record<string, unknown>>(
    'SELECT * FROM memory_proposals WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid', [principalKind, principalId, requestId]);
  return row ?? null;
}

/** The pending-proposal count and the oldest pending proposal's age in hours (null with none), as Postgres returns them. */
export interface PendingProposalRow { n: number | string; oldest: number | string | null }

/** How many memory proposals still await their owner unexpired, and how old the oldest is (status and doctor). */
export async function readPendingProposalSummary(exec: LegacyUnscopedRead): Promise<PendingProposalRow | null> {
  const [row] = await exec.executeRaw<PendingProposalRow>(`SELECT count(*) AS n,
      EXTRACT(EPOCH FROM now() - min(created_at)) / 3600 AS oldest FROM memory_proposals WHERE state='awaiting_owner' AND expires_at>now()`);
  return row ?? null;
}

/** One page of the owner's proposal list: `afterAt`/`afterId` are the previous page's last creation time and request id. */
export interface ProposalListQuery { sourceId: string | null; all: boolean; limit: number; afterAt: string | null; afterId: string | null }

/** The owner's proposal list, oldest first (creation time to the millisecond, then request id), as stored rows. */
export function listMemoryProposalRows(exec: LegacyUnscopedRead, q: ProposalListQuery): Promise<Array<Record<string, unknown>>> {
  return exec.executeRaw<Record<string, unknown>>(`SELECT * FROM memory_proposals WHERE ($1::text IS NULL OR source_id=$1)
    AND ($2::boolean OR state='awaiting_owner')
    AND ($4::timestamptz IS NULL OR (date_trunc('milliseconds', created_at), request_id) > ($4::timestamptz, $5::uuid))
    ORDER BY date_trunc('milliseconds', created_at), request_id LIMIT $3`,
    [q.sourceId, q.all, q.limit, q.afterAt, q.afterId]);
}

/** The proposals of any credential that carry this request id (at most two, so a uuidv5 collision is seen, never guessed). */
export function listOwnerProposalRows(exec: LegacyUnscopedRead, requestId: string): Promise<Array<Record<string, unknown>>> {
  return exec.executeRaw<Record<string, unknown>>('SELECT * FROM memory_proposals WHERE request_id=$1::uuid LIMIT 2', [requestId]);
}

/** Deletes every closed memory proposal decided (or last updated) at least `retentionDays` days ago; returns how many. */
export async function purgeMemoryProposals(exec: SqlExecutor, retentionDays: number): Promise<number> {
  const rows = await exec.executeRaw(`DELETE FROM memory_proposals WHERE state<>'awaiting_owner'
    AND COALESCE(decided_at, updated_at) <= now() - ($1::integer * interval '1 day') RETURNING 1`, [retentionDays]);
  return rows.length;
}
