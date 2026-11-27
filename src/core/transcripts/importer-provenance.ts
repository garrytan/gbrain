/**
 * Which pages `gbrain transcripts ingest` wrote, read from the page's content author (persistence/content-author-schema.ts):
 * its own module so readers (transcripts accept-fences, doctor) do not load the importer.
 */
import { contentAuthoredBySql } from '../persistence/content-author-schema.ts';

/** The provenance the importer stamps on every part it writes (importFromContent and the coordinated put_page). */
export const IMPORTER_INGESTED_VIA = 'cli:transcripts-ingest';

/**
 * True when the page's live TEXT was written by the importer, for page alias `page`; `via` is the placeholder bound to
 * IMPORTER_INGESTED_VIA. GST-4056: the first-ingest stamp (`ingested_via`) and the revision's attribution are not
 * evidence: every later write keeps the stamp, and tag changes and maintenance move the revision. The content author
 * changes only with the text, and a remote write always names its own operation. Shared with transcripts
 * accept-fences (#9427), which takes no `legacy` page: the rule before GST-4056 accepted one only with
 * `ingested_at >= updated_at`, and the backfill stamps such a page with the importer itself.
 */
export function importerWroteLiveTextSql(page: string, via: string, opts: { legacy?: boolean } = {}): string {
  return contentAuthoredBySql(page, via, opts);
}
