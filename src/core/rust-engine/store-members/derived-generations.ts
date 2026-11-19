/**
 * The generation ledger statements (engine-sql/derived-generations.ts) on a Rust brain: the store's `derived_generations`
 * family (rust/crates/gbrain-store/src/generations.rs) holds the rows and items. Each member is one store write or read,
 * so a member that throws writes nothing; inside `transaction` its writes commit or roll back with the transaction.
 *
 * The store keeps no `derived_generation_attempts` rows (`recordAttempt` still sends raw SQL, which this engine
 * refuses), so an activation has no attempt counter to delete.
 */
import type {
  GenerationActivationRow, GenerationLedgerRow, GenerationRowKey, HeldGenerationRow, LiveGenerationRow,
} from '../../engine-sql/derived-generations.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The live generation of `key` with its owned items, or null. */
export const readLiveGenerationRow: StoreMember<[key: GenerationRowKey], LiveGenerationRow | null> = async (brain, key) =>
  storeCall({ member: 'readLiveGenerationRow', sourceId: key.sourceId }, () => brain.readLiveGenerationRow(key));

/** Supersedes `liveId`, activates `row` with `items` and deletes the key's held row; resolves the new id. */
export const activateGenerationRows: StoreMember<[key: GenerationRowKey, liveId: number | null, row: GenerationActivationRow,
  items: readonly GenerationLedgerRow[]], number> = async (brain, key, liveId, row, items) =>
  storeCall({ member: 'activateGenerationRows', sourceId: key.sourceId }, () => brain.activateGenerationRows(key, liveId, row, [...items]));

/** Records `row` as the key's held row: the same hold counts one more attempt, another hold replaces it. */
export const recordHeldGenerationRow: StoreMember<[key: GenerationRowKey, row: HeldGenerationRow], void> = async (brain, key, row) => {
  await storeCall({ member: 'recordHeldGenerationRow', sourceId: key.sourceId }, () => brain.recordHeldGenerationRow(key, row));
};
