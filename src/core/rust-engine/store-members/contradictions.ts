/**
 * Contradiction-probe members (BrainEngine writeContradictionsRun, loadContradictionsTrend,
 * readLastContradictionsPromptVersion, getContradictionCacheEntry, putContradictionCacheEntry, sweepContradictionCache), and listLinkContexts, the link contexts the edge-contradictions
 * phase quotes to its judge (src/core/engine-sql/contradictions-cycle.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type TrendRow = Awaited<ReturnType<BrainEngine['loadContradictionsTrend']>>[number];

export const writeContradictionsRun: Member<'writeContradictionsRun'> = (brain, row) =>
  storeCall({ member: 'writeContradictionsRun' }, () => brain.writeContradictionsRun(row));

export const loadContradictionsTrend: Member<'loadContradictionsTrend'> = async (brain, days) => {
  const rows: TrendRow[] = await storeCall({ member: 'loadContradictionsTrend' }, () => brain.loadContradictionsTrend(days));
  // PGLite parses ran_at into a Date and prints it with toISOString (millisecond precision).
  return rows.map((row) => ({ ...row, ran_at: new Date(row.ran_at).toISOString() }));
};

export const readLastContradictionsPromptVersion: Member<'readLastContradictionsPromptVersion'> = (brain) =>
  storeCall({ member: 'readLastContradictionsPromptVersion' }, () => brain.readLastContradictionsPromptVersion());

export const getContradictionCacheEntry: Member<'getContradictionCacheEntry'> = (brain, key) =>
  storeCall({ member: 'getContradictionCacheEntry' }, () => brain.getContradictionCacheEntry(key));

export const putContradictionCacheEntry: Member<'putContradictionCacheEntry'> = async (brain, opts) => {
  await storeCall({ member: 'putContradictionCacheEntry' }, () => brain.putContradictionCacheEntry(opts));
};

export const sweepContradictionCache: Member<'sweepContradictionCache'> = (brain) =>
  storeCall({ member: 'sweepContradictionCache' }, () => brain.sweepContradictionCache());

/** Up to three distinct non-empty contexts of one link. The SQL names no order; the store answers them in byte order. */
export const listLinkContexts: Member<'listLinkContexts'> = (brain, fromPageId, toPageId, linkType) =>
  storeCall({ member: 'listLinkContexts' }, () => brain.listLinkContexts(fromPageId, toPageId, linkType));
