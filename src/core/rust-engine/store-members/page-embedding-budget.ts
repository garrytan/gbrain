/**
 * The page embedding ledger the Rust store answers on the paid path (engine-sql/page-embedding-budget.ts): the hold
 * and ledger read (readPageEmbeddingBudget), the hold record (recordPageEmbeddingHold), the approval that opens a hold
 * (openPageEmbeddingHold), the grant (reservePageEmbedding) and the settle (settlePageEmbeddingReservation).
 *
 * The store write is exclusive, so the grant needs no row lock. An unlimited cap (Infinity) crosses the addon as
 * `null`, both ways. A settle amount and the ledger's spent and reserved amounts keep Infinity, -Infinity and NaN, as
 * PGLite's DOUBLE PRECISION does: JSON has none of them, so each crosses the addon as its name (`exact`, `fromExact`).
 *
 * What each member answers and why: rust/docs/store/embeddings.md ("Page embedding ledger").
 */
import type { PageEmbeddingBudgetRow, PageEmbeddingReservation, PageEmbeddingReserveInput } from '../../engine-sql/page-embedding-budget.ts';
import { storeCall, type StoreMember } from './common.ts';

type Settle = { window: string | null; reservedUsd: number; bookedUsd: number; unpricedCalls: number };
const finiteOrNull = (value: number): number | null => Number.isFinite(value) ? value : null;
/** A number the addon carries exactly: a finite one as is, a non-finite one by name. */
const exact = (value: number): number | string => Number.isFinite(value) ? value : String(value);
/** The ledger amount the addon returned: a number, a non-finite one's name, or null. */
const fromExact = (value: unknown): number | null =>
  value === 'Infinity' ? Infinity : value === '-Infinity' ? -Infinity : value === 'NaN' ? NaN : value as number | null;

/** The page's hold marker and ledger row; all null for a missing page. */
export const readPageEmbeddingBudget: StoreMember<[pageId: number], PageEmbeddingBudgetRow> = async (brain, pageId) => {
  const row = await storeCall({ member: 'readPageEmbeddingBudget' }, () => brain.readPageEmbeddingBudget(pageId)) as PageEmbeddingBudgetRow;
  return { ...row, spent_usd: fromExact(row.spent_usd), reserved_usd: fromExact(row.reserved_usd) } as PageEmbeddingBudgetRow;
};

/** Records a hold for a page that has no ledger row yet. */
export const recordPageEmbeddingHold: StoreMember<[pageId: number, reason: string], void> = async (brain, pageId, reason) => {
  await storeCall({ member: 'recordPageEmbeddingHold' }, () => brain.recordPageEmbeddingHold(pageId, reason));
};

/** Opens the page's hold. */
export const openPageEmbeddingHold: StoreMember<[pageId: number], void> = async (brain, pageId) => {
  await storeCall({ member: 'openPageEmbeddingHold' }, () => brain.openPageEmbeddingHold(pageId));
};

/** One grant on the page's ledger row. */
export const reservePageEmbedding: StoreMember<[pageId: number, input: PageEmbeddingReserveInput], PageEmbeddingReservation> = async (brain, pageId, input) => {
  const approvedCap = input.approvedCapUsd ?? 0;
  const out = await storeCall({ member: 'reservePageEmbedding' }, () => brain.reservePageEmbedding(pageId, {
    approved: input.approved,
    approvedCapUsd: finiteOrNull(approvedCap),
    approvedCapInfinite: !Number.isFinite(approvedCap),
    configuredCapUsd: finiteOrNull(input.configuredCapUsd),
    signature: input.signature,
    chunks: input.chunks.map(c => ({ chunkIndex: c.chunkIndex, costUsd: c.costUsd })),
    junk: input.junk,
  })) as PageEmbeddingReservation & { capUsd?: number | null };
  return out.kind === 'grant' ? { ...out, capUsd: out.capUsd ?? Infinity } : out;
};

/** Books a grant's spend inside its reservation window. */
export const settlePageEmbeddingReservation: StoreMember<[pageId: number, settle: Settle], void> = async (brain, pageId, settle) => {
  if (settle.window === null || (settle.reservedUsd === 0 && settle.bookedUsd === 0)) return;
  await storeCall({ member: 'settlePageEmbeddingReservation' }, () => brain.settlePageEmbeddingReservation(pageId, {
    window: settle.window, reservedUsd: exact(settle.reservedUsd), bookedUsd: exact(Math.max(0, settle.bookedUsd)), unpricedCalls: Math.trunc(settle.unpricedCalls),
  }));
};
