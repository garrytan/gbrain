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
import { checkGenerationJsonNumbers, checkHeldGenerationRow } from '../../engine-sql/derived-generations.ts';
import type { LedgerScrubCounts } from '../../engine-sql/generation-ledger.ts';
import {
  checkActivationId, type GenerationActivationRecord, type GenerationActivationState, type GenerationOrphanRow, type PendingGenerationMemberRow,
} from '../../engine-sql/generation-activations.ts';
import {
  checkedRepairFilter, type GenerationRepairFilter, type GenerationRepairItemRow, type HeldGenerationListRow, type HeldGenerationProposalRow, type RestorableGenerationRow,
  type SourceIncarnationListRow, type UnmatchedGenerationRow,
} from '../../engine-sql/generation-repair.ts';
import type { FenceVersionBodyRow } from '../../engine-sql/generation-fence-evidence.ts';
import { checkGenerationPageRowsQuery, type GenerationPageRow, type GenerationPageRowsQuery } from '../../engine-sql/generation-page-rows.ts';
import { checkGenerationVersionProducer, type AtomOriginInputRow, type AtomWriteReceiptRow, type GenerationVersionProducer, type ProducerVersionRow }
  from '../../engine-sql/generation-atom-reads.ts';
import type { GenerationFenceBlockRow, GenerationOwnedItemRow } from '../../engine-sql/generation-fence-restore.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The live generation of `key` with its owned items, or null. */
export const readLiveGenerationRow: StoreMember<[key: GenerationRowKey], LiveGenerationRow | null> = async (brain, key) =>
  storeCall({ member: 'readLiveGenerationRow', sourceId: key.sourceId }, () => brain.readLiveGenerationRow(key));

/** Supersedes `liveId`, activates `row` with `items` and deletes the key's held row; resolves the new id. */
export const activateGenerationRows: StoreMember<[key: GenerationRowKey, liveId: number | null, row: GenerationActivationRow,
  items: readonly GenerationLedgerRow[]], number> = async (brain, key, liveId, row, items) => {
  checkGenerationJsonNumbers('activateGenerationRows', 'completeness', row.completeness);
  return storeCall({ member: 'activateGenerationRows', sourceId: key.sourceId }, () => brain.activateGenerationRows(key, liveId, row, [...items]));
};

/** Records `row` as the key's held row: the same hold counts one more attempt, another hold replaces it. */
export const recordHeldGenerationRow: StoreMember<[key: GenerationRowKey, row: HeldGenerationRow], void> = async (brain, key, row) => {
  checkHeldGenerationRow(row);
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

/** Whether the key's live row is a restore. */
export const readGenerationRestored: StoreMember<[key: GenerationRowKey], boolean> = async (brain, key) =>
  storeCall({ member: 'readGenerationRestored', sourceId: key.sourceId }, () => brain.readGenerationRestored(key));

/** Deletes the `tie` held rows of `kind` in `sourceId` whose owner key starts with `ownerPrefix`. */
export const clearTieHeldGenerationRows: StoreMember<[sourceId: string, kind: string, ownerPrefix: string], void> = async (brain, sourceId, kind, ownerPrefix) => {
  await storeCall({ member: 'clearTieHeldGenerationRows', sourceId }, () => brain.clearTieHeldGenerationRows(sourceId, kind, ownerPrefix));
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

/** Inserts the pending activation row of `key` unless a row with its id exists. `members` crosses as JSON text. Refuses an id that is not a uuid. */
export const recordGenerationActivation: StoreMember<[key: GenerationRowKey, row: GenerationActivationRecord], void> = async (brain, key, row) => {
  checkActivationId(row.activationId);
  const members = JSON.stringify(row.members.map(member => ({ slug: member.slug, action: member.action, identity: member.identity, before: member.before })));
  await storeCall({ member: 'recordGenerationActivation', sourceId: key.sourceId }, () => brain.recordGenerationActivation(key,
    { activationId: row.activationId, expectedGeneration: row.expectedGeneration, inputPin: row.inputPin, setHash: row.setHash, members }));
};

/** Marks the activation `activationId` activated with the generation it made. */
export const markGenerationActivated: StoreMember<[activationId: string, generationId: number], void> = async (brain, activationId, generationId) => {
  await storeCall({ member: 'markGenerationActivated' }, () => brain.markGenerationActivated(activationId, generationId));
};

/** The activation `activationId` of `sourceId` with its generation's state and `slug`'s pending mark, or null. */
export const readGenerationActivationState: StoreMember<[activationId: string, slug: string, sourceId: string], GenerationActivationState | null> =
  async (brain, activationId, slug, sourceId) =>
    storeCall({ member: 'readGenerationActivationState', sourceId }, () => brain.readGenerationActivationState(activationId, slug, sourceId));

/** Clears `slug`'s pending mark on the generation the activation made. */
export const settleGenerationMember: StoreMember<[activationId: string, slug: string], void> = async (brain, activationId, slug) => {
  await storeCall({ member: 'settleGenerationMember' }, () => brain.settleGenerationMember(activationId, slug));
};

/** The pending items of the live generations of `sourceIds` (one kind when given). */
export const listPendingGenerationMembers: StoreMember<[sourceIds: readonly string[], kind: string | null], PendingGenerationMemberRow[]> =
  async (brain, sourceIds, kind) =>
    storeCall({ member: 'listPendingGenerationMembers' }, () => brain.listPendingGenerationMembers([...sourceIds], kind));

/** The orphan candidates of the pending activations of `sourceIds` (one kind when given). */
export const listGenerationOrphanCandidates: StoreMember<[sourceIds: readonly string[], kind: string | null], GenerationOrphanRow[]> =
  async (brain, sourceIds, kind) =>
    storeCall({ member: 'listGenerationOrphanCandidates' }, () => brain.listGenerationOrphanCandidates([...sourceIds], kind));

/** The ledger items of the generations `generationIds`. */
export const readGenerationItemsByIds: StoreMember<[generationIds: readonly number[]], GenerationRepairItemRow[]> = async (brain, generationIds) =>
  storeCall({ member: 'readGenerationItemsByIds' }, () => brain.readGenerationItemsByIds([...generationIds]));

/** The live generations of `kind` whose completeness lists unmatched predecessors, filtered, in id order. */
export const listUnmatchedGenerationRows: StoreMember<[sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter], UnmatchedGenerationRow[]> =
  async (brain, sourceIds, kind, filter) => {
    const checked = checkedRepairFilter(filter);
    return storeCall({ member: 'listUnmatchedGenerationRows' }, () => brain.listUnmatchedGenerationRows([...sourceIds], kind, { ...checked }));
  };

/** The live generations of `kind` with the superseded generation each replaced, filtered, in id order. */
export const listRestorableGenerationRows: StoreMember<[sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter], RestorableGenerationRow[]> =
  async (brain, sourceIds, kind, filter) => {
    const checked = checkedRepairFilter(filter);
    return storeCall({ member: 'listRestorableGenerationRows' }, () => brain.listRestorableGenerationRows([...sourceIds], kind, { ...checked }));
  };

/** The held rows of `kind`, filtered, in id order. */
export const listHeldGenerationRows: StoreMember<[sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter], HeldGenerationListRow[]> =
  async (brain, sourceIds, kind, filter) => {
    const checked = checkedRepairFilter(filter);
    return storeCall({ member: 'listHeldGenerationRows' }, () => brain.listHeldGenerationRows([...sourceIds], kind, { ...checked }));
  };

/** The proposal and hold id of the held row `id`, or null. */
export const readHeldGenerationProposal: StoreMember<[id: number], HeldGenerationProposalRow | null> = async (brain, id) =>
  storeCall({ member: 'readHeldGenerationProposal' }, () => brain.readHeldGenerationProposal(id));

/** The incarnation of each known source of `sourceIds`, in id order: one `readSourceIncarnation` per distinct id. */
export const listGenerationSourceIncarnations: StoreMember<[sourceIds: readonly string[]], SourceIncarnationListRow[]> = async (brain, sourceIds) => {
  const rows: SourceIncarnationListRow[] = [];
  for (const id of [...new Set(sourceIds)].sort()) {
    const row = await storeCall<{ incarnation: string } | null>({ member: 'listGenerationSourceIncarnations', sourceId: id }, () => brain.readSourceIncarnation(id));
    if (row) rows.push({ id, incarnation: row.incarnation });
  }
  return rows;
};

/** The item keys of `itemKeys` that a generation of `key` not held records without retiring them. */
export const listRecordedFenceItemKeys: StoreMember<[key: GenerationRowKey, itemKeys: readonly string[]], Array<{ item_key: string }>> =
  async (brain, key, itemKeys) =>
    storeCall({ member: 'listRecordedFenceItemKeys', sourceId: key.sourceId }, () => brain.listRecordedFenceItemKeys(key, [...itemKeys]));

/** Whether page `slug` of `sourceId` has a stored version without a body. */
export const hasBodylessPageVersion: StoreMember<[sourceId: string, slug: string], boolean> = async (brain, sourceId, slug) =>
  storeCall({ member: 'hasBodylessPageVersion', sourceId }, () => brain.hasBodylessPageVersion(sourceId, slug));

/** Up to `limit` stored versions of the page with a body carrying a facts fence marker, below id `before`, newest first. */
export const listFenceVersionBodies: StoreMember<[sourceId: string, slug: string, before: number | null, limit: number], FenceVersionBodyRow[]> =
  async (brain, sourceId, slug, before, limit) =>
    storeCall({ member: 'listFenceVersionBodies', sourceId }, () => brain.listFenceVersionBodies(sourceId, slug, before, limit));

/** Moves the claimed kept fact rows `ids` to fresh numbers above the page and the claims. */
export const moveKeptFactRows: StoreMember<[sourceId: string, slug: string, ids: readonly number[], claimed: readonly number[]], void> =
  async (brain, sourceId, slug, ids, claimed) => {
    await storeCall({ member: 'moveKeptFactRows', sourceId }, () => brain.moveKeptFactRows(sourceId, slug, [...ids], [...claimed]));
  };

/** The recorded fence block of each generation of `generationIds`, in id order. */
export const readGenerationFenceBlocks: StoreMember<[generationIds: readonly number[]], GenerationFenceBlockRow[]> = async (brain, generationIds) =>
  storeCall({ member: 'readGenerationFenceBlocks' }, () => brain.readGenerationFenceBlocks([...generationIds]));

/** The item keys the generations `generationIds` still own, in id and key order. */
export const listOwnedGenerationItems: StoreMember<[generationIds: readonly number[]], GenerationOwnedItemRow[]> = async (brain, generationIds) =>
  storeCall({ member: 'listOwnedGenerationItems' }, () => brain.listOwnedGenerationItems([...generationIds]));

/** The id of the live generation of `key`, or null. */
export const readLiveGenerationId: StoreMember<[key: GenerationRowKey], { id: number | string } | null> = async (brain, key) =>
  storeCall({ member: 'readLiveGenerationId', sourceId: key.sourceId }, () => brain.readLiveGenerationId(key));

/** The page rows a page generation adapter reads, deleted rows included, by slug (`generations/page_rows.rs`). */
export const readGenerationPageRows: StoreMember<[query: GenerationPageRowsQuery], GenerationPageRow[]> = async (brain, query) => {
  checkGenerationPageRowsQuery(query);
  return storeCall({ member: 'readGenerationPageRows', sourceId: query.sourceId }, () => brain.readGenerationPageRows(query));
};

/** A live page origin's input pin row, or null (`generations/atom_reads.rs`). */
export const readAtomOriginInput: StoreMember<[sourceId: string, slug: string], AtomOriginInputRow | null> = async (brain, sourceId, slug) =>
  storeCall({ member: 'readAtomOriginInput', sourceId }, () => brain.readAtomOriginInput(sourceId, slug));

/** The stored versions `producer` wrote of the pages `slugs`, in no set order. */
export const listProducerVersionRows: StoreMember<[sourceId: string, slugs: readonly string[], producer: GenerationVersionProducer], ProducerVersionRow[]> =
  async (brain, sourceId, slugs, producer) => {
    checkGenerationVersionProducer(producer);
    return storeCall({ member: 'listProducerVersionRows', sourceId }, () => brain.listProducerVersionRows(sourceId, [...slugs], producer));
  };

/** The committed managed atom write receipts with content of the pages `slugs`, in no set order. */
export const listAtomWriteReceipts: StoreMember<[sourceId: string, slugs: readonly string[]], AtomWriteReceiptRow[]> = async (brain, sourceId, slugs) =>
  storeCall({ member: 'listAtomWriteReceipts', sourceId }, () => brain.listAtomWriteReceipts(sourceId, [...slugs]));
