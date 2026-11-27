/**
 * The persistence state members the import and put paths reach (BrainEngine readManagedModeRows, ownsSchemaTables,
 * readLedgerSource, readLocalWriterRow, insertLocalWriterRow): the one brain row's stored mode, the store owning its
 * own tables, the belief ledger's view of a source, and the local writer registration every CLI write checks
 * (persistence/identity.ts registerLocalWriter).
 */
import type { LocalWriterInsert, LocalWriterRow } from '../../engine-sql/persistence-state.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';
import type { LedgerSource } from '../../engine-sql/belief.ts';
import type { RustEngine } from '../../rust-engine.ts';

/** The stored brain mode: `enabled` and `mode_epoch` (text) of the persistence brain row. */
async function readBrainMode(brain: StoreBrain, member: string): Promise<{ enabled: boolean; mode_epoch: string }> {
  return storeCall({ member }, () => brain.writerReleaseRows({ kind: 'brain_mode' }));
}

/** The one singleton row with the stored brain mode (gbrain-store `persistence::worktrees::release`; classic until activated). */
export const readManagedModeRows: StoreMember<[], Array<{ enabled: unknown }>> = async (brain) =>
  [{ enabled: (await readBrainMode(brain, 'readManagedModeRows')).enabled }];

/** The brain's one process opens its store file, so it owns every table and may apply migrations. */
export const ownsSchemaTables: StoreMember<[], boolean> = async () => true;

/** `current_setting('plan_cache_mode')` on a PGLite brain that never set it. */
const PLAN_CACHE_MODE = 'auto';

const PLAN_CACHE_SETTING = 'plan_cache_mode';

/**
 * The belief ledger's view of a source (trust/belief_history.rs): its incarnation, purge epoch and newest coverage
 * event, and whether a fact, take or page purge tombstone or a raised epoch makes a purge possible. A batch also
 * returns the one unmanaged brain row and the plan-cache mode it replaced: inside a transaction with coverage active it
 * sets the transaction's `plan_cache_mode` to `force_generic_plan` (store-members/transactions.ts keeps it), as the SQL
 * batch does with `set_config`. The store has no planner, so the setting changes nothing else.
 */
export const readLedgerSource = async function readLedgerSource(this: RustEngine, brain: StoreBrain, sourceId: string, opts?: { batch?: boolean }): Promise<LedgerSource | null> {
  const row = await storeCall({ member: 'readLedgerSource' }, () => brain.readLedgerSource(sourceId)) as LedgerSource | null;
  if (!row) return null;
  if (!opts?.batch) return row;
  const scope = this._txScope && !this._txScope.ended ? this._txScope : null;
  const planModePrev = scope?.settings.get(PLAN_CACHE_SETTING) ?? PLAN_CACHE_MODE;
  if (scope && row.coverage !== null && row.coverage !== 'coverage.stopped') scope.settings.set(PLAN_CACHE_SETTING, 'force_generic_plan');
  return { ...row, managedRows: [{ enabled: false }], planModePrev };
};

/**
 * The registration row of a local writer, or undefined. `lock` asks PGLite for FOR SHARE so a revocation waits; the
 * store runs one write transaction at a time, so a read never overlaps a revocation and the option changes nothing.
 * `revoked_at` comes back as a Date, as PGLite returns a timestamptz.
 */
export const readLocalWriterRow: StoreMember<[id: string, opts?: { lock?: boolean }], LocalWriterRow | undefined> =
  async (brain, id) => {
    const row = await storeCall({ member: 'readLocalWriterRow' }, () => brain.readLocalWriter(id)) as
      { lane: string; credential_hash: string; grant_ceiling: LocalWriterRow['grant_ceiling']; revoked_at: string | null } | null;
    if (!row) return undefined;
    return { lane: row.lane, credential_hash: row.credential_hash, grant_ceiling: row.grant_ceiling, revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at) };
  };

/** Stores a local writer unless its id or credential hash is registered already; true when this call stored it. */
export const insertLocalWriterRow: StoreMember<[row: LocalWriterInsert], boolean> = (brain, row) =>
  storeCall({ member: 'insertLocalWriterRow' }, () => brain.insertLocalWriterRow({
    id: row.id, lane: row.lane, credentialHash: row.credentialHash, grantCeiling: row.grant,
  }));
