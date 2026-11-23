/**
 * The reads a purge's receipt and verification make on the brain's own tables: whether a relation exists
 * (persistence/rebuildable-cache.ts relationExists), the state of a request's derivation sweep (page-body/segment-derive.ts
 * derivationPurgeState) and the claim forms a fact purge's derivation probe and sweep search for (derivationNeedles). Each ran
 * through `executeRaw`; SQL once for both engines, so the Rust store serves the same members
 * (src/core/rust-engine/store-members/purge-receipt.ts and purge-plan.ts).
 *
 * Every function takes the engine (or transaction) it runs on. Static text: `$1` the relation name, the request id or the claims.
 */
import type { BrainEngine } from '../engine.ts';
import { foldSql } from '../page-body/schema.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { DerivationPendingReason, DerivationStallReason, DerivationSweepState } from '../page-body/segment-derive.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The state of a request's derivation sweep, with why it stalled or why a pending one has not ended. */
export interface DerivationPurgeState { state: DerivationSweepState; reason: DerivationStallReason | DerivationPendingReason | null }

/** Whether `table` resolves on the connection's search path, the same resolution the statement that uses it gets. */
export async function relationExists(tx: Raw, table: string): Promise<boolean> {
  const [row] = await tx.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
  return row?.present === true;
}

/** The state of a purge request's derivation sweep, or null once it is verified and its record is gone. Reads page_segment_derivation_purges. */
export async function readDerivationPurgeState(tx: Raw, requestId: string): Promise<DerivationPurgeState | null> {
  const [row] = await tx.executeRaw<{ stalled: boolean; reason: DerivationStallReason | null; pending: DerivationPendingReason | null }>(
    'SELECT stalled_at IS NOT NULL AS stalled, stalled_reason AS reason, pending_reason AS pending FROM page_segment_derivation_purges WHERE request_id=$1::uuid', [requestId]);
  return row ? { state: row.stalled ? 'stalled' : 'pending', reason: row.stalled ? row.reason ?? 'statement_timeout' : row.pending ?? null } : null;
}

/** Which sweep `continueDerivationSweep` continues: `first` is walked first, `retry` is a stalled one to try again, `inline` bounds the call by the lower inline budget. */
export interface DerivationSweepOptions { first?: string; retry?: string; inline?: boolean }
/**
 * The bounds of a sweep (page-body/segment-derive.ts DERIVATION_SWEEP_LIMITS): rows per batch, milliseconds a call starts new batches for
 * (`inlineMs` for the purge's own call), a statement's budget and the wait for the scope lock. The Rust store honors `batchRows`,
 * `totalMs` and `inlineMs`: it has no statement budget and no scope lock to wait on.
 */
export interface DerivationSweepLimits { batchRows: number; totalMs: number; statementMs: number; inlineMs: number; finalizeWaitMs: number }
/** Test seams of the SQL engines' sweep (they run it in process); the Rust engine, which runs it in its store, ignores them. */
export interface DerivationSweepHooks {
  afterBatch?: () => Promise<void>;
  beforeUnreadDelete?: (tx: BrainEngine) => Promise<void>;
  statement?: (entry: { phase: 'sweep' | 'verify' | 'probe'; scanned: number; normalized: number }) => void;
}
/** The rows the sweep's first walk deleted, in all and per page with the rows it read and normalized there. */
export interface DerivationSweepResult { deleted: number; work: Array<{ pageId: number; scanned: number; normalized: number; deleted: number }> }

/** What a fact purge records of its derivation sweep: the purge request, the claim forms (derivationNeedles) and the pages it rewrote. */
export interface DerivationPurgeRecord { requestId: string; sourceId: string; needles: readonly string[]; patterns: readonly string[]; pageIds: readonly number[] }

/** Records a fact purge's derivation sweep, in the purge's transaction; a second record of the same request is a no-op. Writes page_segment_derivation_purges. */
export async function recordDerivationPurgeRow(tx: Raw, row: DerivationPurgeRecord): Promise<void> {
  await tx.executeRaw(`INSERT INTO page_segment_derivation_purges (request_id, source_id, needles, patterns, page_ids)
    VALUES ($1::uuid, $2, $3::text[], $4::text[], $5::int[]) ON CONFLICT (request_id) DO NOTHING`, [row.requestId, row.sourceId, row.needles, row.patterns, [...row.pageIds]]);
}

/**
 * The claims in the form the derivation predicates take: normalized by the database (gbrain_fact_normalize, then foldSql), so a
 * needle and the stored rows it is matched with go through the same SQL. Distinct, in byte order (`COLLATE "C"`, as PGLite and the Rust store sort), and without a claim
 * that normalizes to nothing; no claim, no statement.
 */
export async function listDerivationClaimForms(tx: Raw, claims: readonly string[]): Promise<string[]> {
  const list = [...new Set(claims.filter(Boolean))];
  if (!list.length) return [];
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT f COLLATE "C" AS f FROM (SELECT ${trustedSql(foldSql('gbrain_fact_normalize(c)'))} AS f
    FROM unnest(${list}::text[]) c) x WHERE f <> '' ORDER BY f`);
  const rows = await tx.executeRaw<{ f: string }>(text, params);
  return rows.map(row => row.f);
}
