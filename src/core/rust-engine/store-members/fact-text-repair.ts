/**
 * The fact reads and writes of `gbrain repair redacted-facts` and of the `gbrain repair conversation-labels` retirement
 * (src/core/engine-sql/fact-text-repair.ts), served from rust/crates/gbrain-store/src/facts/text_repair.rs. None applies
 * a read policy, so none takes one. See rust/docs/store/facts.md.
 *
 * lockFactRows makes no store call: a store write transaction holds the whole store until it ends, so the rows the
 * SQL locks with `FOR UPDATE` are already held by the caller's transaction.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Helpers stay unexported.
 */
import type { BrainEngine } from '../../engine.ts';
import { assertStoreSerializedTransactions, refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function wholeIds(member: string, ids: readonly number[] | null): void {
  for (const id of ids ?? []) if (!Number.isSafeInteger(id)) refuseMember(member, 'a fact id that is not an integer');
}

export const listRedactedFactCandidates: Member<'listRedactedFactCandidates'> = async (brain, sourceIds, ids) => {
  wholeIds('listRedactedFactCandidates', ids);
  const rows: Awaited<ReturnType<BrainEngine['listRedactedFactCandidates']>> = await storeCall({ member: 'listRedactedFactCandidates' },
    () => brain.listRedactedFactCandidates({ sourceIds: [...sourceIds], ids: ids === null ? null : [...ids] }));
  return rows.map(row => ({ ...row, id: Number(row.id), row_num: row.row_num == null ? null : Number(row.row_num) }));
};

export const restoreRedactedFactTexts: Member<'restoreRedactedFactTexts'> = async (brain, sourceId, restores, marker) => {
  wholeIds('restoreRedactedFactTexts', restores.map(r => r.id));
  const ids: number[] = await storeCall({ member: 'restoreRedactedFactTexts' }, () => brain.restoreRedactedFactTexts({ sourceId,
    restores: restores.map(r => ({ id: r.id, from_text: r.from_text, to_text: r.to_text, visibility: r.visibility, entity_slug: r.entity_slug,
      source_markdown_slug: r.source_markdown_slug, row_num: r.row_num })), marker }));
  return ids.map(Number);
};

export const listProjectedFenceRows: Member<'listProjectedFenceRows'> = async (brain, sourceId, slug, rowNums, texts) => {
  wholeIds('listProjectedFenceRows', rowNums);
  const rows: number[] = await storeCall({ member: 'listProjectedFenceRows', slug, sourceId },
    () => brain.listProjectedFenceRows({ sourceId, slug, rowNums: [...rowNums], texts: [...texts] }));
  return rows.map(Number);
};

export const listUnexpiredFactIds: Member<'listUnexpiredFactIds'> = async (brain, ids) => {
  wholeIds('listUnexpiredFactIds', ids);
  const rows: number[] = await storeCall({ member: 'listUnexpiredFactIds' }, () => brain.listUnexpiredFactIds({ ids: [...ids] }));
  return rows.map(Number);
};

export const lockFactRows: Member<'lockFactRows'> = async (brain, _sourceId, ids) => {
  // The FOR UPDATE is skipped while explicit transactions hold the writer (`serialized_transactions`).
  assertStoreSerializedTransactions(brain, 'lockFactRows');
  wholeIds('lockFactRows', ids);
};

export const expireFactWithNote: Member<'expireFactWithNote'> = async (brain, sourceId, id, note) => {
  wholeIds('expireFactWithNote', [id]);
  return storeCall({ member: 'expireFactWithNote', sourceId }, () => brain.expireFactWithNote({ sourceId, id, note }));
};

export const expirePageFactsBySource: Member<'expirePageFactsBySource'> = async (brain, sourceId, slug, sources) => {
  const n: number = await storeCall({ member: 'expirePageFactsBySource', slug, sourceId }, () => brain.expirePageFactsBySource({ sourceId, slug, sources: [...sources] }));
  return Number(n);
};

export const readMaxFactRowNum: Member<'readMaxFactRowNum'> = async (brain, sourceId, slug) => {
  const n: number | null = await storeCall({ member: 'readMaxFactRowNum', slug, sourceId }, () => brain.readMaxFactRowNum({ sourceId, slug }));
  return n == null ? null : Number(n);
};
