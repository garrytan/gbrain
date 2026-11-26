/**
 * Which pages `gbrain transcripts ingest` wrote, read from the live revision's write attribution (storedTranscriptLayout
 * in ingest.ts documents the rule). Its own module so readers (transcripts accept-fences, doctor) do not load the importer.
 */
/** The provenance the importer stamps on every part it writes (importFromContent and the coordinated put_page). */
export const IMPORTER_INGESTED_VIA = 'cli:transcripts-ingest';

/**
 * True when the page's LIVE revision was written by the importer (the rule storedTranscriptLayout in ingest.ts documents), for
 * page alias `page` LEFT JOINed to `persistence_requests` as `request` on its `revision_write_request_id`; `via` is the
 * placeholder bound to IMPORTER_INGESTED_VIA. Shared with transcripts accept-fences (#9427).
 */
export function importerWroteLiveRevisionSql(page: string, request: string, via: string): string {
  return `CASE WHEN ${page}.revision_write_request_id IS NULL THEN ${page}.ingested_via IS NULL OR ${page}.ingested_via = ${via}
                 WHEN ${request}.id IS NOT NULL THEN ${request}.principal_kind = 'local_cli' AND ${request}.intent->>'ingested_via' IS NOT DISTINCT FROM ${via}
                 ELSE ${page}.revision_principal_kind IS NOT DISTINCT FROM 'local_cli' AND ${page}.ingested_via IS NOT DISTINCT FROM ${via} END`;
}
