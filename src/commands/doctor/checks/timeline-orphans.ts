/**
 * timeline_orphans doctor check (#4649, #5170): timeline rows an earlier
 * version of a page produced that its current text no longer does.
 *
 * Extraction was insert-only before v0.59.11 (and `extract --stale` / the
 * full-walk extract until this check shipped), so a corrected or deleted dated
 * bullet left its old row behind. Extraction now retracts them page by page;
 * rows orphaned earlier stay until the page is re-extracted or the one-time
 * prune runs. Read-only and sampled; the write is the explicit
 * `gbrain extract timeline --prune-orphans` command.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { pruneTimelineOrphans } from '../../../core/timeline-extract.ts';

const SAMPLE_PAGES = 500;

export async function timelineOrphansCheck(engine: BrainEngine): Promise<Check> {
  try {
    const res = await pruneTimelineOrphans(engine, { dryRun: true, limit: SAMPLE_PAGES });
    const coverage = res.pagesScanned >= SAMPLE_PAGES ? ` (sampled the first ${SAMPLE_PAGES} pages with timeline rows)` : '';
    if (res.orphans === 0) {
      return { name: 'timeline_orphans', status: 'ok', message: `No orphaned timeline rows across ${res.pagesScanned} page(s)${coverage}.` };
    }
    const eg = res.examples.map(e => `${e.source_id}:${e.slug} ${e.date} "${e.summary.slice(0, 60)}"`).join('; ');
    return {
      name: 'timeline_orphans',
      status: 'warn',
      message: `${res.orphans} timeline row(s) came from an earlier version of their page and are no longer in its text${coverage}. ` +
        `Preview with: gbrain extract timeline --prune-orphans --dry-run, then remove with: gbrain extract timeline --prune-orphans. e.g. ${eg}`,
    };
  } catch (e) {
    return { name: 'timeline_orphans', status: 'warn', message: `timeline orphan scan skipped: ${e instanceof Error ? e.message : String(e)}` };
  }
}
