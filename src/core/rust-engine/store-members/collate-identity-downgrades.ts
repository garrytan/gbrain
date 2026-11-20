/**
 * The identity-downgrade record reads and the checkpoint value rows (BrainEngine readSoftDeletedPageAtOrigin,
 * listLivePagesAtOrigin, countPageCarryRows, writeOpCheckpointValues, readOpCheckpointValues; SQL in
 * engine-sql/collate-identity-downgrades.ts), served from the page, fact, link and alias records and the checkpoint
 * parent row (rust/crates/gbrain-store/src/identity_downgrades.rs and op_checkpoint_values.rs). What each member
 * answers: rust/docs/store/collate-identity-downgrades.md.
 */
import type { LivePageAtOriginRow, PageCarryCounts, SoftDeletedPageRow } from '../../engine-sql/collate-identity-downgrades.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readSoftDeletedPageAtOrigin: StoreMember<[sourceId: string, path: string, slug: string], SoftDeletedPageRow | null> = async (brain, sourceId, path, slug) =>
  await storeCall({ member: 'readSoftDeletedPageAtOrigin', sourceId }, () => brain.readSoftDeletedPageAtOrigin(sourceId, path, slug)) as SoftDeletedPageRow | null;

export const listLivePagesAtOrigin: StoreMember<[sourceId: string, sourcePath: string], LivePageAtOriginRow[]> = async (brain, sourceId, sourcePath) =>
  await storeCall({ member: 'listLivePagesAtOrigin', sourceId }, () => brain.listLivePagesAtOrigin(sourceId, sourcePath)) as LivePageAtOriginRow[];

export const countPageCarryRows: StoreMember<[sourceId: string, slug: string, pageId: number], PageCarryCounts> = async (brain, sourceId, slug, pageId) =>
  await storeCall({ member: 'countPageCarryRows', sourceId }, () => brain.countPageCarryRows(sourceId, slug, pageId)) as PageCarryCounts;

export const writeOpCheckpointValues: StoreMember<[op: string, fingerprint: string, values: readonly unknown[]], void> = async (brain, op, fingerprint, values) => {
  await storeCall({ member: 'writeOpCheckpointValues' }, () => brain.writeOpCheckpointValues(op, fingerprint, [...values]));
};

export const readOpCheckpointValues: StoreMember<[op: string, fingerprint: string], unknown[] | null> = async (brain, op, fingerprint) =>
  await storeCall({ member: 'readOpCheckpointValues' }, () => brain.readOpCheckpointValues(op, fingerprint)) as unknown[] | null;
