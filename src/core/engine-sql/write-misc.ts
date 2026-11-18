/**
 * The statements a page write ran through `executeRaw` that belong to no other storage domain
 * (docs/research/rust-put-write-path.md): the source-state reads of admission, publication and effect recovery, the
 * shared-skillpack screen, the chronicle retire check, the access-member
 * read of `brainServes` and memory-proposal upkeep. Each function keeps the statement text its call site ran, so PGLite
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

/** Every shared skillpack bound to its source's current incarnation, with its roots on host `hostId`. */
export function listSharedSkillPackRoots(exec: LegacyUnscopedRead, hostId: string): Promise<SharedSkillPackRoot[]> {
  return exec.executeRaw<SharedSkillPackRoot>(`SELECT p.source_id,p.source_incarnation,s.local_path AS source_root,
      h.local_path AS worktree_root,b.relative_path FROM shared_skill_packs p
      JOIN sources s ON s.id=p.source_id AND s.incarnation=p.source_incarnation
      LEFT JOIN persistence_source_bindings b ON b.source_id=p.source_id AND b.source_incarnation=p.source_incarnation
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid`, [hostId]);
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
