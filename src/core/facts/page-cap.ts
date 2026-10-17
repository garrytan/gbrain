/** Optional fence append ceiling (capture-policy). Checks never write or log. */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { writeFactsAbsorbLog } from './absorb-log.ts';

export interface PageCap { warn: number; max: number }
export function validPageCapValue(raw: string): boolean {
  return /^\d+$/.test(raw.trim()) && Number.isSafeInteger(Number(raw));
}
export async function readPageCap(engine: Pick<BrainEngine, 'getConfig'>): Promise<PageCap> {
  const parse = (raw: string | null, key: string) => {
    if (raw === null || raw.trim() === '') return 0;
    if (!validPageCapValue(raw)) throw opError('invalid_params', `${key} must be a nonnegative integer (0 disables it).`,
      `Set ${key} to a nonnegative integer and retry.`);
    return Number(raw);
  };
  const warn = parse(await engine.getConfig('facts.page_cap.warn_rows'), 'facts.page_cap.warn_rows');
  const max = parse(await engine.getConfig('facts.page_cap.max_rows'), 'facts.page_cap.max_rows');
  if (warn && max && max < warn) throw opError('invalid_params', 'facts.page_cap.max_rows must be at least facts.page_cap.warn_rows.',
    'Increase max_rows, reduce warn_rows, or set either threshold to 0 to disable it.');
  return { warn, max };
}
export function pageCapError(slug: string) {
  return opError('facts_page_cap', `Facts fence cap reached for ${slug}. Archive existing rows or increase facts.page_cap.max_rows; nothing was written.`,
    `Archive fence rows on ${slug} or increase facts.page_cap.max_rows, then retry.`, { detail: slug });
}
export function checkPageCap(cap: PageCap, rows: number, appends = 1): { warn: boolean; refuse: boolean } {
  return { warn: cap.warn > 0 && rows >= cap.warn, refuse: cap.max > 0 && rows + appends > cap.max };
}
/** Call after publication only; failed transactions must not consume warnings. */
export async function reportPageCap(engine: BrainEngine, sourceId: string, slug: string, cap: PageCap, rows: number, capped = 0, inserted = 0) {
  if (!(cap.warn > 0 && rows < cap.warn && rows + inserted >= cap.warn) && !capped) return;
  await writeFactsAbsorbLog(engine, slug, 'page_cap', `warn_rows=${cap.warn} rows=${rows} capped=${capped}`, sourceId);
}

/** Keep replacements and admit appends in input order, counting only refused appends. */
export function admitFenceAppends<T extends { replacesExisting?: boolean }>(facts: T[], cap: PageCap, rows: number) {
  let slots = cap.max ? Math.max(0, cap.max - rows) : Infinity;
  let capped = 0;
  const admitted = facts.filter(fact => {
    if (fact.replacesExisting) return true;
    if (slots > 0) { slots--; return true; }
    capped++; return false;
  });
  return { admitted, capped };
}
