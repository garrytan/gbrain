/** Optional fence append ceiling (#capture-policy). Call only while holding the page's writer guard. */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { writeFactsAbsorbLog } from './absorb-log.ts';
const warned = new Set<string>();
export async function readPageCap(engine: BrainEngine): Promise<{ warn: number; max: number }> {
  const parse = (raw: string | null, key: string) => {
    if (raw === null || raw.trim() === '') return 0;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) throw opError('invalid_params', `${key} must be a nonnegative integer (0 disables it).`, `Set ${key} to a nonnegative integer and retry.`);
    return n;
  };
  const warn = parse(await engine.getConfig('facts.page_cap.warn_rows'), 'facts.page_cap.warn_rows');
  const max = parse(await engine.getConfig('facts.page_cap.max_rows'), 'facts.page_cap.max_rows');
  if (warn && max && max < warn) throw opError('invalid_params', 'facts.page_cap.max_rows must be at least facts.page_cap.warn_rows.', 'Increase max_rows, reduce warn_rows, or set either threshold to 0 to disable it.');
  return { warn, max };
}
export function pageCapError(slug: string) {
  return opError('invalid_params', `Facts fence cap reached for ${slug}. Archive existing rows or increase facts.page_cap.max_rows; nothing was written.`, `Archive fence rows on ${slug} or increase facts.page_cap.max_rows, then retry.`);
}
export async function checkPageCap(engine: BrainEngine, sourceId: string, slug: string, rows: number, appends = 1): Promise<boolean> {
  const cap = await readPageCap(engine);
  const key = `${sourceId}:${slug}`;
  if (cap.warn && rows >= cap.warn && !warned.has(key)) {
    warned.add(key);
    console.warn(`[facts] ${slug} has ${rows} fence rows (facts.page_cap.warn_rows=${cap.warn}). Archive rows or adjust facts.page_cap.max_rows.`);
    await writeFactsAbsorbLog(engine, slug, 'page_cap', `warn_rows=${cap.warn} rows=${rows}`, sourceId);
  }
  if (cap.max && rows + appends > cap.max) {
    await writeFactsAbsorbLog(engine, slug, 'page_cap', `capped=1 rows=${rows}; archive ${slug} or increase facts.page_cap.max_rows`, sourceId);
    return false;
  }
  return true;
}
