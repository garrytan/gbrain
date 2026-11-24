/**
 * The secret store and the page-store reads and writes of `gbrain repair secret-spans` on the Rust store
 * (engine-sql/secret-store.ts, engine-sql/secret-spans-rows.ts;
 * rust/crates/gbrain-store/src/secret_store.rs and repair_secret_spans.rs; rust/docs/store/secret-store.md). Each member
 * is one store call, so the engine's transaction holds a repair's writes together. The crypto stays in TypeScript
 * (secret-store/keyring.ts): the store keeps the ciphertext and MACs it is given.
 *
 * Differences from the SQL engines: a raw data row has no serial id here, so it is named by its position among the
 * page's rows (`readPageRedactionRows` numbers them from 1); the store has no view digests to delete; and the SQL
 * engines' `created_at` text is rendered the way PostgreSQL prints `timestamptz::text`.
 */
import type {
  PageRedactionRow, PageRedactionRows, RedactedPageFields, RedactedRowStore, RetainedVersionBody, TimelineDedupRow,
} from '../../engine-sql/secret-spans-rows.ts';
import type {
  RestorePageHit, SecretAllowedMac, SecretBackupEntryRow, SecretBackupOccurrenceRow, SecretEntryConflict, SecretEntryInsert, SecretEntryRow,
  SecretEntrySummaryRow, SecretHoldingPageRow, SecretKeyInUse, SecretOccurrenceInsert, SecretOccurrenceRow,
} from '../../engine-sql/secret-store.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const wholeNumber = (member: string, name: string, value: number): number => {
  if (!Number.isInteger(value)) refuseMember(member, `${name} is not an integer`);
  return value;
};

export const findSecretEntryByMac: StoreMember<[sourceId: string, mac: string], string | null> = (brain, sourceId, mac) =>
  storeCall({ member: 'findSecretEntryByMac', sourceId }, () => brain.findSecretEntryByMac(sourceId, mac)) as Promise<string | null>;

export const secretEntryExists: StoreMember<[id: string], boolean> = (brain, id) =>
  storeCall({ member: 'secretEntryExists' }, () => brain.secretEntryExists(id)) as Promise<boolean>;

export const insertSecretEntry: StoreMember<[row: SecretEntryInsert, conflict: SecretEntryConflict], string | null> = (brain, row, conflict) =>
  storeCall({ member: 'insertSecretEntry', sourceId: row.sourceId }, () => brain.insertSecretEntry({ ...row }, conflict)) as Promise<string | null>;

export const insertSecretOccurrence: StoreMember<[o: SecretOccurrenceInsert], void> = async (brain, o) => {
  if (o.pageId !== null) wholeNumber('insertSecretOccurrence', 'pageId', o.pageId);
  await storeCall({ member: 'insertSecretOccurrence', sourceId: o.sourceId }, () => brain.insertSecretOccurrence({ ...o }));
};

export const readSecretEntry: StoreMember<[id: string], SecretEntryRow | null> = (brain, id) =>
  storeCall({ member: 'readSecretEntry' }, () => brain.readSecretEntry(id)) as Promise<SecretEntryRow | null>;

export const listSecretOccurrences: StoreMember<[entryId: string], SecretOccurrenceRow[]> = (brain, entryId) =>
  storeCall({ member: 'listSecretOccurrences' }, () => brain.listSecretOccurrences(entryId)) as Promise<SecretOccurrenceRow[]>;

export const listSecretEntrySummaries: StoreMember<[filter: { sourceId: string | null; slug: string | null; limit: number }], SecretEntrySummaryRow[]> = (brain, filter) =>
  storeCall({ member: 'listSecretEntrySummaries' }, () => brain.listSecretEntrySummaries({ ...filter })) as Promise<SecretEntrySummaryRow[]>;

export const countSecretsByRule: StoreMember<[sourceId: string | null], Array<{ rule: string; entries: number; occurrences: number }>> = (brain, sourceId) =>
  storeCall({ member: 'countSecretsByRule' }, () => brain.countSecretsByRule(sourceId)) as Promise<Array<{ rule: string; entries: number; occurrences: number }>>;

export const listAllowedSecretMacs: StoreMember<[sourceId: string | null], SecretAllowedMac[]> = (brain, sourceId) =>
  storeCall({ member: 'listAllowedSecretMacs' }, () => brain.listAllowedSecretMacs(sourceId)) as Promise<SecretAllowedMac[]>;

export const listSecretKeysInUse: StoreMember<[], SecretKeyInUse[]> = brain =>
  storeCall({ member: 'listSecretKeysInUse' }, () => brain.listSecretKeysInUse()) as Promise<SecretKeyInUse[]>;

export const readSecretStoreSnapshot: StoreMember<[], { entries: SecretBackupEntryRow[]; occurrences: SecretBackupOccurrenceRow[] }> = brain =>
  storeCall({ member: 'readSecretStoreSnapshot' }, () => brain.readSecretStoreSnapshot()) as Promise<{ entries: SecretBackupEntryRow[]; occurrences: SecretBackupOccurrenceRow[] }>;

export const insertBackupSecretEntry: StoreMember<[row: SecretBackupEntryRow], boolean> = (brain, row) =>
  storeCall({ member: 'insertBackupSecretEntry', sourceId: row.source_id }, () => brain.insertBackupSecretEntry({ ...row })) as Promise<boolean>;

export const readBackupEntryHold: StoreMember<[id: string, sourceId: string, mac: string], boolean | null> = (brain, id, sourceId, mac) =>
  storeCall({ member: 'readBackupEntryHold', sourceId }, () => brain.readBackupEntryHold(id, sourceId, mac)) as Promise<boolean | null>;

export const insertBackupSecretOccurrence: StoreMember<[o: SecretBackupOccurrenceRow, pageId: number | null], boolean> = async (brain, o, pageId) => {
  if (pageId !== null) wholeNumber('insertBackupSecretOccurrence', 'pageId', pageId);
  return await storeCall({ member: 'insertBackupSecretOccurrence', sourceId: o.source_id }, () => brain.insertBackupSecretOccurrence({ ...o }, pageId)) as boolean;
};

export const deleteUnreferencedSecretEntry: StoreMember<[id: string], boolean> = (brain, id) =>
  storeCall({ member: 'deleteUnreferencedSecretEntry' }, () => brain.deleteUnreferencedSecretEntry(id)) as Promise<boolean>;

export const listSecretHoldingPages: StoreMember<[sourceId: string, slugs: readonly string[], id: string], SecretHoldingPageRow[]> = async (brain, sourceId, slugs, id) =>
  (await storeCall({ member: 'listSecretHoldingPages', sourceId }, () => brain.listSecretHoldingPages(sourceId, [...slugs], id)) as SecretHoldingPageRow[])
    .map(row => ({ ...row, id: Number(row.id) }));

export const countUnreferencedSecretEntries: StoreMember<[], number> = async brain =>
  Number(await storeCall({ member: 'countUnreferencedSecretEntries' }, () => brain.countUnreferencedSecretEntries()));

export const readRestorePageHit: StoreMember<[sourceId: string, slug: string, marker: string], RestorePageHit | null> = (brain, sourceId, slug, marker) =>
  storeCall({ member: 'readRestorePageHit', sourceId, slug }, () => brain.readRestorePageHit(sourceId, slug, marker)) as Promise<RestorePageHit | null>;

export const markSecretEntryAllowed: StoreMember<[id: string], void> = async (brain, id) => {
  await storeCall({ member: 'markSecretEntryAllowed' }, () => brain.markSecretEntryAllowed(id));
};

export const readPageRedactionRow: StoreMember<[sourceId: string, slug: string], PageRedactionRow | null> = async (brain, sourceId, slug) => {
  const row = await storeCall({ member: 'readPageRedactionRow', sourceId, slug }, () => brain.readPageRedactionRow(sourceId, slug)) as PageRedactionRow | null;
  return row === null ? null : { ...row, id: Number(row.id) };
};

export const readPageRedactionRows: StoreMember<[pageId: number, sourceId: string, slug: string], PageRedactionRows> = (brain, pageId, sourceId, slug) =>
  storeCall({ member: 'readPageRedactionRows', sourceId, slug }, () => brain.readPageRedactionRows(wholeNumber('readPageRedactionRows', 'pageId', pageId), sourceId, slug)) as Promise<PageRedactionRows>;

export const listTimelineDedupRows: StoreMember<[pageId: number], TimelineDedupRow[]> = (brain, pageId) =>
  storeCall({ member: 'listTimelineDedupRows' }, () => brain.listTimelineDedupRows(wholeNumber('listTimelineDedupRows', 'pageId', pageId))) as Promise<TimelineDedupRow[]>;

export const listVersionBodiesForRedaction: StoreMember<[pageId: number], RetainedVersionBody[]> = (brain, pageId) =>
  storeCall({ member: 'listVersionBodiesForRedaction' }, () => brain.listVersionBodiesForRedaction(wholeNumber('listVersionBodiesForRedaction', 'pageId', pageId))) as Promise<RetainedVersionBody[]>;

export const countPageVersionRows: StoreMember<[pageId: number], number> = async (brain, pageId) =>
  Number(await storeCall({ member: 'countPageVersionRows' }, () => brain.countPageVersionRows(wholeNumber('countPageVersionRows', 'pageId', pageId))));

export const setRetainedVersionBody: StoreMember<[pageId: number, id: number, compiledTruth: string | null, frontmatter: unknown], void> = async (brain, pageId, id, compiledTruth, frontmatter) => {
  await storeCall({ member: 'setRetainedVersionBody' }, () => brain.setRetainedVersionBody(wholeNumber('setRetainedVersionBody', 'pageId', pageId),
    wholeNumber('setRetainedVersionBody', 'id', id), compiledTruth, frontmatter ?? {}));
};

export const listChunkTextsForRedaction: StoreMember<[pageId: number, purpose: 'rewrite' | 'scan'], Array<{ id?: number; chunk_text: string; doc_comment: string | null }>> = (brain, pageId) =>
  storeCall({ member: 'listChunkTextsForRedaction' }, () => brain.listChunkTextsForRedaction(wholeNumber('listChunkTextsForRedaction', 'pageId', pageId))) as Promise<Array<{ id?: number; chunk_text: string; doc_comment: string | null }>>;

export const deleteChunksByIds: StoreMember<[pageId: number, ids: readonly number[]], void> = async (brain, pageId, ids) => {
  await storeCall({ member: 'deleteChunksByIds' }, () => brain.deleteChunksByIds(wholeNumber('deleteChunksByIds', 'pageId', pageId), ids.map(id => wholeNumber('deleteChunksByIds', 'id', id))));
};

export const setRedactedPageFields: StoreMember<[pageId: number, fields: RedactedPageFields], void> = async (brain, pageId, fields) => {
  await storeCall({ member: 'setRedactedPageFields' }, () => brain.setRedactedPageFields(wholeNumber('setRedactedPageFields', 'pageId', pageId), { ...fields }));
};

export const readRawDataValue: StoreMember<[pageId: number, id: number], unknown> = (brain, pageId, id) =>
  storeCall({ member: 'readRawDataValue' }, () => brain.readRawDataValue(wholeNumber('readRawDataValue', 'pageId', pageId), wholeNumber('readRawDataValue', 'id', id)));

export const setRawDataValue: StoreMember<[pageId: number, id: number, data: unknown], void> = async (brain, pageId, id, data) => {
  await storeCall({ member: 'setRawDataValue' }, () => brain.setRawDataValue(wholeNumber('setRawDataValue', 'pageId', pageId), wholeNumber('setRawDataValue', 'id', id), data));
};

export const setRedactedRowText: StoreMember<[pageId: number, store: RedactedRowStore, id: number, column: string, text: string], void> = async (brain, pageId, store, id, column, text) => {
  await storeCall({ member: 'setRedactedRowText' }, () => brain.setRedactedRowText(wholeNumber('setRedactedRowText', 'pageId', pageId), store,
    wholeNumber('setRedactedRowText', 'id', id), column, text));
};

/**
 * `deletePageViewDigests(pageIds)` (a fact purge's segment cleanup; `repair secret-spans` clears a page's digests with
 * every rewrite): the store keeps no cached read-view digests, so there is nothing to delete, as on a SQL brain whose
 * pages have none.
 */
export const deletePageViewDigests: StoreMember<[pageIds: number[]], void> = async () => undefined;
