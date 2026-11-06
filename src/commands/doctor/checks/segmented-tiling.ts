import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { untiledSegmentedPages } from '../../../core/page-body/body-tiling.ts';

const name = 'segmented_tiling';
const DOCS = 'docs/guides/repair.md#segmented-tiling';
const SAMPLE = 20;

/**
 * GST-1209: live pages stored in segments whose live generation's rows do not cover their body (`untiledSegmentedPages`),
 * so every read of them refuses `page_body_rows_unreadable` and a managed sync holds their file. Read-only: one aggregate
 * per page over its live manifest rows. The fix is the repair's preview, which writes nothing; republishing a page from
 * its file at HEAD needs the user's agreement and the preview hash.
 */
export async function segmentedTilingCheck(engine: BrainEngine, sourceIds?: readonly string[]): Promise<Check> {
  try {
    const found = await untiledSegmentedPages(engine, { sourceIds, limit: SAMPLE + 1 });
    if (!found.length) return { name, status: 'ok', message: 'Every live page stored in segments has segment rows that cover its whole body.' };
    const pages = found.slice(0, SAMPLE).map(({ source_id, slug, body_generation, body_bytes, rows, covered_bytes }) => ({ source_id, slug, body_generation, body_bytes, rows, covered_bytes }));
    const sources = [...new Set(pages.map(page => page.source_id))].sort();
    const listed = pages.map(page => `${page.source_id}:${page.slug} (generation ${page.body_generation}: ${page.rows} row(s) covering ${page.covered_bytes ?? 'with a gap'}${page.covered_bytes === null ? '' : ' bytes'} of ${page.body_bytes})`);
    return { name, status: 'fail', details: { pages, truncated: found.length > SAMPLE, sources, docs: DOCS },
      message: `${found.length > SAMPLE ? `More than ${SAMPLE}` : found.length} live page(s) stored in segments have segment rows that do not cover their body, so every read of them refuses `
        + `(page_body_rows_unreadable) and a sync holds their file: ${listed.join('; ')}. Preview the repair; it republishes each page from its file at HEAD only when applied with the user's agreement.`,
      fix: agentFix(['gbrain', 'repair', 'segmented-tiling', '--source', sources[0]!],
        'Previews republishing each listed page of that source from its file at HEAD and writes nothing; applying it needs the user\'s agreement and the printed preview hash.'
          + (sources.length > 1 ? ` The listed pages also span ${sources.slice(1).map(source => `gbrain repair segmented-tiling --source ${source}`).join(', ')}${found.length > SAMPLE ? ` (from the first ${SAMPLE} pages; run the check again after each repair)` : ''}.` : ''),
        name, { docs: DOCS }) };
  } catch (error) {
    return checkError(name, 'read the segment rows of pages stored in segments', error);
  }
}
