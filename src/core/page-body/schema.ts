/**
 * Segmented page storage (Wave B) DDL shared by migration v248 and both schema
 * blobs (src/schema.sql regions; `bun run build:schema`).
 *
 * The new tables live in the blob; the columns v248 adds to pages,
 * content_chunks and page_versions do not. Those are migration-only, like the
 * trust-tier columns, so a fresh install (blob, then every migration) and an
 * upgraded brain end with the same column order. Blob triggers therefore read
 * `pages.body_generation` / `timeline_lead` only on a row whose body columns
 * are NULL, which v248's DROP NOT NULL is the first to permit.
 */

/**
 * Query-cache generation bump (v0.40.3.0, migration v91's trigger function).
 * BEFORE INSERT OR UPDATE so every write path bumps generation (D6 / codex #4).
 * INSERT: pages get COALESCE(MAX(generation), 0) + 1 so the bookmark gate
 * fires for any cache row stored before the new page existed. UPDATE: bumps
 * only when a content column IS DISTINCT FROM (allow-list widened per D6 +
 * codex #3 to include title/type/page_kind/corpus_generation/content_hash) so
 * read-time mutations don't invalidate every cache row. A segmented page's
 * body identity is `body_generation`: its body columns are NULL on both sides
 * of a flip, so the generation moves when body_generation does.
 */
export const PAGE_GENERATION_BUMP_FN_SQL = `CREATE OR REPLACE FUNCTION bump_page_generation_fn() RETURNS trigger SET search_path = pg_catalog, public AS $func$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    NEW.generation := COALESCE((SELECT MAX(generation) FROM pages), 0) + 1;
  ELSIF (OLD.compiled_truth IS DISTINCT FROM NEW.compiled_truth)
     OR (OLD.timeline IS DISTINCT FROM NEW.timeline)
     OR (OLD.frontmatter IS DISTINCT FROM NEW.frontmatter)
     OR (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
     OR (OLD.contextual_retrieval_mode IS DISTINCT FROM NEW.contextual_retrieval_mode)
     OR (OLD.title IS DISTINCT FROM NEW.title)
     OR (OLD.type IS DISTINCT FROM NEW.type)
     OR (OLD.page_kind IS DISTINCT FROM NEW.page_kind)
     OR (OLD.corpus_generation IS DISTINCT FROM NEW.corpus_generation)
     OR (OLD.content_hash IS DISTINCT FROM NEW.content_hash)
  THEN
    NEW.generation := OLD.generation + 1;
  ELSIF OLD.compiled_truth IS NULL AND NEW.compiled_truth IS NULL THEN
    IF OLD.body_generation IS DISTINCT FROM NEW.body_generation THEN
      NEW.generation := OLD.generation + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;`;

/**
 * The segment texts each staging staged or deduped onto (migration v255). A create keeps its manifest rows in memory
 * until it publishes and a replace stages its texts before its manifest rows, so this is the only durable record of
 * which texts a live staging still needs: a page purge keeps exactly those of the texts no manifest row references.
 * Rows go with their staging; they hold hashes, never text.
 */
export const PAGE_BODY_STAGING_TEXTS_SQL = `CREATE TABLE IF NOT EXISTS page_body_staging_texts (
  staging_id UUID  NOT NULL REFERENCES page_body_stagings(id) ON DELETE CASCADE,
  source_id  TEXT  NOT NULL,
  sha256     BYTEA NOT NULL,
  PRIMARY KEY (staging_id, sha256)
);
CREATE INDEX IF NOT EXISTS page_body_staging_texts_text ON page_body_staging_texts (source_id, sha256);`;

/**
 * A live staging (open, sealed or prepared, or named by a non-terminal persistence request's body_ref, the segment
 * GC's roots) recorded the text `t` (a caller alias exposing source_id and sha256) in page_body_staging_texts: a write
 * that has not published still needs it. Constant SQL over the alias, no values, for the purge statements that keep
 * exactly those texts.
 */
export function stagingNeedsTextSql(t: string): string {
  return `EXISTS (SELECT 1 FROM page_body_staging_texts r JOIN page_body_stagings rs ON rs.id = r.staging_id
      WHERE r.source_id = ${t}.source_id AND r.sha256 = ${t}.sha256 AND ${liveStagingSql('rs')})`;
}

/** The staging `s` (an alias of page_body_stagings) is live in stagingNeedsTextSql's sense: a write that may still publish it. */
export function liveStagingSql(s: string): string {
  return `(${s}.state IN ('open','sealed','prepared')
          OR EXISTS (SELECT 1 FROM persistence_requests rq WHERE rq.state IN ('queued','running','recovering')
                      AND rq.intent->'body_ref'->>'staging_id' = ${s}.id::text))`;
}

/**
 * Segment texts (stored once per source and sha256), the generation-ranged
 * manifest, body stagings and their raw upload parts, and the occurrence id
 * sequence. The manifest's text FK is NO ACTION: a referenced text can't be
 * deleted, and a source delete cascades through pages and texts in one
 * statement before the check runs. The manifest key carries the staging
 * (`staging_key`: the staging id, or the nil uuid once published), so published
 * rows are unique per (page, occurrence, gen_from) and the rows of a staging
 * that never flipped can't collide with the next write's.
 */
export const PAGE_BODY_SCHEMA_SQL = `CREATE SEQUENCE IF NOT EXISTS page_body_occurrence_id_seq;
CREATE TABLE IF NOT EXISTS page_segment_texts (
  source_id  TEXT    NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  sha256     BYTEA   NOT NULL CHECK (octet_length(sha256) = 32),
  byte_len   INTEGER NOT NULL CHECK (byte_len BETWEEN 1 AND 1048576),
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  body       BYTEA   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, sha256)
);
CREATE TABLE IF NOT EXISTS page_body_manifest (
  page_id           INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  occurrence_id     BIGINT  NOT NULL,
  gen_from          BIGINT  NOT NULL,
  gen_to            BIGINT,
  seq               INTEGER NOT NULL,
  region            TEXT    NOT NULL CHECK (region IN ('truth','timeline')),
  source_id         TEXT    NOT NULL,
  sha256            BYTEA   NOT NULL,
  byte_start        BIGINT  NOT NULL,
  byte_len          INTEGER NOT NULL,
  line_start        BIGINT  NOT NULL,
  line_count        INTEGER NOT NULL,
  cut_kind          TEXT    NOT NULL CHECK (cut_kind IN ('heading','day','message','blank','forced','region_end','eof')),
  entry_state       JSONB   NOT NULL,
  protected_regions JSONB   NOT NULL DEFAULT '[]',
  facts_slots       JSONB   NOT NULL DEFAULT '[]',
  static_proj_bytes BIGINT  NOT NULL,
  static_proj_lines INTEGER NOT NULL,
  outline           JSONB   NOT NULL DEFAULT '[]',
  date_min          DATE,
  date_max          DATE,
  hash_state        BYTEA   NOT NULL,
  staging_id        UUID,
  staging_key       UUID GENERATED ALWAYS AS (COALESCE(staging_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  PRIMARY KEY (page_id, occurrence_id, gen_from, staging_key),
  FOREIGN KEY (source_id, sha256) REFERENCES page_segment_texts(source_id, sha256)
);
CREATE UNIQUE INDEX IF NOT EXISTS page_body_manifest_live_seq ON page_body_manifest (page_id, seq) WHERE gen_to IS NULL AND staging_id IS NULL;
CREATE INDEX IF NOT EXISTS page_body_manifest_live_bytes ON page_body_manifest (page_id, byte_start) WHERE gen_to IS NULL;
CREATE INDEX IF NOT EXISTS page_body_manifest_text ON page_body_manifest (source_id, sha256);
CREATE INDEX IF NOT EXISTS page_body_manifest_staging ON page_body_manifest (staging_id) WHERE staging_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS page_body_stagings (
  id                 UUID PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('upload','import','sync','put','append','edit','resegment')),
  principal_kind     TEXT NOT NULL,
  principal_id       TEXT NOT NULL,
  client_request_id  UUID NOT NULL,
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation UUID NOT NULL,
  slug               TEXT NOT NULL,
  page_id            INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  mode               TEXT NOT NULL CHECK (mode IN ('create','replace','append')),
  base_revision      UUID,
  base_generation    BIGINT,
  declared_bytes     BIGINT NOT NULL CHECK (declared_bytes >= 0),
  declared_sha256    BYTEA,
  received_bytes     BIGINT NOT NULL DEFAULT 0,
  next_part          INTEGER NOT NULL DEFAULT 0,
  reserved_bytes     BIGINT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','sealed','prepared','committed','aborted','expired')),
  commit_request_id  UUID,
  idle_expires_at    TIMESTAMPTZ NOT NULL,
  hard_expires_at    TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_kind, principal_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS page_body_stagings_expiry ON page_body_stagings (hard_expires_at) WHERE state IN ('open','sealed','prepared');
CREATE TABLE IF NOT EXISTS page_body_staging_parts (
  staging_id UUID    NOT NULL REFERENCES page_body_stagings(id) ON DELETE CASCADE,
  part_no    INTEGER NOT NULL CHECK (part_no >= 0),
  byte_start BIGINT  NOT NULL,
  byte_len   INTEGER NOT NULL CHECK (byte_len BETWEEN 1 AND 4194304),
  sha256     BYTEA   NOT NULL,
  body       BYTEA   NOT NULL,
  PRIMARY KEY (staging_id, part_no)
);
${PAGE_BODY_STAGING_TEXTS_SQL}`;

/**
 * The derivation pipelines whose per-segment results page_segment_derivations records (wave-b spec 8.1-8.6, PR 4), and
 * the states a row can settle in. One list feeds the table's CHECKs and the TS types (page-body/derivations.ts).
 */
export const SEGMENT_DERIVATION_KINDS = ['links', 'mentions', 'timeline', 'fences', 'conversation_facts', 'facts_backstop', 'synopsis'] as const;
export const SEGMENT_DERIVATION_STATES = ['done', 'partial', 'failed', 'skipped'] as const;
const sqlList = (values: readonly string[]) => values.map(v => `'${v}'`).join(',');

/**
 * Folds the lowercase forms a database writes depending on context or locale, applied after lowering on both sides:
 * Greek final sigma (lower('ΚΩΣΤΑΣ') is 'κωστασ' while stored text keeps 'κωστας') and the dot JavaScript and ICU keep
 * after a lowered Turkish İ ('i̇'). gbrain_fact_normalize itself stays as it is: fact fingerprints are stored.
 */
export const foldSql = (expr: string) => `replace(translate(${expr}, 'ς', 'σ'), 'i\u0307', 'i')`;

/**
 * SQL predicate, the prefilter: `text`, lowered and folded, matches one of the patterns in the text[] parameter
 * `patterns` (from derivationNeedles): has a claim's words in the claim's order. Normalization only lowers, folds
 * characters to spaces and collapses spaces, keeping order, so the words of a claim a text holds occur in it in that
 * order (in a row's JSON text too: JSON escapes only quotes, backslashes and control characters, which no word holds);
 * a text this rejects never holds the claim.
 */
const hasWordsSql = (text: string, patterns: string) => `${foldSql(`lower(${text})`)} LIKE ANY (${patterns}::text[])`;

/** SQL predicate: derivation row `d`'s output and receipt JSON text passes the prefilter (see hasWordsSql). */
export function derivationClaimCandidateSql(d: string, patterns: string): string {
  return hasWordsSql(`COALESCE(${d}.output::text, '') || ' ' || COALESCE(${d}.receipt::text, '')`, patterns);
}

/**
 * SQL predicate: derivation row `d` holds one of the claims (the text[] parameters `needles` and `patterns`, from
 * derivationNeedles). The row goes through the needle's own normalization (gbrain_fact_normalize, the fact fingerprint's:
 * lowercase, punctuation folded, whitespace collapsed; then foldSql) in the database, so it matches whatever case,
 * spacing or locale lowercasing the claim was written in. The claim must fill whole words of one string value or object
 * key of the row's output or receipt (link excerpts carry it inside a longer window, so equality would miss them): "plays
 * oboe" never matches "plays oboes", nor a claim straddling two fields. Only a row, and then a value, passing the
 * prefilter is normalized.
 */
export function derivationHoldsClaimSql(d: string, needles: string, patterns: string): string {
  return `CASE WHEN ${derivationClaimCandidateSql(d, patterns)} THEN EXISTS (SELECT 1 FROM (VALUES (${d}.output), (${d}.receipt)) doc(j),
    LATERAL (SELECT jsonb_path_query(doc.j, 'strict $.** ? (@.type() == "string")') #>> '{}' AS t
      UNION ALL SELECT jsonb_path_query(doc.j, 'strict $.** ? (@.type() == "object").keyvalue().key') #>> '{}') s
    WHERE CASE WHEN ${hasWordsSql('s.t', patterns)} THEN EXISTS (SELECT 1 FROM unnest(${needles}::text[]) k(n)
      WHERE strpos(' ' || ${foldSql('gbrain_fact_normalize(s.t)')} || ' ', k.n) > 0) ELSE false END) ELSE false END`;
}

/**
 * SQL predicate: derivation row `d` of page `p` is one a fact purge sweeps: a row of a page the purge rewrote (the
 * int[] parameter `pageIds`), or a row no live segment backs (its occurrence retired, its page demoted to inline or
 * soft-deleted). Any other row was derived from a live segment of a page the purge left alone, so it holds only what
 * that page's prose still says, and the next derivation would write it back.
 */
export function derivationSweepScopeSql(d: string, p: string, pageIds: string): string {
  return `(${d}.page_id = ANY(${pageIds}::int[]) OR ${p}.deleted_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM page_body_manifest m
    WHERE m.page_id = ${d}.page_id AND m.occurrence_id = ${d}.occurrence_id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.sha256 = ${d}.segment_sha256))`;
}

/**
 * SQL: the advisory lock key that serializes a write bringing a row into a derivation sweep's scope with the end of the
 * source's sweeps. The scope-entry trigger takes it shared in the writer's transaction every time it fires, a sweep
 * recorded or not. A sweep moves from its first walk to its verify walks, and ends (deletes its record), only under it
 * held exclusively: so every writer that fired before the sweep was recorded, and left no note, has committed before a
 * verify walk starts, and every later writer's note is visible when the record ends. The sweep tries it without waiting
 * and otherwise waits a bounded time in a transaction that holds no other lock (segment-derive.ts continueDerivationPurges).
 */
export function derivationScopeLockSql(sourceId: string): string {
  return `hashtextextended('gbrain:derivation-scope:' || ${sourceId}, 0)`;
}

/**
 * Per-segment derivation watermarks (migration v273): one row per page, pipeline and manifest occurrence, recording
 * the segment text and the context (`context_hash`: entry state plus the page-level inputs the pipeline reads) it was
 * derived from, the pipeline version, the outcome and a bounded per-segment output. A pipeline's work on a page is the
 * live occurrences without a settled row whose segment sha, context hash and version match, found from metadata alone.
 * Rows of an occurrence that left the live generation are deleted by their pipeline (retireSegmentDerivations) or by a
 * fence rewrite; demotion to inline deletes the page's rows, a fact purge the rows holding the claim, and a page
 * delete cascades. The output holds link context and window anchors, so the table gets the segment tables' RLS posture.
 *
 * page_segment_derivation_purges holds a fact purge's derivation sweep from the purge's commit until it is verified
 * (segment-derive.ts continueDerivationPurges): the claim's normalized forms, the pages the purge rewrote, the walk's
 * phase and cursor, its adaptive batch size, once a row alone outran the statement budget, when it stalled and, while a
 * write still open in the source keeps it from ending past its bounded wait, that it waits on one (`pending_reason`). While it
 * is there, the trigger on page_segment_derivations drops a write of a row of the source that the sweep would delete (in
 * its scope, derivationSweepScopeSql, and holding the claim; returns NULL: the row is not stored and the pipeline derives
 * it again after the sweep; a paid pipeline makes no call on such a page meanwhile, page-embedding-budget.ts
 * meterPaidCall), so a row the walk has passed cannot come back behind it. A derivation write that read a purged page
 * before the purge committed is refused by its own generation guard instead. A row can also enter the scope without a
 * write, when its occurrence is retired or its page soft-deleted: the triggers on page_body_manifest and pages note the
 * page in page_segment_derivation_purge_pages for every sweep of the source, and the sweep checks those pages again
 * before it ends.
 *
 * PR 4 (Wave B incremental derivation, transcripts): page_derivation_spend is the per-page lifetime spend ledger of each
 * paid derivation family (`facts`, `synopsis`; page-spend.ts), each capped by `derive.max_usd_per_page` on its own,
 * apart from the embedding ledger (page_embedding_budget), so derivation spend never starves a page's embeddings.
 */
export const PAGE_SEGMENT_DERIVATIONS_SQL = `CREATE TABLE IF NOT EXISTS page_segment_derivations (
  page_id          INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  pipeline         TEXT    NOT NULL CHECK (pipeline IN (${sqlList(SEGMENT_DERIVATION_KINDS)})),
  occurrence_id    BIGINT  NOT NULL,
  pipeline_version INTEGER NOT NULL CHECK (pipeline_version >= 0),
  segment_sha256   BYTEA   NOT NULL CHECK (octet_length(segment_sha256) = 32),
  context_hash     BYTEA   NOT NULL CHECK (octet_length(context_hash) = 32),
  state            TEXT    NOT NULL CHECK (state IN (${sqlList(SEGMENT_DERIVATION_STATES)})),
  output           JSONB,
  receipt          JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, pipeline, occurrence_id)
);
CREATE INDEX IF NOT EXISTS page_segment_derivations_unsettled ON page_segment_derivations (pipeline, page_id) WHERE state IN ('partial','failed');
CREATE TABLE IF NOT EXISTS page_derivation_spend (
  page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  family       TEXT    NOT NULL CHECK (family IN ('facts','synopsis')),
  spent_usd    DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  reserved_at  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, family)
);
CREATE TABLE IF NOT EXISTS page_segment_derivation_purges (
  request_id        UUID      PRIMARY KEY,
  source_id         TEXT      NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  needles           TEXT[]    NOT NULL,
  patterns          TEXT[]    NOT NULL,
  page_ids          INTEGER[] NOT NULL DEFAULT '{}',
  phase             TEXT      NOT NULL DEFAULT 'sweep' CHECK (phase IN ('sweep','verify','recheck')),
  recheck           INTEGER[],
  found             INTEGER   NOT NULL DEFAULT 0 CHECK (found >= 0),
  cursor_page       INTEGER,
  cursor_pipeline   TEXT,
  cursor_occurrence BIGINT,
  batch_rows        INTEGER   CHECK (batch_rows >= 1),
  stalled_at        TIMESTAMPTZ,
  stalled_reason    TEXT      CHECK (stalled_reason IN ('statement_timeout','paid_row_unreadable')),
  pending_reason    TEXT      CHECK (pending_reason IN ('scope_lock_busy')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_segment_derivation_purges_source ON page_segment_derivation_purges (source_id, created_at);
CREATE TABLE IF NOT EXISTS page_segment_derivation_purge_pages (
  request_id UUID    NOT NULL,
  page_id    INTEGER NOT NULL,
  PRIMARY KEY (request_id, page_id)
);
CREATE OR REPLACE FUNCTION gbrain_mark_derivation_scope_entry() RETURNS trigger SET search_path = pg_catalog, public AS $func$
DECLARE
  src TEXT;
  page INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'pages' THEN
    src := NEW.source_id;
    page := NEW.id;
  ELSE
    src := OLD.source_id;
    page := OLD.page_id;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(${derivationScopeLockSql('src')});
  INSERT INTO page_segment_derivation_purge_pages (request_id, page_id)
    SELECT x.request_id, page FROM page_segment_derivation_purges x WHERE x.source_id = src ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$func$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS page_body_manifest_derivation_scope_retire ON page_body_manifest;
CREATE TRIGGER page_body_manifest_derivation_scope_retire AFTER UPDATE OF gen_to ON page_body_manifest
  FOR EACH ROW WHEN (OLD.gen_to IS NULL AND NEW.gen_to IS NOT NULL AND OLD.staging_id IS NULL) EXECUTE FUNCTION gbrain_mark_derivation_scope_entry();
DROP TRIGGER IF EXISTS page_body_manifest_derivation_scope_delete ON page_body_manifest;
CREATE TRIGGER page_body_manifest_derivation_scope_delete AFTER DELETE ON page_body_manifest
  FOR EACH ROW WHEN (OLD.gen_to IS NULL AND OLD.staging_id IS NULL) EXECUTE FUNCTION gbrain_mark_derivation_scope_entry();
DROP TRIGGER IF EXISTS pages_derivation_scope_delete ON pages;
CREATE TRIGGER pages_derivation_scope_delete AFTER UPDATE OF deleted_at ON pages
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION gbrain_mark_derivation_scope_entry();
CREATE OR REPLACE FUNCTION gbrain_refuse_purging_derivation() RETURNS trigger SET search_path = pg_catalog, public AS $func$
BEGIN
  IF EXISTS (SELECT 1 FROM page_segment_derivation_purges x JOIN pages p ON p.source_id = x.source_id
    WHERE p.id = NEW.page_id AND ${derivationSweepScopeSql('NEW', 'p', 'x.page_ids')}
      AND ${derivationHoldsClaimSql('NEW', 'x.needles', 'x.patterns')}) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$func$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS page_segment_derivations_refuse_purging ON page_segment_derivations;
CREATE TRIGGER page_segment_derivations_refuse_purging BEFORE INSERT OR UPDATE OF output, receipt ON page_segment_derivations
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purging_derivation();`;

/**
 * The segment tables hold page text (`page_segment_texts`, `page_body_staging_parts`) or a page's shape and
 * headings (`page_body_manifest`, `page_body_stagings`, `page_view_digests`) or derived link context
 * (`page_segment_derivations`, and the purged claims `page_segment_derivation_purges` holds) or a page's derivation
 * spend (`page_derivation_spend`), so they get the posture of `pages`
 * and `content_chunks`: RLS on, re-asserted on every schema replay like the core list in src/schema.sql, so a brain
 * the auto-RLS event trigger (v35) missed, or one where it was dropped or disabled, never serves segment text to a
 * role `pages` returns no rows to. Only under a role that bypasses RLS (else the runtime role would lock itself out),
 * and only for a table still without it (ENABLE takes an ACCESS EXCLUSIVE lock even when RLS is on, #5227).
 * `page_view_digests` is absent while migration v248 runs. Postgres only: PGLite has no role system, and its
 * bootstrap enables RLS on no core table either. Source-scoped policies are operator SQL (docs/ENGINES.md).
 * Only a full initSchema replays this block: a migration that creates one of these tables enables RLS itself
 * (v275 backfills the v273 tables), since `gbrain apply-migrations --yes` runs migrations without the blob.
 */
export const PAGE_BODY_RLS_TABLES = ['page_segment_texts', 'page_body_manifest', 'page_body_stagings', 'page_body_staging_parts', 'page_view_digests', 'page_body_staging_texts', 'page_segment_derivations',
  'page_derivation_spend', 'page_segment_derivation_purges', 'page_segment_derivation_purge_pages'] as const;
export const PAGE_BODY_RLS_SQL = `DO $rls$
DECLARE target TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    FOREACH target IN ARRAY ARRAY[${PAGE_BODY_RLS_TABLES.map(t => `'${t}'`).join(',')}] LOOP
      IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = current_schema() AND c.relname = target AND c.relkind = 'r' AND NOT c.relrowsecurity) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
      END IF;
    END LOOP;
  END IF;
END $rls$;`;

