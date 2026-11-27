/**
 * GST-4056: who wrote a page's live text, kept on the page row so maintenance cannot rewrite it.
 *
 * `pages.content_author` names the channel of the write that produced the page's current text (the write's own
 * provenance: `cli:transcripts-ingest`, `connector:<kind>`, `mcp:<operation>` for a remote write, NULL for a writer that
 * declared none), and `pages.content_author_hash` the content hash it holds for. Readers that ask "did the importer write
 * this text?" (transcripts/importer-provenance.ts, identity/speaker-owner.ts) trust a page only when the author is the
 * importer AND its hash is the page's current `content_hash`. Unlike `ingested_via` (the first-ingest record, which
 * every later write keeps) and the revision attribution (which tag changes and maintenance move), the author follows
 * the text:
 *
 * - A write declares its author by setting `content_author` and leaving `content_author_hash` NULL; the BEFORE UPDATE
 *   trigger below stamps the hash. putPage and the segmented flip declare it on every write from the write's own channel
 *   (import-file.ts `content_author`), so a repeated declaration still counts (a statement that writes the same author
 *   and hash it found declares nothing).
 * - New text: the declared author, or none when the statement declared none (a raw UPDATE, a maintenance rewrite that
 *   keeps the hash, a projection-only flip that does not carry the author, an older binary). An empty author (`NO_AUTHOR`)
 *   clears both columns even on unchanged text.
 * - The same text (title, type, body, timeline, body generation and frontmatter other than the hash-ephemeral keys and
 *   `tags`): a trusted importer or connector that declares itself takes it; otherwise a verified author stays and its
 *   hash follows the content hash (a tag change restamps the hash), so a remote write of identical text, a tag change or
 *   contextual re-embedding never moves it.
 *
 * Columns and trigger come from migration v341, the backfill of existing pages from v342 (its own transaction, so the
 * DDL's lock is released before the scan).
 */
import { HASH_EPHEMERAL_FRONTMATTER_KEYS } from '../utils.ts';

/** Provenance of the local importers whose pages carry speaker and transcript-layout trust. */
export const TRUSTED_IMPORTER_VIAS: readonly string[] = ['cli:transcripts-ingest', 'cli:transcripts-archive'];
/** Connector source kinds whose sync is a trusted importer; a connector write declares `connector:<connector>`. */
export const CONNECTOR_AUTHOR_KINDS: readonly string[] = ['google', 'imessage', 'meetings'];
export const CONNECTOR_AUTHOR_PREFIX = 'connector:';
/**
 * The backfill's author for a page the rule before GST-4056 trusted only through its first-ingest stamp (the live
 * revision carries no importer request): speaker markers honor it as before, fence acceptance does not.
 */
export const LEGACY_AUTHOR_PREFIX = 'legacy:';
/** A declared author that clears both columns whatever the text (engine migration copying a page whose source has none). */
export const NO_AUTHOR = '';

/** Principals that reach the brain from outside (MCP over HTTP, legacy tokens, stdio MCP). */
const REMOTE_PRINCIPAL_KINDS = ['oauth_client', 'legacy_token', 'local_stdio'];
/** Journaled operations that change no page text. */
const METADATA_OPERATIONS = ['add_tag', 'remove_tag', 'add_link', 'remove_link'];
/** Frontmatter keys that are not text: the content hash ignores them too (utils.ts contentHashFrontmatterAndTags). */
const NON_TEXT_FRONTMATTER_KEYS = [...HASH_EPHEMERAL_FRONTMATTER_KEYS, 'tags'];

const list = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');
const trustedAuthorSql = (author: string) => `(${author} IN (${list(TRUSTED_IMPORTER_VIAS)}) OR starts_with(${author}, '${CONNECTOR_AUTHOR_PREFIX}'))`;

/** A trusted importer or connector author: the one kind of write that takes over identical text. */
export function isTrustedContentAuthor(author: string | null | undefined): author is string {
  return !!author && (TRUSTED_IMPORTER_VIAS.includes(author) || author.startsWith(CONNECTOR_AUTHOR_PREFIX));
}

const strip = (row: 'NEW' | 'OLD') => `CASE WHEN jsonb_typeof(${row}.frontmatter) = 'object' THEN ${row}.frontmatter - ARRAY[${list(NON_TEXT_FRONTMATTER_KEYS)}]::text[] ELSE ${row}.frontmatter END`;
const text = (row: 'NEW' | 'OLD') => `(${row}.type, ${row}.title, ${row}.compiled_truth, ${row}.timeline, ${row}.body_generation, ${strip(row)})`;

export const CONTENT_AUTHOR_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION gbrain_guard_content_author() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  declared boolean := NEW.content_author IS NOT NULL AND NEW.content_author_hash IS NULL;
BEGIN
  IF NEW.content_author = '${NO_AUTHOR}' THEN
    NEW.content_author := NULL;
    NEW.content_author_hash := NULL;
  ELSIF ${text('NEW')} IS NOT DISTINCT FROM ${text('OLD')} THEN
    IF declared AND ${trustedAuthorSql('NEW.content_author')} THEN
      NEW.content_author_hash := NEW.content_hash;
    ELSIF OLD.content_author IS NOT NULL AND OLD.content_author_hash = OLD.content_hash THEN
      NEW.content_author := OLD.content_author;
      NEW.content_author_hash := NEW.content_hash;
    ELSIF declared THEN
      NEW.content_author_hash := NEW.content_hash;
    ELSE
      NEW.content_author := NULL;
      NEW.content_author_hash := NULL;
    END IF;
  ELSIF declared THEN
    NEW.content_author_hash := NEW.content_hash;
  ELSE
    NEW.content_author := NULL;
    NEW.content_author_hash := NULL;
  END IF;
  RETURN NEW;
END $fn$`;

/**
 * Legacy pages, never more trusted than the rule before GST-4056 left them, and never with a remote writer on record
 * (a committed remote request that changed text, or an archived version a remote principal wrote):
 * - a live importer request (any first-ingest channel) or a connector import job: that author;
 * - a live revision whose request row is gone, or no request and `ingested_at >= updated_at` (the old fence rule): the
 *   first-ingest channel;
 * - a tag or link request, a compacted request, or no request after a later update: `legacy:<channel>` for an importer
 *   page, honored by speaker markers only, as before; a connector page keeps its connector author.
 * What the journal and the version history no longer show cannot be seen; such a page keeps the old trust until its next
 * write or re-import. The update re-checks each page's hash, revision and empty author on the row it locks, so a write
 * that lands while the backfill runs is never stamped with the eligibility of the revision it replaced.
 */
export const CONTENT_AUTHOR_BACKFILL_SQL = `WITH remote_pages AS MATERIALIZED (
  SELECT DISTINCT r.source_id, r.slug FROM persistence_requests r
   WHERE r.principal_kind IN (${list(REMOTE_PRINCIPAL_KINDS)}) AND r.state = 'committed' AND r.operation NOT IN (${list(METADATA_OPERATIONS)})
     AND (r.outcome->>'noop') IS DISTINCT FROM 'true'
), remote_versions AS MATERIALIZED (
  SELECT DISTINCT v.page_id FROM page_versions v LEFT JOIN persistence_requests r ON r.id = v.write_request_id
   WHERE v.write_principal_kind IN (${list(REMOTE_PRINCIPAL_KINDS)}) AND (r.id IS NULL OR r.operation NOT IN (${list(METADATA_OPERATIONS)}))
), candidates AS MATERIALIZED (
  SELECT p.id, p.content_hash AS hash, p.knowledge_revision AS revision, r.id AS request_id, r.principal_kind, r.operation, r.intent, p.revision_write_request_id, p.revision_principal_kind,
         p.ingested_at >= p.updated_at AS untouched,
         CASE WHEN p.ingested_via IN (${list(TRUSTED_IMPORTER_VIAS)}) THEN p.ingested_via
              WHEN p.ingested_via IS NULL AND s.config->>'kind' IN (${list(CONNECTOR_AUTHOR_KINDS)}) THEN '${CONNECTOR_AUTHOR_PREFIX}' || (s.config->>'kind') END AS base,
         s.config->>'kind' IN (${list(CONNECTOR_AUTHOR_KINDS)}) AS connector_source, s.config->>'kind' AS kind
    FROM pages p JOIN sources s ON s.id = p.source_id
    LEFT JOIN persistence_requests r ON r.id = p.revision_write_request_id
   WHERE p.content_author IS NULL AND p.content_hash IS NOT NULL
     AND (p.revision_principal_kind IS NULL OR p.revision_principal_kind NOT IN (${list(REMOTE_PRINCIPAL_KINDS)}))
     AND NOT EXISTS (SELECT 1 FROM remote_pages x WHERE x.source_id = p.source_id AND x.slug = p.slug)
     AND NOT EXISTS (SELECT 1 FROM remote_versions x WHERE x.page_id = p.id)
), legacy AS (
  SELECT c.id, c.hash, c.revision, CASE
      WHEN c.request_id IS NOT NULL AND c.principal_kind IS DISTINCT FROM 'local_cli' THEN NULL
      WHEN c.request_id IS NOT NULL AND c.intent->>'ingested_via' IN (${list(TRUSTED_IMPORTER_VIAS)}) THEN c.intent->>'ingested_via'
      WHEN c.request_id IS NOT NULL AND c.operation = 'submit_job' AND c.intent->>'kind' = 'connector_v2_import' AND c.connector_source
        THEN '${CONNECTOR_AUTHOR_PREFIX}' || c.kind
      WHEN c.request_id IS NOT NULL AND c.intent IS NOT NULL AND c.operation NOT IN (${list(METADATA_OPERATIONS)}) THEN NULL
      WHEN c.request_id IS NULL AND c.revision_write_request_id IS NOT NULL
        THEN CASE WHEN c.revision_principal_kind IS NOT DISTINCT FROM 'local_cli' THEN c.base END
      WHEN c.request_id IS NULL AND c.untouched THEN c.base
      WHEN starts_with(c.base, '${CONNECTOR_AUTHOR_PREFIX}') THEN c.base
      ELSE '${LEGACY_AUTHOR_PREFIX}' || c.base END AS author
    FROM candidates c
)
UPDATE pages p SET content_author = legacy.author, content_author_hash = NULL FROM legacy
 WHERE p.id = legacy.id AND legacy.author IS NOT NULL AND p.content_author IS NULL AND p.content_hash = legacy.hash AND p.knowledge_revision = legacy.revision`;

export const CONTENT_AUTHOR_SCHEMA_SQL = `ALTER TABLE pages ADD COLUMN IF NOT EXISTS content_author TEXT, ADD COLUMN IF NOT EXISTS content_author_hash TEXT;
${CONTENT_AUTHOR_FUNCTION_SQL};
DROP TRIGGER IF EXISTS pages_content_author ON pages;
CREATE TRIGGER pages_content_author BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION gbrain_guard_content_author();
`;

/**
 * SQL: page alias `page`'s live text was written by one of `authors` (a SQL list or placeholder expression); with
 * `legacy`, also by a backfilled `legacy:<author>`. A stale author (its hash is not the page's) never counts.
 */
export function contentAuthoredBySql(page: string, authors: string, opts: { legacy?: boolean } = {}): string {
  const names = opts.legacy ? `${authors}, ${authors.split(',').map(a => `'${LEGACY_AUTHOR_PREFIX}' || ${a.trim()}`).join(', ')}` : authors;
  return `(${page}.content_author IN (${names}) AND ${page}.content_author_hash = ${page}.content_hash)`;
}

/** The page's verified content author (its hash is the live hash), or null: what a rewrite of unchanged text carries. */
export async function verifiedContentAuthor(exec: { executeRaw: <T>(sql: string, params?: unknown[]) => Promise<T[]> }, pageId: number | string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ author: string | null }>(`SELECT CASE WHEN content_author_hash = content_hash THEN content_author END AS author FROM pages WHERE id = $1`, [Number(pageId)]);
  return row?.author ?? null;
}
