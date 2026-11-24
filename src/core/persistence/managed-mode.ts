/**
 * #6482: the one managed-mode reader. The schema seeds exactly one `persistence_brain` row with a boolean
 * `enabled` (`schema.ts`), so a read that returns anything else is an impossible state, not a mode: every
 * reader refuses `storage_error` instead of treating the brain as unmanaged. A leaf module so that
 * `filesystem-guard.ts` and the other modules `ownership.ts` imports can use it without a cycle;
 * `ownership.ts` re-exports it.
 */
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { SqlEngine } from './model.ts';
import { MANAGED_MODE_SQL, MANAGED_MODE_ROWS_JSON_SQL } from '../engine-sql/persistence-state.ts';
import type { RawSqlEngine } from './model.ts';
import type { BrainEngine } from '../engine.ts';

// The statements live with the engine's typed persistence-state reads (`engine-sql/persistence-state.ts`); every plain reader sends them unchanged.
export { MANAGED_MODE_SQL, MANAGED_MODE_ROWS_JSON_SQL };
/** The columns the metadata-bearing mode readers need; the later-migration columns through `to_jsonb` so an older row still answers. */
const PERSISTENCE_BRAIN_SQL = `SELECT brain_id,enabled,to_jsonb(persistence_brain)->>'mode_epoch' AS mode_epoch,
  (to_jsonb(persistence_brain)->>'skill_bundles_enabled')::boolean AS skill_bundles_enabled,
  (to_jsonb(persistence_brain)->>'writer_protocol_floor')::int AS writer_protocol_floor FROM persistence_brain WHERE singleton=1`;
export interface ManagedModeReadOptions {
  /** `share` / `update` append `FOR SHARE` / `FOR UPDATE`: callers that serialize on the singleton keep their lock. */
  lock?: 'share' | 'update';
  signal?: AbortSignal;
  /** Names the caller in the refusal (`<subject> requires exactly one known boolean persistence state.`) and what it did not do. */
  refusal?: ManagedModeRefusalContext;
}
export interface ManagedModeRefusalContext { subject?: string; consequence?: string }
export interface PersistenceBrainRow { brain_id: string; enabled: boolean; mode_epoch: string | null; skill_bundles_enabled: boolean | null; writer_protocol_floor: number | null }
/**
 * The persistence state the schema seeds (`schema.ts`: one row, `enabled` boolean NOT NULL). Anything else is an
 * impossible read, not a mode: refusing is the only answer that cannot route a managed brain through the
 * unmanaged writer (#6482). Shared by every mode reader; the message and fix are `automaticSyncPull`'s.
 */
export function unknownManagedModeRefusal(rows: ReadonlyArray<unknown>, context: ManagedModeRefusalContext = {}): OperationError {
  const shape = rows.length === 0 ? 'missing' : rows.length > 1 ? 'duplicated' : 'not a boolean';
  return opError('storage_error', `${context.subject ?? 'This operation'} requires exactly one known boolean persistence state.`,
    'Run the read-only probe in fix on the brain host and fix the persistence state it reports, then run the same command again; nothing was written.', {
      why: `The persistence_brain singleton is ${shape} (${rows.length} row(s)), so gbrain cannot tell whether this brain is managed; `
        + `${context.consequence ?? 'it refuses rather than route a managed brain through the unmanaged writer'}.`,
      detail: 'persistence_mode_unknown',
      fix: { ...readFix('Shows the brain\'s persistence mode and each source\'s writer binding without changing anything.',
        { argv: ['gbrain', 'sources', 'writer', 'status', '--probe', '--json'] }), verify: { argv: ['gbrain', 'doctor', '--json'] } },
    });
}
/** `enabled` of the one well-formed row, or the refusal above. Only a literal `false` selects unmanaged behaviour. */
export function managedModeFromRows<T extends { enabled: unknown }>(rows: ReadonlyArray<T | null | undefined>, context?: ManagedModeRefusalContext): T & { enabled: boolean } {
  const [row] = rows;
  if (rows.length !== 1 || !row || typeof row.enabled !== 'boolean') throw unknownManagedModeRefusal(rows, context);
  return row as T & { enabled: boolean };
}
/** True for a Rust brain, which has no SQL dialect (its persistence rows come from typed members). */
function isRustBrain(engine: RawSqlEngine): boolean {
  return (engine as { kind?: unknown }).kind === 'rust';
}
/**
 * A Rust brain's singleton from the brain row of its writer admin state: its own brain id, its stored mode and epoch,
 * protocol floor 1 and skill bundles off. With no brain id the row is missing, so the strict readers refuse as they do
 * on a SQL brain.
 */
async function rustPersistenceBrainRows(engine: RawSqlEngine): Promise<PersistenceBrainRow[]> {
  const state = JSON.parse(await (engine as unknown as Pick<BrainEngine, 'readWriterAdminState'>).readWriterAdminState()) as {
    brain: { id: string; enabled: boolean; mode_epoch: number | string; skill_bundles_enabled: boolean; writer_protocol_floor: number } | null;
  };
  const brain = state.brain;
  return brain ? [{ brain_id: brain.id, enabled: brain.enabled, mode_epoch: String(brain.mode_epoch),
    skill_bundles_enabled: brain.skill_bundles_enabled, writer_protocol_floor: brain.writer_protocol_floor }] : [];
}
/** Whether the brain is managed: `true` or `false` from a well-formed singleton, `storage_error` otherwise; a query error propagates. */
export async function readManagedMode(engine: RawSqlEngine, opts: ManagedModeReadOptions = {}): Promise<boolean> {
  // A Rust brain has no SQL dialect: it answers through the typed member. Its store runs one writer at a time, so
  // the row lock a SQL engine takes here has nothing to wait for. SQL engines keep the statement below.
  if (isRustBrain(engine)) {
    return managedModeFromRows(await (engine as unknown as Pick<BrainEngine, 'readManagedModeRows'>).readManagedModeRows(), opts.refusal).enabled;
  }
  const sql = opts.lock ? `${MANAGED_MODE_SQL} FOR ${opts.lock.toUpperCase()}` : MANAGED_MODE_SQL;
  const rows = await engine.executeRaw<{ enabled: unknown }>(sql, undefined, opts.signal ? { signal: opts.signal } : undefined);
  return managedModeFromRows(rows, opts.refusal).enabled;
}
/** `readManagedMode` with no lock and no signal, through the typed `readManagedModeRows` member (every engine serves it). */
export async function readManagedModeTyped(engine: Pick<BrainEngine, 'readManagedModeRows'>, refusal?: ManagedModeRefusalContext): Promise<boolean> {
  return managedModeFromRows(await engine.readManagedModeRows(), refusal).enabled;
}
/**
 * Read-only inspection for the diagnostics that *report* the persistence state (`writer status`, the fix the refusal
 * names; doctor): the well-formed row, or null with the reason the strict readers refuse. Never used to route a write.
 */
export async function inspectPersistenceBrain(engine: SqlEngine): Promise<{ row: PersistenceBrainRow | null; problem: string | null }> {
  const rows = await engine.executeRaw<Omit<PersistenceBrainRow, 'enabled'> & { enabled: unknown }>(PERSISTENCE_BRAIN_SQL);
  try { return { row: managedModeFromRows(rows), problem: null }; }
  catch (error) { return { row: null, problem: (error as { why?: string }).why ?? String(error) }; }
}
/** The singleton with its identity and epoch, under the same contract as `readManagedMode`. */
export async function readPersistenceBrain(engine: RawSqlEngine, opts: ManagedModeReadOptions = {}): Promise<PersistenceBrainRow> {
  // As in readManagedMode: the Rust store runs one writer at a time, so the lock has nothing to wait for.
  if (isRustBrain(engine)) return managedModeFromRows(await rustPersistenceBrainRows(engine), opts.refusal);
  const sql = opts.lock ? `${PERSISTENCE_BRAIN_SQL} FOR ${opts.lock.toUpperCase()}` : PERSISTENCE_BRAIN_SQL;
  const rows = await engine.executeRaw<Omit<PersistenceBrainRow, 'enabled'> & { enabled: unknown }>(sql, undefined, opts.signal ? { signal: opts.signal } : undefined);
  return managedModeFromRows(rows, opts.refusal);
}
