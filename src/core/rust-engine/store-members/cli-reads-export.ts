/**
 * The reads `gbrain export` ran through `executeRaw` (src/commands/export.ts, src/core/export-snapshot.ts and the
 * segmented-body and folder-rule reads it reaches), served by gbrain-store `cli_reads::export`. What the store does
 * not keep (a statement timeout, fact purges, folder rules) and what each member answers for it:
 * rust/docs/store/cli-reads-export.md.
 */
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { mapStoreError } from '../store-errors.ts';
import type { ExportPageKey, ExportPageKeyQuery, ExportPageRow, ExportWithdrawalRow, FactPurgeTombstone, TakePurgeTombstone, NormalizedFenceLines, SegmentedPageHead, BodyManifestRow, BodyManifestMeta, BodyManifestOutline } from '../../engine-sql/export-reads.ts';
import { toGetPage, withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/**
 * `SET LOCAL statement_timeout`: the store has no statement timeout, so this does nothing. Refuses on a transaction
 * that has ended, as the other transaction members do.
 */
export const setLocalStatementTimeout = async function setLocalStatementTimeout(this: RustEngine, _brain: StoreBrain, ms: number): Promise<void> {
  if (this._txScope?.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'setLocalStatementTimeout' });
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`setLocalStatementTimeout: ms must be a non-negative integer, got ${ms}`);
};

/** The next 256 live pages after `q.afterId`, in id order (`cli_reads::export::list_export_page_keys`). */
export const listExportPageKeys: StoreMember<[q: ExportPageKeyQuery], ExportPageKey[]> = (brain, q) =>
  storeCall({ member: 'listExportPageKeys' }, () => brain.listExportPageKeys(q));

/** The withdrawal ledger's size in bytes (`cli_reads::export::read_export_withdrawal_ledger_bytes`). */
export const readExportWithdrawalLedgerBytes: StoreMember<[sourceId: string], number> = (brain, sourceId) =>
  storeCall({ member: 'readExportWithdrawalLedgerBytes', sourceId }, () => brain.readExportWithdrawalLedgerBytes(sourceId));

/**
 * The source's withdrawals and fact purge tombstones (`purged` true) by visibility, fact hash and subject
 * (`cli_reads::export::list_export_withdrawals`). `withdrawn_at` comes back a Date, as on PGLite.
 */
export const listExportWithdrawals: StoreMember<[sourceId: string], ExportWithdrawalRow[]> = async (brain, sourceId) => {
  const rows: ExportWithdrawalRow[] = await storeCall({ member: 'listExportWithdrawals', sourceId }, () => brain.listExportWithdrawals(sourceId));
  return rows.map(row => withDates(row, ['withdrawn_at']));
};

/** The source's fact and take purge tombstones with request id, actor and reason, in byte order (`cli_reads::export::list_purge_tombstones`). */
export const listPurgeTombstones: StoreMember<[sourceId: string], { facts: FactPurgeTombstone[]; takes: TakePurgeTombstone[] }> = async (brain, sourceId) =>
  await storeCall({ member: 'listPurgeTombstones', sourceId }, () => brain.listPurgeTombstones(sourceId)) as { facts: FactPurgeTombstone[]; takes: TakePurgeTombstone[] };

/** The live pages among `ids` with their tags, each page as `getPage` returns it (`cli_reads::export::read_export_page_rows`). */
export const readExportPageRows: StoreMember<[ids: readonly string[]], ExportPageRow[]> = async (brain, ids) => {
  const rows: ExportPageRow[] = await storeCall({ member: 'readExportPageRows' }, () => brain.readExportPageRows([...ids]));
  return rows.map(row => ({ page: toGetPage(row.page), tags: row.tags }));
};

/** Each body and timeline normalized line by line, as Postgres does it (`cli_reads::export::normalize_fence_lines`). */
export const normalizeFenceLines: StoreMember<[bodies: readonly string[], timelines: readonly string[]], NormalizedFenceLines[]> = (brain, bodies, timelines) =>
  storeCall({ member: 'normalizeFenceLines' }, () => brain.normalizeFenceLines([...bodies], [...timelines]));

/** A segmented body read: the page's body columns and revision, deleted or not (`cli_reads::export::read_segmented_page_head`). */
export const readSegmentedPageHead: StoreMember<[pageId: number], SegmentedPageHead | undefined> = async (brain, pageId) =>
  (await storeCall({ member: 'readSegmentedPageHead' }, () => brain.readSegmentedPageHead(pageId))) ?? undefined;

/**
 * A segmented body read: a generation's published manifest rows in seq order (`cli_reads::export::read_body_manifest_rows`).
 * The store sends `sha256` as hex; it comes back bytes, as on PGLite.
 */
export const readBodyManifestRows: StoreMember<[pageId: number, generation: number | null], BodyManifestRow[]> = async (brain, pageId, generation) => {
  const rows: Array<Omit<BodyManifestRow, 'sha256'> & { sha256: string }> =
    await storeCall({ member: 'readBodyManifestRows' }, () => brain.readBodyManifestRows(pageId, generation));
  return rows.map(row => ({ ...row, sha256: new Uint8Array(Buffer.from(row.sha256, 'hex')) }));
};

/** A segmented body read: the entry state and protected regions of the named occurrences in one generation (`cli_reads::export::read_body_manifest_meta`). */
export const readBodyManifestMeta: StoreMember<[pageId: number, occurrenceIds: readonly number[], generation: number], BodyManifestMeta[]> = (brain, pageId, occurrenceIds, generation) =>
  storeCall({ member: 'readBodyManifestMeta' }, () => brain.readBodyManifestMeta(pageId, [...occurrenceIds], generation));

/** The sources with access state, by id (`cli_reads::export::list_access_policy_source_ids`, `access_policy_state`). */
export const listAccessPolicySourceIds: StoreMember<[], string[]> = (brain) =>
  storeCall({ member: 'listAccessPolicySourceIds' }, () => brain.listAccessPolicySourceIds());

/** A segmented outline read: the facts slots and stored outline of the named occurrences in one generation (`cli_reads::export::read_body_manifest_outline`). */
export const readBodyManifestOutline: StoreMember<[pageId: number, occurrenceIds: readonly number[], generation: number], BodyManifestOutline[]> = (brain, pageId, occurrenceIds, generation) =>
  storeCall({ member: 'readBodyManifestOutline' }, () => brain.readBodyManifestOutline(pageId, [...occurrenceIds], generation));

/** A segmented body read: the seqs of one generation's rows that end at a forced cut (`cli_reads::export::list_forced_cut_seqs`). */
export const listForcedCutSeqs: StoreMember<[pageId: number, generation: number], number[]> = (brain, pageId, generation) =>
  storeCall({ member: 'listForcedCutSeqs' }, () => brain.listForcedCutSeqs(pageId, generation));

/** A segmented body read: the seq of the row holding a stored byte (`cli_reads::export::read_manifest_seq_at`). */
export const readManifestSeqAt: StoreMember<[pageId: number, generation: number, byteOffset: number], number | null> = async (brain, pageId, generation, byteOffset) =>
  (await storeCall({ member: 'readManifestSeqAt' }, () => brain.readManifestSeqAt(pageId, generation, byteOffset))) ?? null;

/** A segmented body read: the size the newest segmented version of a generation records (`cli_reads::export::read_segmented_version_body_bytes`). */
export const readSegmentedVersionBodyBytes: StoreMember<[pageId: number, generation: number], number | null> = async (brain, pageId, generation) =>
  (await storeCall({ member: 'readSegmentedVersionBodyBytes' }, () => brain.readSegmentedVersionBodyBytes(pageId, generation))) ?? null;

