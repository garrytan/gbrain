/**
 * The link-extraction freshness watermark every stale-page selector, counter
 * and publisher uses: the later of the code's `LINK_EXTRACTOR_VERSION_TS` and
 * the time the effective line-grammar behavior last changed
 * (`_internal.link_extraction_generation`, written by `gbrain config` in the
 * same transaction as the setting). A page extracted before the watermark is
 * stale, so turning the grammar on or off re-extracts every page once and the
 * graph converges to what the current settings derive.
 *
 * Strict on purpose: a failed read throws rather than silently using the code
 * watermark, so a page is never stamped fresh against the wrong watermark.
 */
import { LINK_EXTRACTOR_VERSION_TS } from './link-extraction.ts';
import { LINK_EXTRACTION_GENERATION_KEY } from './line-grammar.ts';

/** The later of two ISO-8601 instants, returned as written (a microsecond stamp keeps its precision). */
export function laterInstant(a: string, b: string | null | undefined): string {
  if (!b) return a;
  const tb = Date.parse(b);
  const ta = Date.parse(a);
  if (!Number.isFinite(tb)) return a;
  if (tb !== ta) return tb > ta ? b : a;
  // Same millisecond: compare the sub-millisecond digits as written.
  const micros = (s: string) => Number((/\.(\d+)Z?$/.exec(s)?.[1] ?? '0').padEnd(6, '0').slice(0, 6));
  return micros(b) > micros(a) ? b : a;
}

/** The watermark for a known generation value (null: the grammar settings never changed). */
export function linkExtractorWatermarkFor(generation: string | null | undefined): string {
  return laterInstant(LINK_EXTRACTOR_VERSION_TS, generation);
}

/** Doctor's note for a brain too small to grade: the exact link-extraction backlog, or '' when there is none. */
export async function smallBrainBacklogNote(engine: { getConfig(key: string): Promise<string | null>; countStalePagesForExtraction(o: { versionTs: string }): Promise<number> }): Promise<string> {
  const pending = await engine.countStalePagesForExtraction({ versionTs: await effectiveLinkExtractorWatermark(engine) }).catch(() => 0);
  return pending ? `; ${pending} page(s) pending link extraction (gbrain extract --stale finishes them)` : '';
}

export async function effectiveLinkExtractorWatermark(engine: { getConfig(key: string): Promise<string | null> }): Promise<string> {
  return linkExtractorWatermarkFor(await engine.getConfig(LINK_EXTRACTION_GENERATION_KEY));
}
