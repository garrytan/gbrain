/**
 * The statements of `gbrain repair segmented-mirror` (src/core/repair/segmented-mirror.ts) as typed members:
 * `insertRemirrorEffects` (the re-mirror's `withdrawal-mirror` and `git` effects, admitted in its write transaction),
 * `readRemirrorEffects` (the effect states the apply waits on) and `listGlobalPurgeWithdrawals` (the `*` purges a file's
 * fence rows match, which the withdrawal overlay folds in; the statement page-state/snapshot.ts `resolveGlobalPurges`
 * sends). Both SQL engines delegate here; the Rust store serves the same members
 * (rust/crates/gbrain-store/src/persistence/effects.rs, facts/purge_ledger.rs). The statement texts are unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageWithdrawal } from '../page-state/types.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** $1 request row id, $2 source id, $3 the effects' data: one `withdrawal-mirror` and one `git` row, a kind already queued kept. */
export const REMIRROR_EFFECTS_SQL = `INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
        SELECT $1::uuid,k.kind,$3::text::jsonb,s.id,s.incarnation,b.worktree_id
        FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
        CROSS JOIN (VALUES ('withdrawal-mirror'),('git')) AS k(kind)
        WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`;

/**
 * Queues a re-mirror's `withdrawal-mirror` and `git` effects for request row `requestId`, stamped with the source's
 * incarnation and the worktree of its binding of that incarnation. An unknown source queues nothing.
 */
export async function insertRemirrorEffects(exec: Raw, requestId: string, sourceId: string, data: Record<string, unknown>): Promise<void> {
  await exec.executeRaw(REMIRROR_EFFECTS_SQL, [requestId, sourceId, JSON.stringify(data)]);
}

/** One effect of a re-mirror as the apply waits on it. */
export interface RemirrorEffectState { kind: string; state: string; error_code: string | null; recovering: boolean; parked: boolean; skipped: Array<{ slug?: string; reason?: string }> }

const REMIRROR_EFFECT_STATES_SQL = `SELECT kind,state,error_code,recovery IS NOT NULL AS recovering,data ? 'parked' AS parked,
    COALESCE(data->'skipped','[]'::jsonb) AS skipped FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind COLLATE "C"`;

/** The effects of request row `requestId`, in kind order: state, error code, whether a recovery is open or it parked, and the pages it skipped. */
export async function readRemirrorEffects(exec: Raw, requestId: string): Promise<RemirrorEffectState[]> {
  const rows = await exec.executeRaw<RemirrorEffectState>(REMIRROR_EFFECT_STATES_SQL, [requestId]);
  return rows.map(row => ({ ...row, skipped: typeof row.skipped === 'string' ? JSON.parse(row.skipped) : row.skipped }));
}

const GLOBAL_PURGES_HEAD = `SELECT jsonb_build_object('visibility',visibility,'fact_hash',fact_hash,
      'withdrawn_at',min(purged_at),'purged',true) AS w
    FROM fact_purges WHERE source_id=$1 AND subject='*' AND fact_hash=ANY($2::text[]) `;
const GLOBAL_PURGES_TAIL = `
    GROUP BY visibility,fact_hash ORDER BY visibility COLLATE "C",fact_hash COLLATE "C"`;
/** `resolveGlobalPurges`' statement, every visibility. */
export const GLOBAL_PURGES_SQL = `${GLOBAL_PURGES_HEAD}${GLOBAL_PURGES_TAIL}`;
/** `resolveGlobalPurges`' statement, world rows only. */
export const GLOBAL_WORLD_PURGES_SQL = `${GLOBAL_PURGES_HEAD}AND visibility='world'${GLOBAL_PURGES_TAIL}`;

/**
 * The source's `*` (every subject) purges of the claim fingerprints `hashes` as withdrawals, one per (visibility,
 * fingerprint) with the earliest purge time, in (visibility, fingerprint) order; world rows only when `worldOnly`.
 */
export async function listGlobalPurgeWithdrawals(exec: Raw, sourceId: string, hashes: readonly string[], worldOnly: boolean): Promise<PageWithdrawal[]> {
  const rows = await exec.executeRaw<{ w: PageWithdrawal | string }>(worldOnly ? GLOBAL_WORLD_PURGES_SQL : GLOBAL_PURGES_SQL, [sourceId, [...hashes]]);
  return rows.map(r => typeof r.w === 'string' ? JSON.parse(r.w) as PageWithdrawal : r.w);
}
