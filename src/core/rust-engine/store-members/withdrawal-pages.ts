/**
 * `listSegmentedPages` and `invalidateWithdrawnPages` (src/core/engine-sql/withdrawal-pages.ts), served from the store
 * (rust/crates/gbrain-store/src/facts/withdrawal_pages.rs): the page statements recordFactWithdrawal runs on the pages
 * that carry the withdrawn claim. Rows come back in PGLite's shapes, ids as numbers. The invalidation is one store
 * write; the store serializes writes, so it needs no row lock.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

const numbered = <T extends { id: unknown }>(rows: T[]) => rows.map(row => ({ ...row, id: Number(row.id) }));

export const listSegmentedPages: StoreMember<Parameters<BrainEngine['listSegmentedPages']>, Awaited<ReturnType<BrainEngine['listSegmentedPages']>>> =
  async (brain, sourceId, slugs) =>
    numbered(await storeCall({ member: 'listSegmentedPages' }, () => brain.listSegmentedPages(sourceId, [...slugs])));

export const invalidateWithdrawnPages: StoreMember<Parameters<BrainEngine['invalidateWithdrawnPages']>, Awaited<ReturnType<BrainEngine['invalidateWithdrawnPages']>>> =
  async (brain, sourceId, slugs) =>
    numbered(await storeCall({ member: 'invalidateWithdrawnPages' }, () => brain.invalidateWithdrawnPages(sourceId, [...slugs])));
