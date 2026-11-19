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
 * Whether a resident notifier has recorded coverage for any source (a `sync_notifier_sources` row with `observed_at`):
 * one half of whether search carries the freshness notice (notifier/status.ts freshnessReported).
 */
export async function notifierCoverageRecorded(exec: LegacyUnscopedRead): Promise<boolean> {
  const [row] = await exec.executeRaw<{ covered: unknown }>('SELECT EXISTS (SELECT 1 FROM sync_notifier_sources WHERE observed_at IS NOT NULL) AS covered');
  const covered = row?.covered;
  return covered === true || covered === 't' || covered === 1;
}

/** Every shared skillpack bound to its source's current incarnation, with its roots on host `hostId`. */
export function listSharedSkillPackRoots(exec: LegacyUnscopedRead, hostId: string): Promise<SharedSkillPackRoot[]> {
  return exec.executeRaw<SharedSkillPackRoot>(`SELECT p.source_id,p.source_incarnation,s.local_path AS source_root,
      h.local_path AS worktree_root,b.relative_path FROM shared_skill_packs p
      JOIN sources s ON s.id=p.source_id AND s.incarnation=p.source_incarnation
      LEFT JOIN persistence_source_bindings b ON b.source_id=p.source_id AND b.source_incarnation=p.source_incarnation
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid`, [hostId]);
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

/** Whether the page has an extracted chronicle generation with events. */
export async function hasExtractedEvents(exec: LegacyUnscopedRead, sourceId: string, pageId: number): Promise<boolean> {
  const rows = await exec.executeRaw(
    "SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND state='extracted' AND cardinality(event_hashes) > 0 LIMIT 1",
    [sourceId, pageId]);
  return rows.length > 0;
}

/** The ids of the access members that are neither disabled nor tombstoned, by id. */
export async function listActiveAccessMembers(exec: LegacyUnscopedRead): Promise<string[]> {
  const rows = await exec.executeRaw<{ id: string }>('SELECT id FROM access_members WHERE disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id');
  return rows.map(row => row.id);
}

/**
 * One `access_tokens` row as `gbrain auth list` reads it. The statement is `SELECT *` so every schema generation reads
 * (`private_pages`, `private_facts` and `member_id` arrive with their migrations; absent reads as none), so further
 * columns may be present.
 */
export interface AccessTokenRow {
  id: string; name: string; scopes: string[] | null; created_at: Date | string | null; last_used_at: Date | string | null;
  revoked_at: Date | string | null; private_pages?: unknown; private_facts?: unknown; member_id?: string | null;
  [column: string]: unknown;
}

/** Every legacy access token, revoked ones too, newest first. */
export async function listAccessTokens(exec: LegacyUnscopedRead): Promise<AccessTokenRow[]> {
  return exec.executeRaw<AccessTokenRow>('SELECT * FROM access_tokens ORDER BY created_at DESC');
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

/** Deletes every closed memory proposal decided (or last updated) at least `retentionDays` days ago; returns how many. */
export async function purgeMemoryProposals(exec: SqlExecutor, retentionDays: number): Promise<number> {
  const rows = await exec.executeRaw(`DELETE FROM memory_proposals WHERE state<>'awaiting_owner'
    AND COALESCE(decided_at, updated_at) <= now() - ($1::integer * interval '1 day') RETURNING 1`, [retentionDays]);
  return rows.length;
}
