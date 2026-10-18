/**
 * timeline_history doctor check (#5567): timeline rows that exist only in the
 * database, with no bullet in their page. Materializable rows warn and name
 * `gbrain repair timeline`; rows that cannot round-trip through the page are
 * kept by every writer and reported as informational.
 *
 * Bounded: pages carrying non-event timeline rows are classified in id order
 * up to PAGE_CAP pages or TIME_BUDGET_MS per run. A run that stops early keeps
 * its cursor in the config row `doctor.timeline_history.scan:<scope>` (#5821),
 * so successive doctor runs cover the whole scope. The ids of pages earlier
 * runs of the pass found are kept and recounted on every run, so a repair
 * between runs is seen and a pass that ends reports current counts. While a later pass is in progress, a clean
 * finished pass is trusted until a newer timeline row is written. A truncated
 * run with neither is a lower bound and is never reported as clean.
 *
 * Segmented pages (Wave B) are not classified: `gbrain repair timeline` cannot
 * re-publish them, so their database-side rows are counted separately
 * (`segmented_pages`, `segmented_rows`), named, reported as kept, and never
 * drive the warning or the repair recommendation.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { recountTimelinePages, scanTimelineHistory, segmentedTimelineNote, segmentedTimelinePages } from '../../../core/repair/timeline.ts';

const PAGE_CAP = 2_000;
const TIME_BUDGET_MS = 10_000;
const STATE_KEY = 'doctor.timeline_history.scan';
const FOUND_CAP = 10_000;

interface PassTotals { materializable: number; unrenderable: number; affected: number; inspected: number; runs: number }
interface ScanState extends PassTotals {
  cursor: number;
  /** Pages earlier runs of this pass found with rows to report (capped). */
  found?: number[];
  /** Highest timeline row id when the pass started; rows above it may be unscanned. */
  started_max_entry: number;
  last?: PassTotals & { max_entry: number; completed_at: string };
}

const emptyTotals = (): PassTotals => ({ materializable: 0, unrenderable: 0, affected: 0, inspected: 0, runs: 0 });

async function loadState(engine: BrainEngine, key: string): Promise<ScanState | null> {
  try {
    const raw = await engine.getConfig(key);
    const state = raw ? JSON.parse(raw) as ScanState : null;
    return state && Number.isSafeInteger(state.cursor) ? state : null;
  } catch { return null; }
}

async function saveState(engine: BrainEngine, key: string, state: ScanState): Promise<void> {
  // Engine graduation runs doctor as a read-only gate (source at plan/run start, target under the fence): no scan-state write.
  if (process.env.GBRAIN_GRADUATION_RUN) return;
  try { await engine.setConfig(key, JSON.stringify(state)); } catch { /* best effort: the next run rescans from the start */ }
}

export async function timelineHistoryCheck(engine: BrainEngine, sourceId?: string, opts: { pageCap?: number } = {}): Promise<Check> {
  const name = 'timeline_history';
  try {
    const sources = sourceId ? [sourceId] : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE')).map(r => r.id);
    const key = `${STATE_KEY}:${[...sources].sort().join(',')}`;
    const [{ max_entry }] = await engine.executeRaw<{ max_entry: number | string }>('SELECT COALESCE(max(id), 0) AS max_entry FROM timeline_entries');
    const maxEntry = Number(max_entry);
    const prior = await loadState(engine, key);
    const state: ScanState = prior ?? { ...emptyTotals(), cursor: 0, started_max_entry: maxEntry };
    const scan = await scanTimelineHistory(engine, sources, state.cursor, { pages: opts.pageCap ?? PAGE_CAP, deadline: Date.now() + TIME_BUDGET_MS });
    const counted = [...await recountTimelinePages(engine, sources, state.found ?? []), ...scan.pages]
      .filter(p => p.materializable || p.unrenderable);
    const pass: PassTotals = {
      materializable: counted.reduce((n, p) => n + p.materializable, 0),
      unrenderable: counted.reduce((n, p) => n + p.unrenderable, 0),
      affected: counted.filter(p => p.materializable).length,
      inspected: state.inspected + scan.inspected,
      runs: state.runs + 1,
    };
    const multiRun = pass.runs > 1;
    const segmented = await segmentedTimelinePages(engine, sources);
    const segmentedDetails = segmented.pages ? { segmented_pages: segmented.pages, segmented_rows: segmented.rows, segmented_sample: segmented.sample } : {};
    const segmentedNote = segmented.pages ? ` Also: ${segmentedTimelineNote(segmented)}` : '';

    if (!scan.truncated) {
      if (prior) {
        await saveState(engine, key, { ...emptyTotals(), cursor: 0, started_max_entry: maxEntry,
          last: { ...pass, max_entry: state.started_max_entry, completed_at: new Date().toISOString() } });
      }
      const details = { materializable_rows: pass.materializable, kept_unrenderable_rows: pass.unrenderable, pages_affected: pass.affected,
        pages_inspected: pass.inspected, count: 'exact', truncated: false, repair: 'timeline', ...(multiRun ? { pass_runs: pass.runs } : {}), ...segmentedDetails };
      const across = multiRun ? ` (full pass across ${pass.runs} doctor runs)` : '';
      if (pass.materializable > 0) {
        return { name, status: 'warn', details, message: `${pass.materializable} timeline row(s) on ${pass.affected} page(s) exist only in the database${across}. `
          + `Preview: gbrain repair timeline — apply: gbrain repair timeline --apply` + (pass.unrenderable ? `. ${pass.unrenderable} other row(s) cannot round-trip and are kept as-is.` : '') + segmentedNote };
      }
      return { name, status: 'ok', details, message: (pass.unrenderable
        ? `No materializable database-only timeline rows${across}; ${pass.unrenderable} row(s) cannot round-trip through their page and are kept as-is (informational).`
        : segmented.pages ? `No materializable database-only timeline rows on inline pages (${pass.inspected} page(s) inspected${multiRun ? ` across ${pass.runs} doctor runs` : ''}).`
          : `Every timeline row has a bullet in its page (${pass.inspected} page(s) inspected${multiRun ? ` across ${pass.runs} doctor runs` : ''}).`) + segmentedNote };
    }

    await saveState(engine, key, { ...state, ...pass, cursor: scan.cursor, found: counted.map(p => p.id).slice(0, FOUND_CAP) });
    const details = { materializable_rows: pass.materializable, kept_unrenderable_rows: pass.unrenderable, pages_affected: pass.affected,
      pages_inspected: pass.inspected, count: 'lower_bound', truncated: true, repair: 'timeline', pass_runs: pass.runs, resumes_after_page_id: scan.cursor, ...segmentedDetails };
    const coverage = ` (this pass has inspected ${pass.inspected} page(s) over ${pass.runs} run(s) and resumes on the next doctor run; counts are a lower bound)`;
    if (pass.materializable > 0) {
      return { name, status: 'warn', details, message: `at least ${pass.materializable} timeline row(s) on ${pass.affected} page(s) exist only in the database${coverage}. `
        + `Preview: gbrain repair timeline — apply: gbrain repair timeline --apply` + (pass.unrenderable ? `. ${pass.unrenderable} other row(s) cannot round-trip and are kept as-is.` : '') + segmentedNote };
    }
    const last = state.last;
    if (last && last.materializable === 0 && maxEntry <= last.max_entry) {
      return { name, status: 'ok', details: { ...details, last_full_pass: { pages_inspected: last.inspected, runs: last.runs, completed_at: last.completed_at } },
        message: `No materializable database-only timeline rows: the last full pass (${last.inspected} page(s), completed ${last.completed_at}) found none and no timeline row has been written since; the next pass is in progress.${segmentedNote}` };
    }
    return { name, status: 'warn', details, message: `Timeline history scan incomplete${coverage}; run \`gbrain repair timeline\` for the full count now.${segmentedNote}` };
  } catch (e) {
    return { name, status: 'warn', message: `timeline history check skipped: ${e instanceof Error ? e.message : String(e)}`,
      details: { count: 'lower_bound', truncated: true, health: 'unknown' } };
  }
}
