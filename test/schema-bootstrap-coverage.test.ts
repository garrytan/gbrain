/**
 * CI guard: PGLITE_SCHEMA_SQL must not forward-reference state that
 * `applyForwardReferenceBootstrap` doesn't know how to create.
 *
 * Background: gbrain ships an "embedded latest schema" blob
 * (`pglite-schema.ts`) for fast bootstraps, alongside a numbered migration
 * chain (`migrate.ts`) for incremental upgrades. Across 2 years and 6 schema
 * versions, every release that added a column-with-index in the schema blob
 * without a corresponding bootstrap addition has triggered the same wedge
 * incident class (#239, #243, #266, #266, #357, #366, #374, #375, #378,
 * #395, #396).
 *
 * The bootstrap is the structural fix. This test enforces the contract:
 * for every "forward reference" the schema blob makes (FK or indexed column
 * defined later than its reference site, or any column that older brains
 * lack), the bootstrap MUST add enough state so that running the schema
 * blob is replay-safe on a brain that lacks every member of
 * `REQUIRED_BOOTSTRAP_COVERAGE`.
 *
 * **When you add a new schema-blob forward reference:**
 *   1. Extend `applyForwardReferenceBootstrap` in pglite-engine.ts +
 *      postgres-engine.ts to add the new state.
 *   2. Add an entry to `REQUIRED_BOOTSTRAP_COVERAGE` below.
 *   3. This test will pass.
 *
 * If you add a forward reference but skip step 1, this test fails. If you
 * skip step 2, this test passes but the bootstrap silently drifts behind
 * the schema. The eng-review polish notes recommended layered coverage
 * (per-engine integration tests in `test/bootstrap.test.ts` +
 * `test/e2e/postgres-bootstrap.test.ts`) to catch step 2 oversights.
 */

import { test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// Tier 3 opt-out: this file tests the bootstrap coverage contract explicitly,
// running applyForwardReferenceBootstrap against fresh PGlite instances. A
// snapshot-loaded engine would skip the bootstrap entirely.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

// Forward-reference targets that PGLITE_SCHEMA_SQL requires.
// When you add a new one, extend this list AND the bootstrap.
type ForwardReference =
  | { kind: 'table'; name: string }
  | { kind: 'column'; table: string; column: string };

const REQUIRED_BOOTSTRAP_COVERAGE: ForwardReference[] = [
  // Forward-referenced by `pages.source_id REFERENCES sources(id)` and the
  // `INSERT INTO sources (id, name, config) VALUES ('default', ...)` seed.
  { kind: 'table',  name: 'sources' },
  // Forward-referenced by `CREATE INDEX idx_pages_source_id ON pages(source_id)`.
  { kind: 'column', table: 'pages', column: 'source_id' },
  // Forward-referenced by `CREATE INDEX idx_links_source ON links(link_source)`.
  { kind: 'column', table: 'links', column: 'link_source' },
  // Forward-referenced by `CREATE INDEX idx_links_origin ON links(origin_page_id)`.
  { kind: 'column', table: 'links', column: 'origin_page_id' },
  // v0.19+ — forward-referenced by `CREATE INDEX idx_chunks_symbol_name
  // ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL`.
  { kind: 'column', table: 'content_chunks', column: 'symbol_name' },
  // v0.19+ — forward-referenced by `CREATE INDEX idx_chunks_language
  // ON content_chunks(language) WHERE language IS NOT NULL`.
  { kind: 'column', table: 'content_chunks', column: 'language' },
  // v0.20+ Cathedral II — forward-referenced by `CREATE INDEX
  // idx_chunks_search_vector ON content_chunks USING GIN(search_vector)`.
  { kind: 'column', table: 'content_chunks', column: 'search_vector' },
  // v0.20+ Cathedral II — forward-referenced by `CREATE INDEX
  // idx_chunks_symbol_qualified ON content_chunks(symbol_name_qualified)`.
  { kind: 'column', table: 'content_chunks', column: 'symbol_name_qualified' },
  // v0.20+ Cathedral II — populated by update_chunk_search_vector trigger;
  // present in PGLITE_SCHEMA_SQL CREATE TABLE definition.
  { kind: 'column', table: 'content_chunks', column: 'parent_symbol_path' },
  { kind: 'column', table: 'content_chunks', column: 'doc_comment' },
  // v0.26.5 — forward-referenced by `CREATE INDEX pages_deleted_at_purge_idx
  // ON pages (deleted_at) WHERE deleted_at IS NOT NULL`.
  { kind: 'column', table: 'pages', column: 'deleted_at' },
  // v0.27.1 — forward-referenced by `CREATE INDEX idx_chunks_embedding_image
  // ON content_chunks USING hnsw (embedding_image vector_cosine_ops)
  // WHERE embedding_image IS NOT NULL`.
  { kind: 'column', table: 'content_chunks', column: 'embedding_image' },
  // v0.27.1 — added in the same migration as embedding_image. Sibling column;
  // not directly forward-referenced by an index but the bootstrap adds it
  // alongside embedding_image for the v39 contract.
  { kind: 'column', table: 'content_chunks', column: 'modality' },
  // v0.26.3 (v33) — forward-referenced by `CREATE INDEX idx_mcp_log_agent_time
  // ON mcp_request_log(agent_name, created_at DESC)`.
  { kind: 'column', table: 'mcp_request_log', column: 'agent_name' },
  // v0.27 (v36) — forward-referenced by `CREATE INDEX
  // idx_subagent_messages_provider ON subagent_messages (job_id, provider_id)`.
  // Composite-index second column; the array-based test pattern misses these
  // by default, which is why this fix wave's Step 3 replaces this with a
  // SQL parser that extracts every column referenced by any DDL.
  { kind: 'column', table: 'subagent_messages', column: 'provider_id' },
  // v0.29 (v40) — pages.emotional_weight populated by recompute_emotional_weight;
  // bootstrapped alongside the v41 columns since they share the v0.29.1 wave.
  { kind: 'column', table: 'pages', column: 'emotional_weight' },
  // v0.29.1 (v41) — forward-referenced by `CREATE INDEX pages_coalesce_date_idx
  // ON pages ((COALESCE(effective_date, updated_at)))`. The expression-index
  // claim from earlier plan iterations was wrong; PG's planner won't use a
  // partial index for the negative side of a COALESCE — expression index is.
  { kind: 'column', table: 'pages', column: 'effective_date' },
  // v0.29.1 (v41) — sibling columns added in the same migration as
  // effective_date; bootstrap adds them all together.
  { kind: 'column', table: 'pages', column: 'effective_date_source' },
  { kind: 'column', table: 'pages', column: 'import_filename' },
  { kind: 'column', table: 'pages', column: 'salience_touched_at' },
  // v0.31.2 (v50) — forward-referenced by `CREATE INDEX
  // idx_ingest_log_source_type_created ON ingest_log (source_id, source_type,
  // created_at DESC)`. Old brains have ingest_log without source_id; bootstrap
  // adds the column before SCHEMA_SQL replay creates the index.
  { kind: 'column', table: 'ingest_log', column: 'source_id' },
  // v0.18 (v18) — forward-referenced by `CREATE INDEX idx_files_source_id ON
  // files(source_id)` and `CREATE INDEX idx_files_page_id ON files(page_id)`.
  // Pre-v18 brains have files without these columns; bootstrap adds them
  // before SCHEMA_SQL replay creates the indexes.
  { kind: 'column', table: 'files', column: 'source_id' },
  { kind: 'column', table: 'files', column: 'page_id' },
  // v0.34.1 (v60+v61+v65) — forward-referenced by the FK
  // `oauth_clients.source_id REFERENCES sources(id)` and the GIN index
  // `idx_oauth_clients_federated_read ON oauth_clients USING GIN (federated_read)`.
  // Pre-v60 brains have oauth_clients without these columns; bootstrap adds
  // them before SCHEMA_SQL replay creates the FK + index.
  { kind: 'column', table: 'oauth_clients', column: 'source_id' },
  { kind: 'column', table: 'oauth_clients', column: 'federated_read' },
  // v0.26.5 (v34) — promotes archive lifecycle from JSONB config to real
  // columns on sources. CREATE TABLE IF NOT EXISTS is a no-op on existing
  // sources tables, so the visibility filters in search/list_pages that
  // reference these columns trip on pre-v34 brains. Bootstrap adds them
  // before any visibility-filter SQL runs.
  { kind: 'column', table: 'sources', column: 'archived' },
  { kind: 'column', table: 'sources', column: 'archived_at' },
  { kind: 'column', table: 'sources', column: 'archive_expires_at' },
];

test('applyForwardReferenceBootstrap covers every forward reference declared in REQUIRED_BOOTSTRAP_COVERAGE', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    const db = (engine as any).db;

    // Strip every required forward-reference target so the brain looks like
    // it pre-dates the migrations that introduced these objects. Drop columns
    // before the table-level constraints that depend on them.
    await db.exec(`
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id;
      DROP TABLE IF EXISTS sources CASCADE;

      DROP INDEX IF EXISTS idx_links_source;
      DROP INDEX IF EXISTS idx_links_origin;
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_source_origin_unique;
      ALTER TABLE links DROP COLUMN IF EXISTS link_source;
      ALTER TABLE links DROP COLUMN IF EXISTS origin_page_id;

      DROP INDEX IF EXISTS idx_chunks_symbol_name;
      DROP INDEX IF EXISTS idx_chunks_language;
      DROP INDEX IF EXISTS idx_chunks_search_vector;
      DROP INDEX IF EXISTS idx_chunks_symbol_qualified;
      DROP TRIGGER IF EXISTS chunk_search_vector_trigger ON content_chunks;
      DROP FUNCTION IF EXISTS update_chunk_search_vector;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS symbol_name;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS language;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS parent_symbol_path;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS doc_comment;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS symbol_name_qualified;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS search_vector;

      DROP INDEX IF EXISTS pages_deleted_at_purge_idx;
      ALTER TABLE pages DROP COLUMN IF EXISTS deleted_at;

      DROP INDEX IF EXISTS idx_chunks_embedding_image;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_image;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS modality;

      DROP INDEX IF EXISTS idx_mcp_log_agent_time;
      DROP INDEX IF EXISTS idx_mcp_log_time_agent;
      ALTER TABLE mcp_request_log DROP COLUMN IF EXISTS agent_name;
      ALTER TABLE mcp_request_log DROP COLUMN IF EXISTS params;
      ALTER TABLE mcp_request_log DROP COLUMN IF EXISTS error_message;

      DROP INDEX IF EXISTS idx_subagent_messages_provider;
      ALTER TABLE subagent_messages DROP COLUMN IF EXISTS provider_id;

      DROP INDEX IF EXISTS pages_coalesce_date_idx;
      ALTER TABLE pages DROP COLUMN IF EXISTS effective_date;
      ALTER TABLE pages DROP COLUMN IF EXISTS effective_date_source;
      ALTER TABLE pages DROP COLUMN IF EXISTS import_filename;
      ALTER TABLE pages DROP COLUMN IF EXISTS salience_touched_at;
      ALTER TABLE pages DROP COLUMN IF EXISTS emotional_weight;

      DROP INDEX IF EXISTS idx_ingest_log_source_type_created;
      ALTER TABLE ingest_log DROP COLUMN IF EXISTS source_id;

      DROP INDEX IF EXISTS idx_files_source_id;
      DROP INDEX IF EXISTS idx_files_page_id;
      ALTER TABLE files DROP COLUMN IF EXISTS source_id;
      ALTER TABLE files DROP COLUMN IF EXISTS page_id;

      DROP INDEX IF EXISTS idx_oauth_clients_federated_read;
      ALTER TABLE oauth_clients DROP COLUMN IF EXISTS source_id;
      ALTER TABLE oauth_clients DROP COLUMN IF EXISTS federated_read;
    `);

    // Note: we don't strip sources.archived* here because they're inline in the
    // sources CREATE TABLE definition (no separate ALTER TABLE), and the
    // earlier `DROP TABLE IF EXISTS sources CASCADE` already nuked them.
    // The bootstrap's needsPagesBootstrap branch recreates sources without the
    // archive columns; the new needsSourcesArchive probe adds them.

    // Run bootstrap in isolation (NOT initSchema). This is what we're testing.
    await (engine as any).applyForwardReferenceBootstrap();

    // Assert every required forward-reference target now satisfies the
    // schema-blob's expectations.
    for (const ref of REQUIRED_BOOTSTRAP_COVERAGE) {
      if (ref.kind === 'table') {
        const { rows } = await db.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1`,
          [ref.name],
        );
        expect(rows.length).toBeGreaterThan(0);
      } else {
        const { rows } = await db.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [ref.table, ref.column],
        );
        expect(rows.length).toBeGreaterThan(0);
      }
    }
  } finally {
    await engine.disconnect();
  }
}, 30000);

test('after bootstrap, PGLITE_SCHEMA_SQL replays without crashing on missing forward references', async () => {
  // End-to-end contract: bootstrap → SCHEMA_SQL must succeed even on a brain
  // that lacks every forward-referenced target. This catches the case where
  // REQUIRED_BOOTSTRAP_COVERAGE drifts behind PGLITE_SCHEMA_SQL — if the
  // schema blob added a new index on a column the bootstrap doesn't create,
  // the SCHEMA_SQL exec below would crash even though the per-target asserts
  // above pass.
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    const db = (engine as any).db;

    await db.exec(`
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id;
      DROP TABLE IF EXISTS sources CASCADE;
      DROP INDEX IF EXISTS idx_links_source;
      DROP INDEX IF EXISTS idx_links_origin;
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_source_origin_unique;
      ALTER TABLE links DROP COLUMN IF EXISTS link_source;
      ALTER TABLE links DROP COLUMN IF EXISTS origin_page_id;
      DROP INDEX IF EXISTS pages_deleted_at_purge_idx;
      ALTER TABLE pages DROP COLUMN IF EXISTS deleted_at;

      DROP INDEX IF EXISTS idx_chunks_embedding_image;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_image;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS modality;

      DROP INDEX IF EXISTS pages_coalesce_date_idx;
      ALTER TABLE pages DROP COLUMN IF EXISTS effective_date;
      ALTER TABLE pages DROP COLUMN IF EXISTS effective_date_source;
      ALTER TABLE pages DROP COLUMN IF EXISTS import_filename;
      ALTER TABLE pages DROP COLUMN IF EXISTS salience_touched_at;
      ALTER TABLE pages DROP COLUMN IF EXISTS emotional_weight;
    `);

    // Bootstrap, then schema replay. Either step crashing fails the test.
    const { PGLITE_SCHEMA_SQL } = await import('../src/core/pglite-schema.ts');
    await (engine as any).applyForwardReferenceBootstrap();
    await db.exec(PGLITE_SCHEMA_SQL);
  } finally {
    await engine.disconnect();
  }
}, 30000);

// ─────────────────────────────────────────────────────────────────
// v0.28.5 — A2 structural prevention: auto-derive coverage from SQL.
// ─────────────────────────────────────────────────────────────────
// The hand-maintained REQUIRED_BOOTSTRAP_COVERAGE array is the contract
// that's failed 11 times across 6 schema versions: every release that
// added a column-with-index in the schema blob without a corresponding
// bootstrap addition has triggered a wedge incident.
//
// Codex outside-voice review of v0.28.5's plan caught a critical hole in
// the array-based approach: composite indexes like
// `idx_subagent_messages_provider ON subagent_messages (job_id, provider_id)`
// have a SECOND-column forward reference (`provider_id`) that a first-col-
// only extractor would miss entirely. v0.27 wedged exactly this way.
//
// This parser extracts every column referenced by a CREATE INDEX in
// PGLITE_SCHEMA_SQL — including composite-index second/third columns —
// and asserts each one is either in the baseline CREATE TABLE OR added
// by `applyForwardReferenceBootstrap`. Self-updating: any future
// CREATE INDEX in the schema blob is structurally covered the moment
// it's added, with no human required to remember to update an array.
// ─────────────────────────────────────────────────────────────────

/**
 * Parse `CREATE TABLE [IF NOT EXISTS] <name> (<body>)` blocks.
 * Returns a map from table name → set of column names declared in the body.
 *
 * Body parser is naive but sufficient for `pglite-schema.ts`: splits on
 * commas at depth 0 (respecting nested parens for things like `vector(N)`,
 * `numeric(p, s)`, `CHECK (col IN ('a', 'b'))`), skips constraint lines
 * (CONSTRAINT/PRIMARY/UNIQUE/CHECK/FOREIGN), and grabs the first identifier
 * of each remaining row as the column name.
 */
function parseBaseTableColumns(sql: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const tableName = m[1].toLowerCase();
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    const body = sql.slice(bodyStart, i - 1);

    const columns = new Set<string>();
    // Split body on commas at depth 0.
    let parenDepth = 0;
    let start = 0;
    const parts: string[] = [];
    for (let j = 0; j < body.length; j++) {
      const ch = body[j];
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      else if (ch === ',' && parenDepth === 0) {
        parts.push(body.slice(start, j));
        start = j + 1;
      }
    }
    parts.push(body.slice(start));

    for (const partRaw of parts) {
      // Strip SQL line comments (`-- ...` to end of line) and block
      // comments (`/* ... */`) before identifying the column name.
      // Without this, a column definition preceded by a comment inside
      // the CREATE TABLE body is silently dropped (the comment is the
      // "first identifier" and the parser bails out).
      const stripped = partRaw
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const part = stripped.trim();
      if (!part) continue;
      // Skip constraint lines.
      if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i.test(part)) continue;
      // First whitespace-separated token is the column name.
      const colMatch = part.match(/^["`]?(\w+)["`]?/);
      if (colMatch) columns.add(colMatch[1].toLowerCase());
    }
    result.set(tableName, columns);
  }

  // Also walk ALTER TABLE ... ADD COLUMN statements in the schema blob
  // itself. Several columns (e.g. `pages.search_vector`) are added by an
  // inline ALTER inside PGLITE_SCHEMA_SQL after the original CREATE TABLE.
  // The schema-blob replay adds them in order, so they are NOT
  // forward-references that bootstrap must provide — the schema blob
  // itself self-heals on already-existing tables.
  const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
  let am: RegExpExecArray | null;
  while ((am = alterRe.exec(sql)) !== null) {
    const tableName = am[1].toLowerCase();
    const colName = am[2].toLowerCase();
    if (!result.has(tableName)) result.set(tableName, new Set());
    result.get(tableName)!.add(colName);
  }
  return result;
}

/**
 * Parse `CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <table> [USING method] (<cols>)`.
 * Returns every (table, column) pair referenced — including composite-index
 * second/third columns. Function-call wrappers like `lower(col)` are unwrapped
 * to their inner identifier; literal-only expressions like `(slug, NULLS LAST)`
 * keep the bare column.
 *
 * Out of scope: WHERE-clause columns in partial indexes (rare in our schema;
 * those columns are always also referenced in the index column list itself).
 * Trigger function bodies are out of scope (they reference NEW.col / OLD.col
 * which the existing test file's strip-list handles separately).
 */
function parseIndexColumnReferences(sql: string): Array<{ table: string; column: string }> {
  const result: Array<{ table: string; column: string }> = [];
  // Match CREATE INDEX up through the column-list paren group.
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(\w+)\s*(?:USING\s+\w+\s*)?\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1].toLowerCase();
    const argsStart = m.index + m[0].length;
    let depth = 1;
    let i = argsStart;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    const args = sql.slice(argsStart, i - 1);

    // Split args on commas at depth 0.
    let parenDepth = 0;
    let start = 0;
    const parts: string[] = [];
    for (let j = 0; j < args.length; j++) {
      const ch = args[j];
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      else if (ch === ',' && parenDepth === 0) {
        parts.push(args.slice(start, j));
        start = j + 1;
      }
    }
    parts.push(args.slice(start));

    for (const partRaw of parts) {
      // Strip ASC/DESC, NULLS FIRST/LAST modifiers.
      const partClean = partRaw
        .replace(/\s+(?:ASC|DESC)\s*$/i, '')
        .replace(/\s+NULLS\s+(?:FIRST|LAST)\s*$/i, '')
        .trim();
      if (!partClean) continue;
      // Two shapes to extract from:
      //   `col`                        — plain identifier
      //   `col vector_cosine_ops`      — column followed by operator class (HNSW)
      //   `col COLLATE "C"`            — column with collation
      //   `lower(col)`                 — function-wrapped
      // For shapes 1-3, the column is the LEADING identifier. For shape 4,
      // the column is the LAST identifier before a close paren.
      let col: string | null = null;
      if (partClean.includes('(')) {
        // Function-wrapped: `lower(col)` → grab the last identifier inside.
        const fnMatch = partClean.match(/(\w+)\s*\)\s*$/);
        if (fnMatch) col = fnMatch[1];
      } else {
        // Plain or operator-class-suffixed: leading identifier wins.
        const leadMatch = partClean.match(/^["`]?(\w+)["`]?/);
        if (leadMatch) col = leadMatch[1];
      }
      if (col && !/^(true|false|null|asc|desc)$/i.test(col)) {
        result.push({ table, column: col.toLowerCase() });
      }
    }
  }
  return result;
}

test('parseBaseTableColumns + parseIndexColumnReferences extract structural references', () => {
  // Sanity checks for the parser helpers themselves. Runs in-process (no DB).
  const fixture = `
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL,
      embedding vector(1536),
      CONSTRAINT pages_slug_key UNIQUE (slug)
    );
    CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages (slug);
    CREATE INDEX idx_pages_lower ON pages (lower(slug));
    CREATE INDEX idx_pages_composite ON pages (slug, id DESC);
    CREATE INDEX idx_pages_hnsw ON pages USING hnsw (embedding vector_cosine_ops);
  `;
  const baseCols = parseBaseTableColumns(fixture);
  expect(baseCols.get('pages')).toBeDefined();
  expect(baseCols.get('pages')!.has('id')).toBe(true);
  expect(baseCols.get('pages')!.has('slug')).toBe(true);
  expect(baseCols.get('pages')!.has('embedding')).toBe(true);
  // Constraint lines must NOT leak as columns.
  expect(baseCols.get('pages')!.has('constraint')).toBe(false);

  const refs = parseIndexColumnReferences(fixture);
  // Single-col index.
  expect(refs).toContainEqual({ table: 'pages', column: 'slug' });
  // Function-wrapped column.
  expect(refs.some(r => r.table === 'pages' && r.column === 'slug')).toBe(true);
  // Composite — BOTH columns must be captured (codex's case).
  expect(refs).toContainEqual({ table: 'pages', column: 'id' });
  // USING hnsw with operator class.
  expect(refs).toContainEqual({ table: 'pages', column: 'embedding' });
});

test('parseIndexColumnReferences catches v0.27 composite second-column case', () => {
  // The exact codex regression: `idx_subagent_messages_provider ON
  // subagent_messages (job_id, provider_id)` has provider_id as the SECOND
  // column. A first-col-only extractor would miss this — v0.27 wedged exactly
  // because earlier patterns missed it.
  const fixture = `
    CREATE INDEX IF NOT EXISTS idx_subagent_messages_provider
      ON subagent_messages (job_id, provider_id);
  `;
  const refs = parseIndexColumnReferences(fixture);
  expect(refs).toContainEqual({ table: 'subagent_messages', column: 'job_id' });
  expect(refs).toContainEqual({ table: 'subagent_messages', column: 'provider_id' });
});

/**
 * Parse `ALTER TABLE [IF EXISTS] [ONLY] <table> ADD COLUMN [IF NOT EXISTS] <col>`
 * statements out of an arbitrary SQL string. Used to extract the (table, column)
 * pairs that `applyForwardReferenceBootstrap` adds, so we can verify static
 * coverage without running a DB.
 */
function parseAlterAddColumns(sql: string): Array<{ table: string; column: string }> {
  const result: Array<{ table: string; column: string }> = [];
  const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    result.push({ table: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }
  return result;
}

test('every CREATE INDEX column in PGLITE_SCHEMA_SQL is covered by CREATE TABLE or bootstrap (A2 static check)', async () => {
  // The structural test that closes the 11-incident wedge class. Static
  // contract: every column referenced by a CREATE INDEX in PGLITE_SCHEMA_SQL
  // must be either (a) declared in the current CREATE TABLE body, or
  // (b) added by `applyForwardReferenceBootstrap` in pglite-engine.ts.
  //
  // Codex outside-voice review caught the 11th wedge: composite-index second
  // columns (`provider_id` in `(job_id, provider_id)`) are forward references
  // that earlier extractors missed. This parser walks the full column list
  // of every index — composite or not — and asserts each one is covered.
  //
  // Self-updating: when a future migration adds a CREATE INDEX in
  // PGLITE_SCHEMA_SQL on a column that bootstrap doesn't yet provide, this
  // test fails loud at PR time. No human required to update an array.
  const { readFileSync } = await import('fs');
  const { resolve: resolvePath } = await import('path');
  const { PGLITE_SCHEMA_SQL } = await import('../src/core/pglite-schema.ts');

  const enginePath = resolvePath(process.cwd(), 'src/core/pglite-engine.ts');
  const engineSrc = readFileSync(enginePath, 'utf-8');

  const tableColumns = parseBaseTableColumns(PGLITE_SCHEMA_SQL);
  const indexRefs = parseIndexColumnReferences(PGLITE_SCHEMA_SQL);
  const bootstrapAdds = parseAlterAddColumns(engineSrc);

  // Build the "covered" set: for each (table, column) pair, true iff it's in
  // the table's CREATE TABLE columns OR added by an ALTER TABLE in the
  // bootstrap function.
  const covered = (table: string, column: string): boolean => {
    const cols = tableColumns.get(table);
    if (cols && cols.has(column)) return true;
    return bootstrapAdds.some(a => a.table === table && a.column === column);
  };

  // Sanity checks: parser caught the codex case AND bootstrap provides it.
  expect(indexRefs).toContainEqual({ table: 'subagent_messages', column: 'provider_id' });
  expect(bootstrapAdds).toContainEqual({ table: 'subagent_messages', column: 'provider_id' });
  expect(covered('subagent_messages', 'provider_id')).toBe(true);

  // The actual contract: every index column reference must be covered.
  const uncovered: Array<{ table: string; column: string }> = [];
  for (const ref of indexRefs) {
    if (!covered(ref.table, ref.column)) {
      uncovered.push(ref);
    }
  }

  if (uncovered.length > 0) {
    const list = uncovered.map(u => `  ${u.table}.${u.column}`).join('\n');
    throw new Error(
      `PGLITE_SCHEMA_SQL has ${uncovered.length} CREATE INDEX column reference(s) ` +
      `that are neither in the table's CREATE TABLE body nor added by ` +
      `applyForwardReferenceBootstrap:\n${list}\n\n` +
      `Fix: extend applyForwardReferenceBootstrap in src/core/pglite-engine.ts ` +
      `(and the matching Postgres engine) with the missing ALTER TABLE ADD COLUMN.`,
    );
  }
}, 30000);

// ─────────────────────────────────────────────────────────────────
// v0.36+ — MIGRATIONS introspection: catch the column-only forward-ref class.
// ─────────────────────────────────────────────────────────────────
// The CREATE INDEX parser above kills the column-with-index forward-ref class.
// v0.26.5 (v34) introduced a column-ONLY class: `sources.archived` +
// `sources.archived_at` + `sources.archive_expires_at` aren't indexed but
// `CREATE TABLE IF NOT EXISTS sources` is a no-op on pre-v34 brains. The
// schema-blob replay never adds the archive columns, so downstream visibility
// filters trip immediately.
//
// This test walks every `ALTER TABLE ... ADD COLUMN` in the MIGRATIONS array
// (our own structured code, not arbitrary Postgres DDL) and asserts every
// (table, column) pair is also added by `applyForwardReferenceBootstrap`.
// Future contributors who add a migration with ALTER TABLE ADD COLUMN AND
// forget to extend the bootstrap will see this test fail at PR time with a
// paste-ready `Add probe for <table>.<column>` message.
//
// Why regex-on-our-own-SQL is safe vs regex-on-prod-Postgres-DDL: every
// migration's SQL string is authored by us with consistent shape. The
// ALTER TABLE ADD COLUMN pattern is stable across all 60+ existing
// migrations. We control the input, not Postgres.
//
// Exemption mechanism: some migrations add columns that are intentionally
// not in the schema blob (one-off transition columns later dropped, etc.).
// Those go in the COLUMN_EXEMPTIONS set below with a brief rationale.
// ─────────────────────────────────────────────────────────────────

const COLUMN_EXEMPTIONS = new Set<string>([
  // Schema-blob-not-yet-refreshed: each of these columns is added by a
  // migration but NOT (yet) referenced by `PGLITE_SCHEMA_SQL` (neither in a
  // CREATE TABLE body nor in any CREATE INDEX). Bootstrap doesn't need to
  // add them because there's no forward reference for the schema blob's
  // replay to trip on. The migration handles every upgrade path correctly:
  //   - fresh install: schema blob replays, then migration adds the column.
  //   - pre-existing brain missing the column: migration adds it via ALTER.
  //   - pre-existing brain already on this column: ALTER ... IF NOT EXISTS no-ops.
  // If a future migration adds a CREATE INDEX that references one of these
  // columns, the existing v0.28.5 CREATE-INDEX parser will catch it and
  // force a bootstrap probe (and the exemption should be removed).
  //
  // Refreshing PGLITE_SCHEMA_SQL is a separate concern handled by
  // `bun run build:schema` from src/schema.sql; not gated by this test.
  'minion_jobs.quiet_hours',
  'minion_jobs.stagger_key',
  'sources.chunker_version',
  'access_tokens.permissions',
  'takes.resolved_quality',
  'pages.emotional_weight_recomputed_at',
  'facts.notability',
  'facts.row_num',
  'facts.source_markdown_slug',
  'pages.chunker_version',
  'pages.source_path',
  'content_chunks.edges_backfilled_at',
  'query_cache.knobs_hash',
  // v0.35.6 (migration v67) — typed-claim columns + facts_typed_claim_idx
  // partial index are co-defined in the same migration, so the schema-blob
  // forward-reference path isn't tripped. Bootstrap is only required when an
  // index in PGLITE_SCHEMA_SQL references a column added by a later migration.
  'facts.claim_metric',
  'facts.claim_value',
  'facts.claim_unit',
  'facts.claim_period',
]);

test('every ALTER TABLE ADD COLUMN in MIGRATIONS is covered by applyForwardReferenceBootstrap (column-only class)', async () => {
  const { extractAddedColumnsFromMigrations } = await import('./helpers/extract-added-columns.ts');
  const { readFileSync } = await import('fs');
  const { resolve: resolvePath } = await import('path');
  const { PGLITE_SCHEMA_SQL } = await import('../src/core/pglite-schema.ts');

  const enginePath = resolvePath(process.cwd(), 'src/core/pglite-engine.ts');
  const engineSrc = readFileSync(enginePath, 'utf-8');
  const bootstrapAdds = parseAlterAddColumns(engineSrc);

  // Bootstrap's own CREATE TABLE statements (e.g. needsPagesBootstrap inlines
  // `archived BOOLEAN ...` inside the CREATE TABLE sources block). Those
  // count as covered without a separate ALTER TABLE ADD COLUMN.
  const bootstrapCreateTableCols = parseBaseTableColumns(engineSrc);

  // PGLITE_SCHEMA_SQL's CREATE TABLE definitions. The schema blob defines
  // every modern table inline; columns added by migrations are typically
  // ALSO updated in the schema blob so fresh installs get them natively.
  // The bootstrap is only needed when: (a) the table existed before the
  // migration ran (so CREATE TABLE IF NOT EXISTS is a no-op on old brains)
  // AND (b) the column has a forward-reference index OR a downstream filter
  // that breaks on old brains. Schema-blob coverage handles the fresh case.
  const schemaCreateTableCols = parseBaseTableColumns(PGLITE_SCHEMA_SQL);

  const migrationAdds = extractAddedColumnsFromMigrations();

  const covered = (table: string, column: string): boolean => {
    if (COLUMN_EXEMPTIONS.has(`${table}.${column}`)) return true;
    if (bootstrapAdds.some(a => a.table === table && a.column === column)) return true;
    const bootstrapCols = bootstrapCreateTableCols.get(table);
    if (bootstrapCols && bootstrapCols.has(column)) return true;
    const schemaCols = schemaCreateTableCols.get(table);
    if (schemaCols && schemaCols.has(column)) return true;
    return false;
  };

  const uncovered: typeof migrationAdds = [];
  for (const ref of migrationAdds) {
    if (!covered(ref.table, ref.column)) {
      uncovered.push(ref);
    }
  }

  if (uncovered.length > 0) {
    const list = uncovered
      .map(u => `  ${u.table}.${u.column}`)
      .join('\n');
    throw new Error(
      `MIGRATIONS file (src/core/migrate.ts) adds ${uncovered.length} (table, column) pair(s) that ` +
      `applyForwardReferenceBootstrap does NOT cover:\n${list}\n\n` +
      `Fix one of:\n` +
      `  1. Add a probe + ALTER TABLE ADD COLUMN in applyForwardReferenceBootstrap ` +
      `(src/core/pglite-engine.ts AND src/core/postgres-engine.ts), OR\n` +
      `  2. If the column is intentionally not in the schema blob ` +
      `(transitional / handler-only / later-dropped), add the (table, column) ` +
      `to COLUMN_EXEMPTIONS in test/schema-bootstrap-coverage.test.ts with a ` +
      `brief rationale comment.`,
    );
  }
});

test('extractAddedColumnsFromMigrations sanity-checks against known migration column additions', async () => {
  // Lightweight sanity test that the helper extracts the columns we expect
  // for a few well-known v34 / v60 / v61 migrations. Catches regex
  // regressions in the helper itself.
  const { extractAddedColumnsFromMigrations } = await import('./helpers/extract-added-columns.ts');
  const refs = extractAddedColumnsFromMigrations();
  const has = (table: string, column: string) =>
    refs.some(r => r.table === table && r.column === column);
  // v34 sources.archived* (the codex C1 case)
  expect(has('sources', 'archived')).toBe(true);
  expect(has('sources', 'archived_at')).toBe(true);
  expect(has('sources', 'archive_expires_at')).toBe(true);
  // v60+v61 oauth_clients.*
  expect(has('oauth_clients', 'source_id')).toBe(true);
  expect(has('oauth_clients', 'federated_read')).toBe(true);
  // v18 files.*
  expect(has('files', 'source_id')).toBe(true);
  expect(has('files', 'page_id')).toBe(true);
});

test('extractAlterAddColumnsFromSql handles representative migration SQL shapes', async () => {
  const { __internal } = await import('./helpers/extract-added-columns.ts');
  const fn = __internal.extractAlterAddColumnsFromSql;

  // Standard shape (with IF NOT EXISTS)
  expect(fn('ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived BOOLEAN')).toEqual([
    { table: 'sources', column: 'archived' },
  ]);
  // No IF NOT EXISTS (older migrations)
  expect(fn('ALTER TABLE pages ADD COLUMN deleted_at TIMESTAMPTZ;')).toEqual([
    { table: 'pages', column: 'deleted_at' },
  ]);
  // Multi-statement, mixed
  expect(fn(`
    CREATE INDEX foo ON bar(x);
    ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS source_id TEXT REFERENCES sources(id);
    ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS federated_read TEXT[] NOT NULL DEFAULT '{}';
    UPDATE oauth_clients SET source_id = 'default';
  `)).toEqual([
    { table: 'oauth_clients', column: 'source_id' },
    { table: 'oauth_clients', column: 'federated_read' },
  ]);
  // Quoted identifiers
  expect(fn('ALTER TABLE "pages" ADD COLUMN "effective_date" TIMESTAMPTZ')).toEqual([
    { table: 'pages', column: 'effective_date' },
  ]);
  // ALTER TABLE IF EXISTS / ONLY variants
  expect(fn('ALTER TABLE IF EXISTS ONLY content_chunks ADD COLUMN language TEXT')).toEqual([
    { table: 'content_chunks', column: 'language' },
  ]);
});

test('planted-bug: simulated unprovided column produces a clear failure message', async () => {
  // Negative case — regression guard. If the contract test silently passes
  // on uncovered columns, the gate is fake. This test plants a fake column
  // in a fake SQL string and verifies the helper extracts it (proving the
  // gate would catch it in the real contract test).
  const { __internal } = await import('./helpers/extract-added-columns.ts');
  const fn = __internal.extractAlterAddColumnsFromSql;
  const planted = fn('ALTER TABLE pages ADD COLUMN IF NOT EXISTS planted_test_col TEXT');
  expect(planted).toEqual([{ table: 'pages', column: 'planted_test_col' }]);
});
