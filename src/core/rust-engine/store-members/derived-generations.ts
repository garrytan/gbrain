/**
 * The generation ledger statements (engine-sql/derived-generations.ts) on a Rust brain: the store's `derived_generations`
 * family (rust/crates/gbrain-store/src/generations.rs) holds the rows and items. Each member is one store write or read,
 * so a member that throws writes nothing; inside `transaction` its writes commit or roll back with the transaction.
 * The attempt counters (`derived_generation_attempts`) and the retirement valve (`derived_generation_valve`) live in
 * the same family.
 */
import type {
  GenerationActivationRow, GenerationAttemptCount, GenerationLedgerRow, GenerationRowKey, GenerationValveRow, HeldGenerationRow,
  HeldInputRow, LiveGenerationRow,
} from '../../engine-sql/derived-generations.ts';
import type { LedgerScrubCounts } from '../../engine-sql/generation-ledger.ts';
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

/** The held rows of `key` for the input pinned `pin`. */
export const heldGenerationRowsForInput: StoreMember<[key: GenerationRowKey, pin: string], HeldInputRow[]> = async (brain, key, pin) =>
  storeCall({ member: 'heldGenerationRowsForInput', sourceId: key.sourceId }, () => brain.heldGenerationRowsForInput(key, pin));

/** The context of the held row `holdId` of `key`, or null. */
export const readHeldGenerationContext: StoreMember<[key: GenerationRowKey, holdId: string], { held_context: Record<string, unknown> | null } | null> =
  async (brain, key, holdId) =>
    storeCall({ member: 'readHeldGenerationContext', sourceId: key.sourceId }, () => brain.readHeldGenerationContext(key, holdId));

/** The generation number the identical operation made live, or null. */
export const liveGenerationForOperation: StoreMember<[operationId: string], number | null> = async (brain, operationId) =>
  storeCall({ member: 'liveGenerationForOperation' }, () => brain.liveGenerationForOperation(operationId));

/** Counts one terminal failure of the hold `holdId` with `code`; resolves the count and the codes. */
export const countGenerationAttempt: StoreMember<[key: GenerationRowKey, holdId: string, code: string], GenerationAttemptCount> =
  async (brain, key, holdId, code) =>
    storeCall({ member: 'countGenerationAttempt', sourceId: key.sourceId }, () => brain.countGenerationAttempt(key, holdId, code));

/** Deletes the attempt counter of the hold `holdId`. */
export const clearGenerationAttempts: StoreMember<[holdId: string], void> = async (brain, holdId) => {
  await storeCall({ member: 'clearGenerationAttempts' }, () => brain.clearGenerationAttempts(holdId));
};

/** The valve window `windowKey` of the key's source and kind. */
export const readGenerationValve: StoreMember<[key: GenerationRowKey, windowKey: string], GenerationValveRow> = async (brain, key, windowKey) =>
  storeCall({ member: 'readGenerationValve', sourceId: key.sourceId }, () => brain.readGenerationValve(key, windowKey));

/** Adds `retired` retirements to the valve window `windowKey`. */
export const bumpGenerationValve: StoreMember<[key: GenerationRowKey, windowKey: string, retired: number], void> = async (brain, key, windowKey, retired) => {
  await storeCall({ member: 'bumpGenerationValve', sourceId: key.sourceId }, () => brain.bumpGenerationValve(key, windowKey, retired));
};

/** The page purge scrub of `slug` (held fence rows of `fenceKinds`, preimages, proposals and fence blocks). */
export const scrubGenerationPageRows: StoreMember<[sourceId: string, fenceKinds: readonly string[], slug: string], LedgerScrubCounts> =
  async (brain, sourceId, fenceKinds, slug) =>
    storeCall({ member: 'scrubGenerationPageRows', sourceId }, () => brain.scrubGenerationPageRows(sourceId, [...fenceKinds], slug));

/** The fact purge scrub: every preimage, held proposal, held context and fence block that carries a lowercase needle. */
export const scrubGenerationTextRows: StoreMember<[sourceId: string, needles: readonly string[]], LedgerScrubCounts> = async (brain, sourceId, needles) =>
  storeCall({ member: 'scrubGenerationTextRows', sourceId }, () => brain.scrubGenerationTextRows(sourceId, [...needles]));
