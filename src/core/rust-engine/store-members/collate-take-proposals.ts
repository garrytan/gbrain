/**
 * The failure tombstones of take_proposals (BrainEngine recordFailureTombstone, listFailureTombstones; SQL in
 * engine-sql/collate-take-proposals.ts), served from the store (rust/crates/gbrain-store/src/take_proposals.rs).
 * What each member answers: rust/docs/store/collate-take-proposals.md.
 */
import type { FailureTombstoneInput, FailureTombstoneRow } from '../../engine-sql/collate-take-proposals.ts';
import { storeCall, type StoreMember } from './common.ts';

export const recordFailureTombstone: StoreMember<[input: FailureTombstoneInput], boolean> = async (brain, input) =>
  await storeCall({ member: 'recordFailureTombstone', sourceId: input.sourceId }, () => brain.recordFailureTombstone(input)) as boolean;

export const listFailureTombstones: StoreMember<[sourceId: string, claimPrefix: string], FailureTombstoneRow[]> = async (brain, sourceId, claimPrefix) =>
  await storeCall({ member: 'listFailureTombstones', sourceId }, () => brain.listFailureTombstones(sourceId, claimPrefix)) as FailureTombstoneRow[];
