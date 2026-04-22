import type { BrainEngine } from './engine.ts';
import { slugifyPath } from './sync.ts';

/**
 * Schema migrations — run automatically on initSchema().
 *
 * Each migration is a version number + idempotent SQL. Migrations are embedded
 * as string constants (Bun's --compile strips the filesystem).
 *
 * Each migration runs in a transaction: if the SQL fails, the version stays
 * where it was and the next run retries cleanly.
 *
 * Migrations can also include a handler function for application-level logic
 * (e.g., data transformations that need TypeScript, not just SQL).
 */

interface Migration {
  version: number;
  name: string;
  /** Engine-agnostic SQL. Used when `sqlFor` is absent. Set to '' for handler-only or sqlFor-only migrations. */
  sql: string;
  /**
   * Engine-specific SQL. If present, overrides `sql` for the matching engine.
   * Needed when Postgres wants CONCURRENTLY but PGLite can't honor it.
   */
  sqlFor?: { postgres?: string; pglite?: string };
  /**
   * When false, the runner does NOT wrap the SQL in `engine.transaction()`.
   * Required for `CREATE INDEX CONCURRENTLY` (which Postgres refuses inside a transaction).
   * Enforced Postgres-only; ignored on PGLite (PGLite has no concurrent writers anyway).
   * Defaults to true.
   */
  transaction?: boolean;
  handler?: (engine: BrainEngine) => Promise<void>;
}

// Migrations are embedded here, not loaded from files.
// Add new migrations at the end. Never modify existing ones.
// Exported for tests that structurally assert migration contents (e.g., "v9 must
// pre-create idx_timeline_dedup_helper before the DELETE..."). Read-only contract.
export const MIGRATIONS: Migration[] = [
  // Version 1 is the baseline (schema.sql creates everything with IF NOT EXISTS).
  {
    version: 2,
    name: 'slugify_existing_pages',
    sql: '',
    handler: async (engine) => {
      const pages = await engine.listPages();
      let renamed = 0;
      for (const page of pages) {
        const newSlug = slugifyPath(page.slug);
        if (newSlug !== page.slug) {
          try {
            await engine.updateSlug(page.slug, newSlug);
            await engine.rewriteLinks(page.slug, newSlug);
            renamed++;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`  Warning: could not rename "${page.slug}" → "${newSlug}": ${msg}`);
          }
        }
      }
      if (renamed > 0) console.log(`  Renamed ${renamed} slugs`);
    },
  },
  {
    version: 3,
    name: 'unique_chunk_index',
    sql: `
      -- Deduplicate any existing duplicate (page_id, chunk_index) rows before adding constraint
      DELETE FROM content_chunks a USING content_chunks b
        WHERE a.page_id = b.page_id AND a.chunk_index = b.chunk_index AND a.id > b.id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
    `,
  },
  {
    version: 4,
    name: 'access_tokens_and_mcp_log',
    sql: `
      CREATE TABLE IF NOT EXISTS access_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT[],
        created_at TIMESTAMPTZ DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS mcp_request_log (
        id SERIAL PRIMARY KEY,
        token_name TEXT,
        operation TEXT NOT NULL,
        latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'success',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    version: 5,
    name: 'minion_jobs_table',
    sql: `
      CREATE TABLE IF NOT EXISTS minion_jobs (
        id               SERIAL PRIMARY KEY,
        name             TEXT        NOT NULL,
        queue            TEXT        NOT NULL DEFAULT 'default',
        status           TEXT        NOT NULL DEFAULT 'waiting',
        priority         INTEGER     NOT NULL DEFAULT 0,
        data             JSONB       NOT NULL DEFAULT '{}',
        max_attempts     INTEGER     NOT NULL DEFAULT 3,
        attempts_made    INTEGER     NOT NULL DEFAULT 0,
        attempts_started INTEGER     NOT NULL DEFAULT 0,
        backoff_type     TEXT        NOT NULL DEFAULT 'exponential',
        backoff_delay    INTEGER     NOT NULL DEFAULT 1000,
        backoff_jitter   REAL        NOT NULL DEFAULT 0.2,
        stalled_counter  INTEGER     NOT NULL DEFAULT 0,
        max_stalled      INTEGER     NOT NULL DEFAULT 5,
        lock_token       TEXT,
        lock_until       TIMESTAMPTZ,
        delay_until      TIMESTAMPTZ,
        parent_job_id    INTEGER     REFERENCES minion_jobs(id) ON DELETE SET NULL,
        on_child_fail    TEXT        NOT NULL DEFAULT 'fail_parent',
        result           JSONB,
        progress         JSONB,
        error_text       TEXT,
        stacktrace       JSONB       DEFAULT '[]',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at       TIMESTAMPTZ,
        finished_at      TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_status CHECK (status IN ('waiting','active','completed','failed','delayed','dead','cancelled','waiting-children')),
        CONSTRAINT chk_backoff_type CHECK (backoff_type IN ('fixed','exponential')),
        CONSTRAINT chk_on_child_fail CHECK (on_child_fail IN ('fail_parent','remove_dep','ignore','continue')),
        CONSTRAINT chk_jitter_range CHECK (backoff_jitter >= 0.0 AND backoff_jitter <= 1.0),
        CONSTRAINT chk_attempts_order CHECK (attempts_made <= attempts_started),
        CONSTRAINT chk_nonnegative CHECK (attempts_made >= 0 AND attempts_started >= 0 AND stalled_counter >= 0 AND max_attempts >= 1 AND max_stalled >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_claim ON minion_jobs (queue, priority ASC, created_at ASC) WHERE status = 'waiting';
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_status ON minion_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_stalled ON minion_jobs (lock_until) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_delayed ON minion_jobs (delay_until) WHERE status = 'delayed';
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent ON minion_jobs(parent_job_id);
    `,
  },
  {
    version: 6,
    name: 'agent_orchestration_primitives',
    sql: `
      -- Token accounting columns
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS tokens_input INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS tokens_output INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS tokens_cache_read INTEGER NOT NULL DEFAULT 0;

      -- Update status constraint to include 'paused'
      ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_status;
      ALTER TABLE minion_jobs ADD CONSTRAINT chk_status
        CHECK (status IN ('waiting','active','completed','failed','delayed','dead','cancelled','waiting-children','paused'));

      -- Inbox table (separate from job row for clean concurrency)
      CREATE TABLE IF NOT EXISTS minion_inbox (
        id          SERIAL PRIMARY KEY,
        job_id      INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
        sender      TEXT NOT NULL,
        payload     JSONB NOT NULL,
        sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        read_at     TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_minion_inbox_unread ON minion_inbox (job_id) WHERE read_at IS NULL;
    `,
  },
  {
    version: 7,
    name: 'agent_parity_layer',
    sql: `
      -- Subagent primitives + BullMQ parity columns
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS max_children INTEGER;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS timeout_ms INTEGER;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS remove_on_complete BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS remove_on_fail BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

      -- Tighten constraints (drop-then-add for idempotency)
      ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_depth_nonnegative;
      ALTER TABLE minion_jobs ADD CONSTRAINT chk_depth_nonnegative CHECK (depth >= 0);
      ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_max_children_positive;
      ALTER TABLE minion_jobs ADD CONSTRAINT chk_max_children_positive CHECK (max_children IS NULL OR max_children > 0);
      ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_timeout_positive;
      ALTER TABLE minion_jobs ADD CONSTRAINT chk_timeout_positive CHECK (timeout_ms IS NULL OR timeout_ms > 0);

      -- Bounded scan for handleTimeouts
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_timeout ON minion_jobs (timeout_at)
        WHERE status = 'active' AND timeout_at IS NOT NULL;

      -- O(children) child-count check in add()
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent_status ON minion_jobs (parent_job_id, status)
        WHERE parent_job_id IS NOT NULL;

      -- Idempotency: enforce "only one job per key" at the DB layer
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_minion_jobs_idempotency ON minion_jobs (idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      -- Fast lookup of child_done messages for readChildCompletions
      CREATE INDEX IF NOT EXISTS idx_minion_inbox_child_done ON minion_inbox (job_id, sent_at)
        WHERE (payload->>'type') = 'child_done';

      -- Attachment manifest (BYTEA inline + forward-compat storage_uri)
      CREATE TABLE IF NOT EXISTS minion_attachments (
        id            SERIAL PRIMARY KEY,
        job_id        INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
        filename      TEXT NOT NULL,
        content_type  TEXT NOT NULL,
        content       BYTEA,
        storage_uri   TEXT,
        size_bytes    INTEGER NOT NULL,
        sha256        TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uniq_minion_attachments_job_filename UNIQUE (job_id, filename),
        CONSTRAINT chk_attachment_storage CHECK (content IS NOT NULL OR storage_uri IS NOT NULL),
        CONSTRAINT chk_attachment_size CHECK (size_bytes >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_minion_attachments_job ON minion_attachments (job_id);

      -- TOAST tuning: store attachment bytes out-of-line, skip compression.
      -- Attachments are usually already-compressed formats; compression burns CPU for no win.
      DO $$
      BEGIN
        ALTER TABLE minion_attachments ALTER COLUMN content SET STORAGE EXTERNAL;
      EXCEPTION WHEN OTHERS THEN
        -- PGLite may not support SET STORAGE EXTERNAL. Storage tuning is an optimization, not correctness.
        NULL;
      END $$;
    `,
  },
  // ── Knowledge graph layer (PR #188, originally proposed as v5/v6/v7 but
  //    renumbered to v8/v9/v10 to land after the master Minions migrations).
  //    Existing brains migrated against the original v5/v6/v7 names (in
  //    branches that pre-dated the merge) get a no-op pass here because
  //    every statement is idempotent.
  {
    version: 8,
    name: 'multi_type_links_constraint',
    // Idempotent for both upgrade and fresh-install paths.
    // Fresh installs already have links_from_to_type_unique from schema.sql; we drop it
    // (along with the legacy from-to-only constraint) before re-adding it cleanly.
    // Helper btree on the dedup columns turns the DELETE...USING self-join from O(n²)
    // into O(n log n). Without it, a brain with 80K+ duplicate link rows hits
    // Supabase Management API's 60s ceiling during upgrade.
    sql: `
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_page_id_to_page_id_key;
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_unique;
      CREATE INDEX IF NOT EXISTS idx_links_dedup_helper
        ON links(from_page_id, to_page_id, link_type);
      DELETE FROM links a USING links b
        WHERE a.from_page_id = b.from_page_id
          AND a.to_page_id = b.to_page_id
          AND a.link_type = b.link_type
          AND a.id > b.id;
      DROP INDEX IF EXISTS idx_links_dedup_helper;
      ALTER TABLE links ADD CONSTRAINT links_from_to_type_unique
        UNIQUE(from_page_id, to_page_id, link_type);
    `,
  },
  {
    version: 9,
    name: 'timeline_dedup_index',
    // Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS handles fresh + upgrade.
    // Dedup any existing duplicates first so the index can be created.
    // Helper btree turns the DELETE...USING self-join from O(n²) into O(n log n).
    // Without it, a brain with 80K+ duplicate timeline rows hits Supabase
    // Management API's 60s ceiling. See migration v8 for the same pattern.
    sql: `
      CREATE INDEX IF NOT EXISTS idx_timeline_dedup_helper
        ON timeline_entries(page_id, date, summary);
      DELETE FROM timeline_entries a USING timeline_entries b
        WHERE a.page_id = b.page_id
          AND a.date = b.date
          AND a.summary = b.summary
          AND a.id > b.id;
      DROP INDEX IF EXISTS idx_timeline_dedup_helper;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup
        ON timeline_entries(page_id, date, summary);
    `,
  },
  {
    version: 10,
    name: 'drop_timeline_search_trigger',
    // Removes the trigger that updates pages.updated_at on every timeline_entries insert.
    // Structured timeline_entries are now graph data (queryable dates), not search text.
    // pages.timeline (markdown) still feeds the page search_vector via trg_pages_search_vector.
    // Removing this trigger also fixes a mutation-induced reordering bug in timeline-extract
    // pagination (listPages ORDER BY updated_at DESC drifted as inserts touched pages).
    sql: `
      DROP TRIGGER IF EXISTS trg_timeline_search_vector ON timeline_entries;
      DROP FUNCTION IF EXISTS update_page_search_vector_from_timeline();
    `,
  },
  {
    version: 11,
    name: 'links_provenance_columns',
    // v0.13: adds provenance columns so frontmatter-derived edges can be
    // distinguished from markdown/manual edges. Reconciliation on put_page
    // scopes by (link_source='frontmatter' AND origin_page_id = written_page)
    // so edges from other pages never get mis-deleted.
    //
    // Unique constraint swaps: old (from, to, type) blocks coexistence of
    // markdown + frontmatter + manual edges with the same tuple. New tuple
    // includes link_source + origin_page_id.
    //
    // Existing rows keep link_source IS NULL (legacy marker) — they are NOT
    // backfilled to 'markdown' because existing rows may be manual/imported
    // /inferred; mislabeling them as markdown would corrupt provenance.
    //
    // Idempotent via IF NOT EXISTS / DROP IF EXISTS.
    sql: `
      -- Postgres version gate: UNIQUE NULLS NOT DISTINCT requires PG15+.
      -- PGLite ships PG17.5, current Supabase is PG15+. Old Supabase projects
      -- on PG14 hit an explicit error rather than half-applying (drop old
      -- constraint but fail to add new one → brain loses uniqueness guarantee).
      DO $$ BEGIN
        IF current_setting('server_version_num')::int < 150000 THEN
          RAISE EXCEPTION
            'v0.13 migration requires Postgres 15+. Current: %. '
            'Upgrade your Postgres (Supabase: migrate project to a newer PG major). '
            'This migration intentionally stops before touching the schema to preserve data integrity.',
            current_setting('server_version');
        END IF;
      END $$;

      ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'links_link_source_check'
        ) THEN
          ALTER TABLE links ADD CONSTRAINT links_link_source_check
            CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual'));
        END IF;
      END $$;
      ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_page_id INTEGER
        REFERENCES pages(id) ON DELETE SET NULL;
      ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_field TEXT;
      -- Backfill NULL link_source → 'markdown' for existing rows. Codex review
      -- caught that without this, pre-v0.13 legacy rows coexist with new
      -- 'markdown' writes under NULLS NOT DISTINCT (NULL ≠ 'markdown'),
      -- causing duplicate edges to accumulate. Treating legacy as markdown
      -- is the accurate best-guess: pre-v0.13 auto-link only emitted markdown
      -- edges. User-created 'manual' edges are a v0.13+ concept anyway.
      UPDATE links SET link_source = 'markdown' WHERE link_source IS NULL;
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_unique;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'links_from_to_type_source_origin_unique'
        ) THEN
          ALTER TABLE links ADD CONSTRAINT links_from_to_type_source_origin_unique
            UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id);
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_links_source ON links(link_source);
      CREATE INDEX IF NOT EXISTS idx_links_origin ON links(origin_page_id);
    `,
  },
  {
    version: 12,
    name: 'budget_ledger',
    // Resolver spend tracker. Primary key {scope, resolver_id, local_date} so
    // midnight rollover in the user's TZ naturally creates a new row instead of
    // mutating yesterday's. reserved_usd and committed_usd track reservations
    // vs actuals so process death between reserve() and commit()/rollback()
    // can be cleaned up by TTL scan. Rollback: DROP TABLE (regenerable from
    // resolver call logs; no durable product data lives here).
    sql: `
      CREATE TABLE IF NOT EXISTS budget_ledger (
        scope          TEXT        NOT NULL,
        resolver_id    TEXT        NOT NULL,
        local_date     DATE        NOT NULL,
        reserved_usd   NUMERIC(12,4) NOT NULL DEFAULT 0,
        committed_usd  NUMERIC(12,4) NOT NULL DEFAULT 0,
        cap_usd        NUMERIC(12,4),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope, resolver_id, local_date)
      );
      CREATE TABLE IF NOT EXISTS budget_reservations (
        reservation_id TEXT        PRIMARY KEY,
        scope          TEXT        NOT NULL,
        resolver_id    TEXT        NOT NULL,
        local_date     DATE        NOT NULL,
        estimate_usd   NUMERIC(12,4) NOT NULL,
        reserved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at     TIMESTAMPTZ NOT NULL,
        status         TEXT        NOT NULL DEFAULT 'held'
      );
      CREATE INDEX IF NOT EXISTS idx_budget_reservations_expires
        ON budget_reservations(expires_at) WHERE status = 'held';
    `,
  },
  {
    version: 13,
    name: 'minion_quiet_hours_stagger',
    // Adds quiet-hours gating + deterministic stagger to Minions.
    sql: `
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS quiet_hours JSONB;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS stagger_key TEXT;
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_stagger_key
        ON minion_jobs(stagger_key) WHERE stagger_key IS NOT NULL;
    `,
  },
  {
    version: 14,
    name: 'pages_updated_at_index',
    // v0.14.1 (fix wave): fixes the 14.6s "list pages newest-first" seqscan on 31k+ row brains.
    // Original report: https://github.com/garrytan/gbrain/issues/170 (PR #215).
    //
    // Engine-aware via handler (not SQL): Postgres uses CREATE INDEX CONCURRENTLY
    // to avoid the write-blocking SHARE lock on `pages`. CONCURRENTLY refuses to
    // run inside a transaction AND postgres.js's multi-statement `.unsafe()` wraps
    // in an implicit transaction, so the handler runs each statement as a separate
    // call. A failed CONCURRENTLY leaves an invalid index with the target name;
    // the handler pre-drops any invalid remnant via pg_index.indisvalid. PGLite
    // has no concurrent writers, so plain CREATE is safe.
    sql: '',
    handler: async (engine) => {
      if (engine.kind === 'postgres') {
        await engine.runMigration(
          14,
          `DO $$ BEGIN
             IF EXISTS (
               SELECT 1 FROM pg_index i
               JOIN pg_class c ON c.oid = i.indexrelid
               WHERE c.relname = 'idx_pages_updated_at_desc' AND NOT i.indisvalid
             ) THEN
               EXECUTE 'DROP INDEX CONCURRENTLY IF EXISTS idx_pages_updated_at_desc';
             END IF;
           END $$;`
        );
        await engine.runMigration(
          14,
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_updated_at_desc
             ON pages (updated_at DESC);`
        );
      } else {
        await engine.runMigration(
          14,
          `CREATE INDEX IF NOT EXISTS idx_pages_updated_at_desc
             ON pages (updated_at DESC);`
        );
      }
    },
  },
  {
    version: 15,
    name: 'minion_jobs_max_stalled_default_5',
    // v0.14.1 (fix wave): fixes https://github.com/garrytan/gbrain/issues/219
    // Shipped default was 1 — first stall = dead-letter, contradicting the
    // "SIGKILL rescued" claim. New default 5. UPDATE backfills existing non-
    // terminal rows so upgrading brains don't keep dead-lettering queued work.
    // Statuses come from MinionJobStatus in types.ts. Row locks serialize
    // against claim()'s FOR UPDATE SKIP LOCKED — race-safe. Idempotent.
    sql: `
      ALTER TABLE minion_jobs ALTER COLUMN max_stalled SET DEFAULT 5;
      UPDATE minion_jobs
         SET max_stalled = 5
       WHERE status IN ('waiting','active','delayed','waiting-children','paused')
         AND max_stalled < 5;
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS.length > 0
  ? MIGRATIONS[MIGRATIONS.length - 1].version
  : 1;

export async function runMigrations(engine: BrainEngine): Promise<{ applied: number; current: number }> {
  const currentStr = await engine.getConfig('version');
  const current = parseInt(currentStr || '1', 10);

  let applied = 0;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      // Pick SQL: engine-specific `sqlFor` wins over engine-agnostic `sql`.
      const sql = m.sqlFor?.[engine.kind] ?? m.sql;

      if (sql) {
        const useTransaction = m.transaction !== false;
        // Non-transactional path is Postgres-only: `CREATE INDEX CONCURRENTLY`
        // refuses to run inside a transaction. PGLite has no concurrent
        // writers, so even if a migration sets transaction:false we wrap it
        // anyway (harmless; keeps behavior consistent).
        if (useTransaction || engine.kind === 'pglite') {
          await engine.transaction(async (tx) => {
            await tx.runMigration(m.version, sql);
          });
        } else {
          // Postgres + transaction:false → direct execution, no BEGIN/COMMIT.
          await engine.runMigration(m.version, sql);
        }
      }

      // Application-level handler (runs outside transaction for flexibility)
      if (m.handler) {
        await m.handler(engine);
      }

      // Update version after both SQL and handler succeed
      await engine.setConfig('version', String(m.version));
      console.log(`  Migration ${m.version} applied: ${m.name}`);
      applied++;
    }
  }

  return { applied, current: applied > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : current };
}
