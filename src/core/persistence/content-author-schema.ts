/**
 * GST-4056: who wrote a page's live text, kept on the page row so maintenance cannot rewrite it.
 *
 * `pages.content_author` names the channel of the write that produced the page's current text (the write's own
 * provenance: `cli:transcripts-ingest`, `connector:<kind>`, `mcp:<operation>` for a remote write, NULL for a writer that
 * declared none), and `pages.content_author_hash` the content hash that write produced. Readers that ask "did the
 * importer write this text?" (transcripts/importer-provenance.ts, identity/speaker-owner.ts) trust a page only when the
 * author is the importer AND the hash is the page's current `content_hash`. Unlike `ingested_via` (the first-ingest
 * record, which every later write keeps) and the revision attribution (which tag changes and maintenance move), the
 * author changes only with the text:
 *
 * - putPage and the segmented flip declare it on every write from the write's own channel (import-file.ts
 *   `content_author`); a write whose hash equals the declared one keeps the stored author (identical text).
 * - The BEFORE UPDATE trigger below clears it when a statement changes the page's content hash (which every text
 *   writer restamps: title, type, body, timeline, frontmatter other than the hash-ephemeral keys and `tags`) without
 *   declaring a new author, so a raw UPDATE, a maintenance rewrite or an older binary never leaves a stale author
 *   beside new text. The trigger reads the hash, never the body, so a segmented page is covered the same way.
 * - Metadata and projection writes (tags, contextual re-embedding, salience, provenance columns, receipt compaction)
 *   change no text and keep it.
 *
 * Columns and trigger come from migration v341 only, like the write attribution DDL, so fresh and upgraded brains get
 * the same column order. The migration's backfill (CONTENT_AUTHOR_BACKFILL_SQL) stamps legacy pages the old rule
 * trusted, unless a remote writer is on record for the page.
 */
/** Provenance of the local importers whose pages carry speaker and transcript-layout trust. */
export const TRUSTED_IMPORTER_VIAS: readonly string[] = ['cli:transcripts-ingest', 'cli:transcripts-archive'];
/** Connector source kinds whose sync is a trusted importer; a connector write declares `connector:<connector>`. */
export const CONNECTOR_AUTHOR_KINDS: readonly string[] = ['google', 'imessage', 'meetings'];
export const CONNECTOR_AUTHOR_PREFIX = 'connector:';

/** Principals that reach the brain from outside (MCP over HTTP, legacy tokens, stdio MCP). */
const REMOTE_PRINCIPAL_KINDS = ['oauth_client', 'legacy_token', 'local_stdio'];
/** Journaled operations that change no page text. */
const METADATA_OPERATIONS = ['add_tag', 'remove_tag', 'add_link', 'remove_link'];

const list = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');

export const CONTENT_AUTHOR_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION gbrain_guard_content_author() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF (NEW.content_author, NEW.content_author_hash) IS NOT DISTINCT FROM (OLD.content_author, OLD.content_author_hash)
     AND (NEW.content_author, NEW.content_author_hash) IS DISTINCT FROM (NULL::text, NULL::text)
     AND NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
    NEW.content_author := NULL;
    NEW.content_author_hash := NULL;
  END IF;
  RETURN NEW;
END $fn$`;

/**
 * Legacy pages: the importer's or a connector's pages that the rule before GST-4056 trusted (no request wrote the live
 * revision, or a local CLI request did with the importer's provenance or with its intent compacted away, or a tag or
 * link change did), with no remote writer on record for the page: no committed remote request that changed its text,
 * and no archived version a remote principal wrote. What the journal and the version history no longer show cannot be
 * detected; such a page keeps the trust the old rule gave it until its next write.
 */
export const CONTENT_AUTHOR_BACKFILL_SQL = `WITH remote_pages AS MATERIALIZED (
  SELECT DISTINCT r.source_id, r.slug FROM persistence_requests r
   WHERE r.principal_kind IN (${list(REMOTE_PRINCIPAL_KINDS)}) AND r.state = 'committed' AND r.operation NOT IN (${list(METADATA_OPERATIONS)})
), remote_versions AS MATERIALIZED (
  SELECT DISTINCT v.page_id FROM page_versions v LEFT JOIN persistence_requests r ON r.id = v.write_request_id
   WHERE v.write_principal_kind IN (${list(REMOTE_PRINCIPAL_KINDS)}) AND (r.id IS NULL OR r.operation NOT IN (${list(METADATA_OPERATIONS)}))
), legacy AS MATERIALIZED (
  SELECT p.id, CASE WHEN p.ingested_via IN (${list(TRUSTED_IMPORTER_VIAS)}) THEN p.ingested_via ELSE '${CONNECTOR_AUTHOR_PREFIX}' || (s.config->>'kind') END AS author
    FROM pages p JOIN sources s ON s.id = p.source_id
    LEFT JOIN persistence_requests r ON r.id = p.revision_write_request_id
   WHERE p.content_author IS NULL AND p.content_hash IS NOT NULL
     AND (p.ingested_via IN (${list(TRUSTED_IMPORTER_VIAS)}) OR (p.ingested_via IS NULL AND s.config->>'kind' IN (${list(CONNECTOR_AUTHOR_KINDS)})))
     AND (p.revision_principal_kind IS NULL OR p.revision_principal_kind NOT IN (${list(REMOTE_PRINCIPAL_KINDS)}))
     AND CASE WHEN p.revision_write_request_id IS NULL THEN true
              WHEN r.id IS NULL THEN p.revision_principal_kind IS NOT DISTINCT FROM 'local_cli'
              WHEN r.principal_kind IN (${list(REMOTE_PRINCIPAL_KINDS)}) THEN false
              WHEN r.operation IN (${list(METADATA_OPERATIONS)}) THEN true
              ELSE r.principal_kind = 'local_cli' AND (r.intent IS NULL OR r.intent->>'ingested_via' IS NOT DISTINCT FROM p.ingested_via
                OR (r.operation = 'submit_job' AND r.intent->>'kind' = 'connector_v2_import')) END
     AND NOT EXISTS (SELECT 1 FROM remote_pages x WHERE x.source_id = p.source_id AND x.slug = p.slug)
     AND NOT EXISTS (SELECT 1 FROM remote_versions x WHERE x.page_id = p.id)
)
UPDATE pages p SET content_author = legacy.author, content_author_hash = p.content_hash FROM legacy WHERE p.id = legacy.id`;

export const CONTENT_AUTHOR_SCHEMA_SQL = `ALTER TABLE pages ADD COLUMN IF NOT EXISTS content_author TEXT, ADD COLUMN IF NOT EXISTS content_author_hash TEXT;
${CONTENT_AUTHOR_FUNCTION_SQL};
DROP TRIGGER IF EXISTS pages_content_author ON pages;
CREATE TRIGGER pages_content_author BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION gbrain_guard_content_author();
${CONTENT_AUTHOR_BACKFILL_SQL};
`;

/**
 * SQL: page alias `page`'s live text was written by one of `authors` (a SQL list or placeholder expression). A stale
 * author (its hash is not the page's) never counts.
 */
export function contentAuthoredBySql(page: string, authors: string): string {
  return `(${page}.content_author IN (${authors}) AND ${page}.content_author_hash = ${page}.content_hash)`;
}
