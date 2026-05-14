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
  /**
   * v0.30.1 (D6): when undefined, treated as `true` for all existing
   * migrations (every migration in the registry uses CREATE ... IF NOT
   * EXISTS / ALTER ... IF NOT EXISTS / INSERT ... ON CONFLICT, so re-running
   * is safe). Explicit `idempotent: false` blocks the verify-hook
   * self-healing path from re-running a destructive migration; the runner
   * surfaces `MigrationDriftError` and requires `--skip-verify` to force.
   *
   * NEW migrations should declare this explicitly; the CONTRIBUTING
   * migration template lists it as required for clarity.
   */
  idempotent?: boolean;
  /**
   * v0.30.1 (D6): post-condition probe. Runs after the migration claims
   * to have applied. Returns false if the actual schema state doesn't
   * match what the migration declared (e.g. column/table/index missing
   * after a partially-committed run on a wedged Supabase pooler).
   *
   * Verify-hook coverage is OPT-IN per migration. Per X3 / codex C6 the
   * v0.30.1 surface ships verify hooks only on a small set of migrations;
   * older migrations rely on `gbrain upgrade --force-schema` for recovery.
   */
  verify?: (engine: BrainEngine) => Promise<boolean>;
}

/**
 * Resolve idempotent classification with the v0.30.1 default. Used by the
 * migration runner's verify path and by the twice-run safety test
 * (test/migrate-idempotent-classify.test.ts).
 */
export function isMigrationIdempotent(m: Migration): boolean {
  // Default true: existing migrations were authored as idempotent (every
  // CREATE/ALTER uses IF NOT EXISTS guards). Explicit false opts out.
  return m.idempotent !== false;
}

/**
 * Migration drift error — verify hook failed and migration is non-idempotent.
 * Caller surfaces the column/table names that diverged and requires
 * `--skip-verify` to force re-run.
 */
export class MigrationDriftError extends Error {
  constructor(
    public readonly version: number,
    public readonly migrationName: string,
    public readonly hint: string,
  ) {
    super(`Migration v${version} (${migrationName}) verify failed: ${hint}`);
    this.name = 'MigrationDriftError';
  }
}

/**
 * Retry-exhausted envelope (v0.30.1 / Finding F2). Surface the most recent
 * idle blockers we observed so the user has a paste-ready
 * pg_terminate_backend(<pid>) command.
 */
export class MigrationRetryExhausted extends Error {
  constructor(
    public readonly version: number,
    public readonly migrationName: string,
    public readonly attempts: number,
    public readonly lastBlockers: IdleBlocker[],
    public readonly lastError: Error,
  ) {
    const lastB = lastBlockers[0];
    const hint = lastB
      ? `PID ${lastB.pid} idle since ${lastB.query_start} likely holds the lock; run: psql ... -c "SELECT pg_terminate_backend(${lastB.pid})"`
      : 'No idle-in-transaction blockers detected; check pg_locks for active waiters and ~/.gbrain/audit/connection-events-*.jsonl';
    super(
      `Migration v${version} (${migrationName}) failed after ${attempts} attempts. ${hint}. Original: ${lastError.message}`
    );
    this.name = 'MigrationRetryExhausted';
  }
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
    version: 23,
    name: 'files_source_id_page_id_ledger',
    // v0.18.0 Step 7 (Lane E) — additive only: adds files.source_id and
    // files.page_id columns + creates the file_migration_ledger that
    // drives phase-B storage object rewrites. Does NOT drop page_slug
    // yet (kept for backward compat; a later release cleans up once the
    // page_id FK is proven). PGLite has no files table, so this
    // migration is Postgres-only via a handler gate.
    //
    // Ledger PK is file_id (not storage_path_old) — two sources CAN
    // share an old path during migration, so a composite would be
    // wrong. Codex second-pass review caught this.
    //
    // State machine per row:
    //   pending → copy_done → db_updated → complete
    //   any state → failed (with error detail)
    //
    // Phase B in the v0_18_0 orchestrator processes `status != complete`
    // rows. Re-runnable: resumes from whichever state it stopped in.
    sql: '',
    handler: async (engine) => {
      if (engine.kind === 'pglite') return;

      // Atomic: FK drop + UNIQUE swap + files.page_id addition +
      // backfill + ledger, all in one transaction. Closes the
      // pre-v23 integrity window where files_page_slug_fkey was
      // dropped in v21 but the replacement files.page_id didn't
      // exist until v23 ran — process death in between left files
      // unconstrained while file_upload kept writing (codex finding).
      //
      // Rollback scenarios:
      //   - Die mid-transaction → Postgres rolls back, files_page_slug_fkey
      //     still exists, config.version stays at 22. Retry restarts cleanly.
      //   - Die after commit but before setConfig(version=23) → all DDL
      //     committed, config.version still 22, retry re-runs everything
      //     with IF NOT EXISTS / NOT EXISTS guards idempotently.
      await engine.transaction(async (tx) => {
        // 0a. Drop files_page_slug_fkey (deferred from v21 to keep
        //     the FK intact across v21/v22 and remove it inside the
        //     same txn that adds the replacement page_id path).
        //     Guard against PGLite just in case (already returned above).
        await tx.runMigration(23, `
          DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'files') THEN
              ALTER TABLE files DROP CONSTRAINT IF EXISTS files_page_slug_fkey;
            END IF;
          END $$;
        `);

        // 0b. Swap pages.UNIQUE(slug) → UNIQUE(source_id, slug).
        //     Deferred from v21 so PR #356 closes the integrity
        //     window. PGLite already did this swap in its v21 path.
        await tx.runMigration(23, `
          ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_slug_key;
          DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'pages_source_slug_key'
            ) THEN
              ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key
                UNIQUE (source_id, slug);
            END IF;
          END $$;
        `);

        // 1a. source_id with DEFAULT 'default' (idempotent)
        await tx.runMigration(23, `
          ALTER TABLE files ADD COLUMN IF NOT EXISTS source_id TEXT
            NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;
          CREATE INDEX IF NOT EXISTS idx_files_source_id ON files(source_id);

          -- 1a'. Defensive FK repair. ALTER TABLE ADD COLUMN IF NOT EXISTS is a
          --      no-op when the column already exists, so the inline FK never
          --      re-adds. Some test paths (notably postgres-bootstrap.test.ts)
          --      drop the sources table CASCADE which removes
          --      files_source_id_fkey while leaving files.source_id intact.
          --      Without this block the FK would never come back on upgrade,
          --      and CASCADE-on-source-delete silently stops working.
          DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'files_source_id_fkey'
                AND conrelid = 'files'::regclass
            ) THEN
              ALTER TABLE files
                ADD CONSTRAINT files_source_id_fkey
                FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE;
            END IF;
          END $$;

          -- 1b. page_id (nullable; pre-v0.17 files pointed at page_slug
          --     which was ON DELETE SET NULL, so we keep the same nullable
          --     semantic — orphaned files are legal).
          ALTER TABLE files ADD COLUMN IF NOT EXISTS page_id INTEGER
            REFERENCES pages(id) ON DELETE SET NULL;
          CREATE INDEX IF NOT EXISTS idx_files_page_id ON files(page_id);
        `);

        // 1c. Backfill page_id from existing page_slug. Scoped to
        //     source_id='default' because pre-v0.17 pages ALL lived in
        //     the default source. Without this scope, after new sources
        //     get added mid-migration, the JOIN could hit the wrong
        //     page (different source, same slug).
        await tx.runMigration(23, `
          UPDATE files f
             SET page_id = p.id
            FROM pages p
           WHERE f.page_slug = p.slug
             AND p.source_id = 'default'
             AND f.page_id IS NULL;
        `);

        // 2. file_migration_ledger — drives the storage object rewrite
        //    in the v0_18_0 orchestrator's phase B. Seeded from current
        //    files rows; re-seed is idempotent via NOT EXISTS guard.
        await tx.runMigration(23, `
          CREATE TABLE IF NOT EXISTS file_migration_ledger (
            file_id           INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
            storage_path_old  TEXT   NOT NULL,
            storage_path_new  TEXT   NOT NULL,
            status            TEXT   NOT NULL DEFAULT 'pending',
            error             TEXT,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT chk_ledger_status CHECK (status IN ('pending','copy_done','db_updated','complete','failed'))
          );
          CREATE INDEX IF NOT EXISTS idx_file_migration_ledger_status
            ON file_migration_ledger(status) WHERE status != 'complete';

          -- Seed the ledger with every existing file. New path prefixes
          -- source_id so multi-source can land assets under their own
          -- bucket path without collision.
          INSERT INTO file_migration_ledger (file_id, storage_path_old, storage_path_new, status)
          SELECT
            f.id,
            f.storage_path,
            COALESCE(f.source_id, 'default') || '/' || f.storage_path,
            'pending'
          FROM files f
          WHERE NOT EXISTS (
            SELECT 1 FROM file_migration_ledger l WHERE l.file_id = f.id
          );
        `);
      });
    },
  },
  {
    version: 22,
    name: 'links_resolution_type',
    // v0.18.0 Step 4 (Lane B) — adds links.resolution_type column so
    // each edge records whether its target source was pinned at
    // extraction time via `[[source:slug]]` (qualified) or resolved
    // via local-first fallback (unqualified). Unqualified edges are
    // candidates for re-resolution via `gbrain extract
    // --refresh-unqualified` when the source topology changes.
    //
    // Nullable because legacy edges (pre-v0.17) have no resolution
    // concept. `frontmatter` and `manual` edges remain NULL — they're
    // not subject to staleness under source churn.
    sql: `
      ALTER TABLE links ADD COLUMN IF NOT EXISTS resolution_type TEXT;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'links_resolution_type_check'
        ) THEN
          ALTER TABLE links ADD CONSTRAINT links_resolution_type_check
            CHECK (resolution_type IS NULL OR resolution_type IN ('qualified', 'unqualified'));
        END IF;
      END $$;
    `,
  },
  {
    version: 21,
    name: 'pages_source_id_composite_unique',
    // v0.18.0 Step 2 (Lane B) — adds pages.source_id. Engine-split after
    // codex caught the pre-v23 integrity window:
    //
    //   Original v21 dropped files_page_slug_fkey and swapped
    //   UNIQUE(slug) → UNIQUE(source_id, slug) in one go. Between v21
    //   committing and v23 (which adds the replacement files.page_id
    //   path), a process-death left files WITHOUT any FK to pages
    //   while file_upload / `gbrain files` kept accepting writes.
    //
    // On Postgres: additive-only here. The FK drop + UNIQUE swap move
    // into v23's handler (wrapped in engine.transaction) so they commit
    // atomically with the files.page_id addition + backfill. See v23.
    //
    // On PGLite: no concurrent writers, no pool, no partial-state risk.
    // Do the full add + swap here so PGLite brains reach the composite
    // unique immediately (PGLite has no files table, so no FK drop
    // needed).
    //
    // DEFAULT 'default' on source_id is load-bearing: closes the race
    // where an INSERT between ADD COLUMN and SET NOT NULL could leave
    // source_id NULL. The default already references a valid sources
    // row (seeded in v16), so new INSERTs immediately get a valid FK.
    sql: '',
    sqlFor: {
      postgres: `
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_id TEXT
          NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;

        CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
      `,
      pglite: `
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_id TEXT
          NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;

        CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);

        ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_slug_key;
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'pages_source_slug_key'
          ) THEN
            ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key
              UNIQUE (source_id, slug);
          END IF;
        END $$;
      `,
    },
  },
  {
    version: 20,
    name: 'sources_table_additive',
    // v0.18.0 Step 1 (Lane A) — **additive only** so Step 1 is a safe
    // standalone commit. This migration installs the sources primitive
    // WITHOUT breaking the engine's existing ON CONFLICT (slug) upserts.
    //
    // What this migration does now:
    //   - CREATE sources table
    //   - INSERT default source (federated=true, inherits sync.repo_path
    //     and sync.last_commit from config so post-upgrade identity is
    //     preserved)
    //
    // What this migration does NOT do yet (deferred to v17 which ships
    // with Step 2 engine rewrite, so they land atomically):
    //   - ALTER pages ADD source_id
    //   - DROP UNIQUE(slug) + ADD UNIQUE(source_id, slug)
    //   - files.page_slug → page_id rewrite
    //   - file_migration_ledger
    //   - links.resolution_type
    //
    // The v0.18.0 orchestrator's phaseCVerify allows this split: it
    // checks for sources('default'), but the "composite UNIQUE" +
    // "pages.source_id NOT NULL" assertions only run after v17 lands.
    //
    // Idempotent via IF NOT EXISTS. Safe to re-run.
    sql: `
      CREATE TABLE IF NOT EXISTS sources (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        local_path    TEXT,
        last_commit   TEXT,
        last_sync_at  TIMESTAMPTZ,
        config        JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Seed 'default' source, inheriting the existing sync.repo_path /
      -- sync.last_commit config values. federated=true for backward compat.
      -- Pre-v0.17 brains behave exactly as before.
      INSERT INTO sources (id, name, local_path, last_commit, config)
      SELECT
        'default',
        'default',
        (SELECT value FROM config WHERE key = 'sync.repo_path'),
        (SELECT value FROM config WHERE key = 'sync.last_commit'),
        '{"federated": true}'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM sources WHERE id = 'default');
    `,
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
  {
    version: 16,
    name: 'cycle_locks_table',
    // v0.17 brain maintenance cycle (runCycle primitive).
    // PgBouncer transaction pooling strips session-scoped advisory locks
    // (pg_try_advisory_lock) across connection checkouts, so we can't use
    // them as the cycle-coordination primitive. A row with a TTL works
    // through every pooler: any backend can SELECT/UPDATE/DELETE it, no
    // session state required.
    //
    // Acquire: INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE ttl_expires_at < NOW()
    //          returning ... — empty RETURNING = lock held by live holder.
    // Refresh: UPDATE ... SET ttl_expires_at = NOW() + interval '30 min'
    //          WHERE id = 'gbrain-cycle' AND holder_pid = <my pid> — between phases.
    // Release: DELETE WHERE id = 'gbrain-cycle' AND holder_pid = <my pid>.
    sql: `
      CREATE TABLE IF NOT EXISTS gbrain_cycle_locks (
        id TEXT PRIMARY KEY,
        holder_pid INT NOT NULL,
        holder_host TEXT,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ttl_expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cycle_locks_ttl ON gbrain_cycle_locks(ttl_expires_at);
    `,
  },
  {
    version: 24,
    name: 'rls_backfill_missing_tables',
    // v0.18.1 RLS hardening: 10 gbrain-managed public tables shipped
    // without RLS enabled (access_tokens, mcp_request_log, minion_inbox,
    // minion_attachments, subagent_messages, subagent_tool_executions,
    // subagent_rate_leases, gbrain_cycle_locks, budget_ledger,
    // budget_reservations). Supabase exposes the public schema via
    // PostgREST, so tables without RLS are readable by anyone with the
    // anon key.
    //
    // Numbered v24 to slot after v0.18.0's v20-v23 sources-migration
    // wave. The 'sources' and 'file_migration_ledger' tables added in
    // v0.18.0 already get RLS from schema.sql's base DO block; v24
    // backfills the 10 older tables that never had it.
    //
    // Gated on BYPASSRLS matching the pattern in schema.sql: enabling RLS
    // on a table in a session that does NOT hold BYPASSRLS would lock
    // the session out of its own data. RAISE WARNING is visible to the
    // migration runner's log stream.
    sql: `
      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
        IF NOT has_bypass THEN
          -- Fail the migration loudly instead of WARNING + version-bump.
          -- The runner unconditionally records schema_version on success,
          -- so a silent WARNING here would permanently lock the backfill out
          -- on future runs even after switching to a bypass role. Raising
          -- aborts the transaction, leaves schema_version at the prior value,
          -- and lets the next invocation retry after the role is fixed.
          RAISE EXCEPTION 'v24 rls_backfill_missing_tables: role % does not have BYPASSRLS privilege — cannot enable RLS safely. Re-run as postgres (or another BYPASSRLS role). The migration will retry automatically on the next initSchema call.', current_user;
        END IF;

        -- These 8 are guaranteed to exist: schema.sql creates them (idempotent
        -- via IF NOT EXISTS) on every initSchema call, and initSchema runs
        -- before this migration. Bare ALTER TABLE is safe.
        ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
        ALTER TABLE mcp_request_log ENABLE ROW LEVEL SECURITY;
        ALTER TABLE minion_inbox ENABLE ROW LEVEL SECURITY;
        ALTER TABLE minion_attachments ENABLE ROW LEVEL SECURITY;
        ALTER TABLE subagent_messages ENABLE ROW LEVEL SECURITY;
        ALTER TABLE subagent_tool_executions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE subagent_rate_leases ENABLE ROW LEVEL SECURITY;
        ALTER TABLE gbrain_cycle_locks ENABLE ROW LEVEL SECURITY;

        -- budget_ledger + budget_reservations are migration-only (v12). Not
        -- in schema.sql, not re-created on every initSchema. In normal flow
        -- v12 runs before v24 so they exist, but if an operator manually
        -- dropped them (unusual — budget data is regenerable from resolver
        -- logs) or was pinned to a pre-v12 gbrain version when the table
        -- went away, the bare ALTER would fail with 42P01 and abort v24.
        -- information_schema.tables lookup makes the statement self-healing.
        IF EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'budget_ledger') THEN
          ALTER TABLE budget_ledger ENABLE ROW LEVEL SECURITY;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'budget_reservations') THEN
          ALTER TABLE budget_reservations ENABLE ROW LEVEL SECURITY;
        END IF;

        RAISE NOTICE 'v24: RLS backfill complete (role % has BYPASSRLS)', current_user;
      END $$;
    `,
    // PGLite has no RLS engine and is intrinsically single-tenant (local file).
    // The 8 ALTER TABLE ... ENABLE ROW LEVEL SECURITY statements above also
    // target tables that may not exist on PGLite (subagent_*, minion_inbox),
    // since pglite-schema.ts is the canonical PGLite schema source. No-op
    // override keeps PGLite upgrades unwedged and the version bump intact.
    sqlFor: {
      pglite: '',
    },
  },
  {
    version: 25,
    name: 'pages_page_kind',
    // v0.19.0 Layer 3 — pages.page_kind distinguishes markdown vs code pages
    // at the DB level. Needed so orphans filter, link-extraction auto-link,
    // and query --lang can branch on kind without sniffing `type` or chunk
    // metadata. Existing rows backfill to 'markdown' (pre-v0.19.0 all pages
    // were markdown).
    //
    // Postgres: ADD COLUMN with DEFAULT is O(1) for nullable columns (no
    // rewrite). The CHECK constraint is added NOT VALID so the initial
    // statement does not scan the table, then VALIDATE CONSTRAINT runs
    // separately. Tables with millions of pages would otherwise hold a
    // write lock during the full scan.
    sqlFor: {
      postgres: `
        ALTER TABLE pages
          ADD COLUMN IF NOT EXISTS page_kind TEXT NOT NULL DEFAULT 'markdown';

        ALTER TABLE pages
          DROP CONSTRAINT IF EXISTS pages_page_kind_check;
        ALTER TABLE pages
          ADD CONSTRAINT pages_page_kind_check
          CHECK (page_kind IN ('markdown','code')) NOT VALID;
        ALTER TABLE pages VALIDATE CONSTRAINT pages_page_kind_check;
      `,
      pglite: `
        ALTER TABLE pages
          ADD COLUMN IF NOT EXISTS page_kind TEXT NOT NULL DEFAULT 'markdown'
          CHECK (page_kind IN ('markdown','code'));
      `,
    },
    sql: `
      ALTER TABLE pages
        ADD COLUMN IF NOT EXISTS page_kind TEXT NOT NULL DEFAULT 'markdown'
        CHECK (page_kind IN ('markdown','code'));
    `,
  },
  {
    version: 26,
    name: 'content_chunks_code_metadata',
    // v0.19.0 Layer 3 — content_chunks gains code-specific metadata columns
    // so C6 (query --lang), C7 (code-def / code-refs), and the new
    // searchCodeChunks engine method can filter + surface symbol context
    // without parsing chunk_text.
    //
    // All new columns are nullable — existing markdown chunks carry NULL.
    // importCodeFile populates them from the tree-sitter AST.
    //
    // Partial indexes (WHERE <col> IS NOT NULL) keep the index small: a
    // brain with 20K markdown chunks + 20K code chunks indexes only the
    // code chunks for symbol lookups. Measured ~200ms → ~15ms on code-refs.
    sql: `
      ALTER TABLE content_chunks
        ADD COLUMN IF NOT EXISTS language TEXT,
        ADD COLUMN IF NOT EXISTS symbol_name TEXT,
        ADD COLUMN IF NOT EXISTS symbol_type TEXT,
        ADD COLUMN IF NOT EXISTS start_line INTEGER,
        ADD COLUMN IF NOT EXISTS end_line INTEGER;

      CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name
        ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_chunks_language
        ON content_chunks(language) WHERE language IS NOT NULL;
    `,
  },
  {
    version: 27,
    name: 'cathedral_ii_foundation',
    // v0.20.0 Cathedral II Layer 1 — schema-only foundation.
    //
    // Lands BEFORE any consumer layer to eliminate forward references
    // (codex SP-4). All Cathedral II DDL arrives here as one atomic
    // transaction:
    //
    //   1. content_chunks gains 4 columns:
    //      - parent_symbol_path TEXT[]   — scope chain for nested symbols (A3)
    //      - doc_comment TEXT            — extracted JSDoc/docstring (A4)
    //      - symbol_name_qualified TEXT  — 'Admin::UsersController#render' (A1)
    //      - search_vector TSVECTOR      — chunk-grain FTS (Layer 1b)
    //
    //   2. sources.chunker_version TEXT — SP-1 gate. performSync forces
    //      full walk on mismatch with CURRENT_CHUNKER_VERSION, bypassing
    //      the up_to_date git-HEAD early-return that made the bare
    //      CHUNKER_VERSION bump a silent no-op.
    //
    //   3. code_edges_chunk — resolved call-graph / type-ref edges.
    //      FK CASCADE from content_chunks on both endpoints; deleting a
    //      chunk wipes its edges. UNIQUE (from, to, edge_type) holds
    //      idempotency. source_id TEXT matches sources.id actual type
    //      (codex F4). Source scoping is enforced in resolution logic,
    //      not in the key, because from_chunk_id → pages.source_id
    //      already determines it.
    //
    //   4. code_edges_symbol — unresolved refs. Target symbol is known
    //      by qualified name but the defining chunk hasn't been imported
    //      yet. Rows UNION with code_edges_chunk on read (codex 1.3b);
    //      no promotion step.
    //
    //   5. update_chunk_search_vector trigger — BEFORE INSERT/UPDATE
    //      OF (chunk_text, doc_comment, symbol_name_qualified). Builds
    //      search_vector with weight A on doc_comment + symbol_name_qualified,
    //      B on chunk_text. Natural-language queries rank doc-comment hits
    //      above body-text hits (A4 intent).
    //
    // Consumer layers (Layer 5 A1, Layer 6 A3, Layer 10 C CLI, Layer 12
    // CHUNKER_VERSION bump, Layer 13 E2 reindex-code) all depend on this
    // foundation. Absent it, every downstream layer would have forward
    // refs.
    sql: `
      -- content_chunks: new Cathedral II columns
      ALTER TABLE content_chunks
        ADD COLUMN IF NOT EXISTS parent_symbol_path TEXT[],
        ADD COLUMN IF NOT EXISTS doc_comment TEXT,
        ADD COLUMN IF NOT EXISTS symbol_name_qualified TEXT,
        ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

      CREATE INDEX IF NOT EXISTS idx_chunks_search_vector
        ON content_chunks USING GIN(search_vector);
      CREATE INDEX IF NOT EXISTS idx_chunks_symbol_qualified
        ON content_chunks(symbol_name_qualified) WHERE symbol_name_qualified IS NOT NULL;

      -- sources: SP-1 chunker_version gate
      ALTER TABLE sources
        ADD COLUMN IF NOT EXISTS chunker_version TEXT;

      -- code_edges_chunk: resolved edges
      CREATE TABLE IF NOT EXISTS code_edges_chunk (
        id                    SERIAL PRIMARY KEY,
        from_chunk_id         INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
        to_chunk_id           INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
        from_symbol_qualified TEXT NOT NULL,
        to_symbol_qualified   TEXT NOT NULL,
        edge_type             TEXT NOT NULL,
        edge_metadata         JSONB NOT NULL DEFAULT '{}',
        source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT code_edges_chunk_unique UNIQUE (from_chunk_id, to_chunk_id, edge_type)
      );

      CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_from
        ON code_edges_chunk(from_chunk_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_to
        ON code_edges_chunk(to_chunk_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_to_symbol
        ON code_edges_chunk(to_symbol_qualified, edge_type);

      -- code_edges_symbol: unresolved refs
      CREATE TABLE IF NOT EXISTS code_edges_symbol (
        id                    SERIAL PRIMARY KEY,
        from_chunk_id         INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
        from_symbol_qualified TEXT NOT NULL,
        to_symbol_qualified   TEXT NOT NULL,
        edge_type             TEXT NOT NULL,
        edge_metadata         JSONB NOT NULL DEFAULT '{}',
        source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT code_edges_symbol_unique UNIQUE (from_chunk_id, to_symbol_qualified, edge_type)
      );

      CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_from
        ON code_edges_symbol(from_chunk_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_to
        ON code_edges_symbol(to_symbol_qualified, edge_type);

      -- Chunk-grain FTS trigger (Layer 1b consumer — column exists from this
      -- migration, trigger installed now so newly-written chunks get vectors
      -- from day one). NULL-safe: markdown chunks leave doc_comment and
      -- symbol_name_qualified NULL; COALESCE('') keeps the vector build
      -- from failing on missing weights.
      CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER AS $fn$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', COALESCE(NEW.doc_comment, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.symbol_name_qualified, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.chunk_text, '')), 'B');
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS chunk_search_vector_trigger ON content_chunks;
      CREATE TRIGGER chunk_search_vector_trigger
        BEFORE INSERT OR UPDATE OF chunk_text, doc_comment, symbol_name_qualified
        ON content_chunks
        FOR EACH ROW EXECUTE FUNCTION update_chunk_search_vector();
    `,
  },
  {
    version: 28,
    name: 'cathedral_ii_chunk_fts_backfill',
    // v0.20.0 Cathedral II Layer 3 (1b) — backfill content_chunks.search_vector
    // for rows inserted before v27 ran. The v27 trigger only fires on
    // INSERT/UPDATE, so every chunk that existed before upgrade has a NULL
    // search_vector and would match zero rows in the new chunk-grain
    // searchKeyword. Compute the vector in-place here so upgraded brains
    // have full keyword coverage the moment v28 commits — no need to wait
    // for every page to get touched by sync.
    //
    // Direct vector compute (not UPDATE chunk_text = chunk_text to trigger):
    //   - UPDATE-to-same-value fires the trigger unconditionally on Postgres
    //     even if no column value changes, so trigger-based backfill DOES
    //     work, but writing the vector directly is cheaper (single pass
    //     instead of trigger overhead per row).
    //   - Idempotent via `WHERE search_vector IS NULL` — re-running v28
    //     after a partial run picks up only the remaining NULL rows.
    //
    // On a 20K-chunk brain: ~2-3s total. No blocking concerns: chunks are
    // append-only in steady state; the UPDATE takes a row lock per chunk
    // briefly while computing the tsvector.
    sql: `
      UPDATE content_chunks
      SET search_vector =
        setweight(to_tsvector('english', COALESCE(doc_comment, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(symbol_name_qualified, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(chunk_text, '')), 'B')
      WHERE search_vector IS NULL;
    `,
  },
  {
    version: 29,
    name: 'cathedral_ii_code_edges_rls',
    // v0.21.0 Cathedral II — RLS hardening for the two new tables added by
    // v27 (code_edges_chunk, code_edges_symbol). The v24 RLS-backfill
    // pattern: gated on BYPASSRLS (so we don't lock the migrating session
    // out of its own data on a non-bypass role) + bare ALTER TABLE since
    // both tables are guaranteed to exist after v27.
    //
    // Postgres-only via sqlFor: PGLite doesn't enforce RLS the same way
    // and v24 already runs only against Postgres in practice. The E2E
    // test "RLS is enabled on every public table" runs against Docker
    // postgres exclusively and was failing because v27 created the new
    // tables without RLS enabled.
    sqlFor: {
      postgres: `
        DO $$
        DECLARE
          has_bypass BOOLEAN;
        BEGIN
          SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
          IF NOT has_bypass THEN
            RAISE EXCEPTION 'v29 cathedral_ii_code_edges_rls: role % does not have BYPASSRLS privilege — cannot enable RLS safely. Re-run as postgres (or another BYPASSRLS role). The migration will retry automatically on the next initSchema call.', current_user;
          END IF;

          ALTER TABLE code_edges_chunk ENABLE ROW LEVEL SECURITY;
          ALTER TABLE code_edges_symbol ENABLE ROW LEVEL SECURITY;

          RAISE NOTICE 'v29: code_edges RLS enabled (role % has BYPASSRLS)', current_user;
        END $$;
      `,
      pglite: `-- PGLite: no-op. RLS check runs only against Postgres E2E.`,
    },
    sql: '',
  },
  // NOTE: v37 + v38 are the v0.28 takes migrations. Renumbered four times during
  // the long-lived v0.28 branch as master shipped:
  //   v0.28 originally targeted v31/v32
  //   master v0.25 claimed v31 (eval_capture_tables) → renumbered to v32/v33
  //   master v0.26 claimed v32 (oauth_infrastructure) and v33
  //     (admin_dashboard_columns_v0_26_3) → renumbered to v34/v35
  //   master v0.26.5 claimed v34 (destructive_guard_columns) → renumbered to v35/v36
  //   master v0.26.8 + v0.27 claimed v35 (auto_rls_event_trigger) and v36
  //     (subagent_provider_neutral_persistence_v0_27) → renumbered to v37/v38
  // Runtime sort by version ascending means source-order doesn't matter.
  {
    version: 37,
    name: 'takes_and_synthesis_evidence',
    // v0.28: typed/weighted/attributed claims ("takes") + synthesis provenance.
    // Spec: docs/designs (CEO plan) + plan file. Schema decisions:
    //   - page_id FK (not page_slug) — pages.slug is unique only within source
    //   - (page_id, row_num) is the natural unique key (composite, append-only)
    //   - synthesis_evidence FK ON DELETE CASCADE — when a source take is hard-deleted,
    //     provenance rows go with it; synthesis renderer marks citations as removed
    //   - HNSW index on embedding (pgvector 0.7+ supports both Postgres + PGLite)
    //   - resolved_* columns ship now per CEO-review D4 + Codex P1 #13 (immutable)
    sql: `
      CREATE TABLE IF NOT EXISTS takes (
        id               BIGSERIAL PRIMARY KEY,
        page_id          INTEGER     NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        row_num          INTEGER     NOT NULL,
        claim            TEXT        NOT NULL,
        kind             TEXT        NOT NULL CHECK (kind IN ('fact','take','bet','hunch')),
        holder           TEXT        NOT NULL,
        weight           REAL        NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
        since_date       TEXT,
        until_date       TEXT,
        source           TEXT,
        superseded_by    INTEGER,
        active           BOOLEAN     NOT NULL DEFAULT TRUE,
        resolved_at      TIMESTAMPTZ,
        resolved_outcome BOOLEAN,
        resolved_value   REAL,
        resolved_unit    TEXT,
        resolved_source  TEXT,
        resolved_by      TEXT,
        embedding        VECTOR(1536),
        embedded_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT takes_page_row_key UNIQUE (page_id, row_num)
      );
      CREATE INDEX IF NOT EXISTS idx_takes_page          ON takes(page_id);
      CREATE INDEX IF NOT EXISTS idx_takes_kind_active   ON takes(kind)   WHERE active;
      CREATE INDEX IF NOT EXISTS idx_takes_holder_active ON takes(holder) WHERE active;
      CREATE INDEX IF NOT EXISTS idx_takes_weight_active ON takes(weight DESC) WHERE active;
      CREATE INDEX IF NOT EXISTS idx_takes_resolved_at   ON takes(resolved_at) WHERE resolved_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_takes_embedding_hnsw ON takes
        USING hnsw (embedding vector_cosine_ops)
        WHERE active AND embedding IS NOT NULL;

      CREATE TABLE IF NOT EXISTS synthesis_evidence (
        synthesis_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        take_page_id      INTEGER NOT NULL,
        take_row_num      INTEGER NOT NULL,
        citation_index    INTEGER NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (synthesis_page_id, take_page_id, take_row_num),
        FOREIGN KEY (take_page_id, take_row_num)
          REFERENCES takes(page_id, row_num) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_synthesis_evidence_take
        ON synthesis_evidence(take_page_id, take_row_num);

      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
        IF has_bypass THEN
          ALTER TABLE takes              ENABLE ROW LEVEL SECURITY;
          ALTER TABLE synthesis_evidence ENABLE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `,
    sqlFor: {
      // PGLite: same DDL minus the RLS DO-block (no rolbypassrls). Same HNSW
      // index syntax — pgvector 0.7+ supports it. Same FK semantics.
      pglite: `
        CREATE TABLE IF NOT EXISTS takes (
          id               BIGSERIAL PRIMARY KEY,
          page_id          INTEGER     NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          row_num          INTEGER     NOT NULL,
          claim            TEXT        NOT NULL,
          kind             TEXT        NOT NULL CHECK (kind IN ('fact','take','bet','hunch')),
          holder           TEXT        NOT NULL,
          weight           REAL        NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
          since_date       TEXT,
          until_date       TEXT,
          source           TEXT,
          superseded_by    INTEGER,
          active           BOOLEAN     NOT NULL DEFAULT TRUE,
          resolved_at      TIMESTAMPTZ,
          resolved_outcome BOOLEAN,
          resolved_value   REAL,
          resolved_unit    TEXT,
          resolved_source  TEXT,
          resolved_by      TEXT,
          embedding        VECTOR(1536),
          embedded_at      TIMESTAMPTZ,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT takes_page_row_key UNIQUE (page_id, row_num)
        );
        CREATE INDEX IF NOT EXISTS idx_takes_page          ON takes(page_id);
        CREATE INDEX IF NOT EXISTS idx_takes_kind_active   ON takes(kind)   WHERE active;
        CREATE INDEX IF NOT EXISTS idx_takes_holder_active ON takes(holder) WHERE active;
        CREATE INDEX IF NOT EXISTS idx_takes_weight_active ON takes(weight DESC) WHERE active;
        CREATE INDEX IF NOT EXISTS idx_takes_resolved_at   ON takes(resolved_at) WHERE resolved_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_takes_embedding_hnsw ON takes
          USING hnsw (embedding vector_cosine_ops)
          WHERE active AND embedding IS NOT NULL;

        CREATE TABLE IF NOT EXISTS synthesis_evidence (
          synthesis_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          take_page_id      INTEGER NOT NULL,
          take_row_num      INTEGER NOT NULL,
          citation_index    INTEGER NOT NULL,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (synthesis_page_id, take_page_id, take_row_num),
          FOREIGN KEY (take_page_id, take_row_num)
            REFERENCES takes(page_id, row_num) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_synthesis_evidence_take
          ON synthesis_evidence(take_page_id, take_row_num);
      `,
    },
  },
  {
    version: 38,
    name: 'access_tokens_permissions',
    // v0.28: per-token allow-list for takes visibility (Codex P0 #3 partial fix).
    // The complementary fix (chunker strips fenced takes content from page chunks
    // so query results don't bypass the allow-list) lives in src/core/chunkers/takes-strip.ts.
    // Default permissions = {takes_holders: ['world']} keeps non-world takes (hunches,
    // private opinions) hidden from MCP-bound tokens until the operator explicitly
    // grants access via `gbrain auth permissions <id> set-takes-holders`.
    sql: `
      ALTER TABLE access_tokens
        ADD COLUMN IF NOT EXISTS permissions JSONB
          NOT NULL DEFAULT '{"takes_holders":["world"]}'::jsonb;

      -- Backfill existing tokens to the default. NOT NULL DEFAULT covers new rows;
      -- this UPDATE handles any pre-existing rows from before the column was added.
      UPDATE access_tokens
        SET permissions = '{"takes_holders":["world"]}'::jsonb
        WHERE permissions IS NULL OR permissions = '{}'::jsonb;
    `,
  },
  {
    version: 30,
    name: 'dream_verdicts_table',
    // v0.23 synthesize phase: cache for "is this transcript worth processing?"
    // verdict from the cheap Haiku judge. Distinct from raw_data (page-scoped);
    // transcripts aren't pages. Keyed by (file_path, content_hash) so edited
    // transcripts re-judge automatically. Backfill re-runs hit cache instead
    // of paying for Haiku 100x.
    sql: `
      CREATE TABLE IF NOT EXISTS dream_verdicts (
        file_path        TEXT        NOT NULL,
        content_hash     TEXT        NOT NULL,
        worth_processing BOOLEAN     NOT NULL,
        reasons          JSONB,
        judged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (file_path, content_hash)
      );
      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
        IF has_bypass THEN
          ALTER TABLE dream_verdicts ENABLE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `,
  },
  {
    version: 31,
    name: 'eval_capture_tables',
    // v0.25.0 — BrainBench-Real session capture substrate.
    // Two tables:
    //   eval_candidates: per-call capture from the op-layer wrapper around
    //     `query` and `search`. Captures MCP + CLI + subagent tool-bridge
    //     traffic via src/core/operations.ts. query column is CHECK-capped
    //     at 50KB; PII is scrubbed before insert by src/core/eval-capture-scrub.ts.
    //     remote distinguishes MCP callers (untrusted) from local CLI; job_id +
    //     subagent_id let gbrain-evals partition replay by run.
    //   eval_capture_failures: insert-side audit trail. When logEvalCandidate
    //     fails (DB down, RLS reject, CHECK violation, scrubber exception),
    //     the capture path records the reason here so `gbrain doctor` can
    //     surface silent drops cross-process. In-process counters don't work
    //     because doctor runs in a separate process from the MCP server.
    //
    // RLS enable matches the v24 / v29 posture: fail loudly via RAISE EXCEPTION
    // if current_user lacks BYPASSRLS, so the migration retries cleanly after
    // operator fixes the role instead of silently bumping schema_version.
    // PGLite ignores RLS; sqlFor carries the table+index DDL only.
    //
    // Renumbered v30→v31 on merge with master's v0.23.0 (dream_verdicts) which
    // claimed v30 first. Pre-existing brains that applied our v30 will see
    // version 31 as new on next initSchema and run the IF NOT EXISTS DDL —
    // the CREATE TABLE statements are idempotent so the rename is safe.
    sqlFor: {
      postgres: `
        DO $$
        DECLARE
          has_bypass BOOLEAN;
        BEGIN
          SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
          IF NOT has_bypass THEN
            RAISE EXCEPTION 'v31 eval_capture_tables: role % does not have BYPASSRLS privilege — cannot enable RLS safely. Re-run as postgres (or another BYPASSRLS role). The migration will retry automatically on the next initSchema call.', current_user;
          END IF;

          CREATE TABLE IF NOT EXISTS eval_candidates (
            id SERIAL PRIMARY KEY,
            tool_name TEXT NOT NULL CHECK (tool_name IN ('query', 'search')),
            query TEXT NOT NULL CHECK (length(query) <= 51200),
            retrieved_slugs TEXT[] NOT NULL DEFAULT '{}',
            retrieved_chunk_ids INTEGER[] NOT NULL DEFAULT '{}',
            source_ids TEXT[] NOT NULL DEFAULT '{}',
            expand_enabled BOOLEAN,
            detail TEXT CHECK (detail IS NULL OR detail IN ('low', 'medium', 'high')),
            detail_resolved TEXT CHECK (detail_resolved IS NULL OR detail_resolved IN ('low', 'medium', 'high')),
            vector_enabled BOOLEAN NOT NULL,
            expansion_applied BOOLEAN NOT NULL,
            latency_ms INTEGER NOT NULL,
            remote BOOLEAN NOT NULL,
            job_id INTEGER,
            subagent_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates (created_at DESC);
          ALTER TABLE eval_candidates ENABLE ROW LEVEL SECURITY;

          CREATE TABLE IF NOT EXISTS eval_capture_failures (
            id SERIAL PRIMARY KEY,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reason TEXT NOT NULL CHECK (reason IN ('db_down', 'rls_reject', 'check_violation', 'scrubber_exception', 'other'))
          );
          CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures (ts DESC);
          ALTER TABLE eval_capture_failures ENABLE ROW LEVEL SECURITY;

          RAISE NOTICE 'v31: eval_capture tables ready (role % has BYPASSRLS)', current_user;
        END $$;
      `,
      pglite: `
        CREATE TABLE IF NOT EXISTS eval_candidates (
          id SERIAL PRIMARY KEY,
          tool_name TEXT NOT NULL CHECK (tool_name IN ('query', 'search')),
          query TEXT NOT NULL CHECK (length(query) <= 51200),
          retrieved_slugs TEXT[] NOT NULL DEFAULT '{}',
          retrieved_chunk_ids INTEGER[] NOT NULL DEFAULT '{}',
          source_ids TEXT[] NOT NULL DEFAULT '{}',
          expand_enabled BOOLEAN,
          detail TEXT CHECK (detail IS NULL OR detail IN ('low', 'medium', 'high')),
          detail_resolved TEXT CHECK (detail_resolved IS NULL OR detail_resolved IN ('low', 'medium', 'high')),
          vector_enabled BOOLEAN NOT NULL,
          expansion_applied BOOLEAN NOT NULL,
          latency_ms INTEGER NOT NULL,
          remote BOOLEAN NOT NULL,
          job_id INTEGER,
          subagent_id INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates (created_at DESC);

        CREATE TABLE IF NOT EXISTS eval_capture_failures (
          id SERIAL PRIMARY KEY,
          ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reason TEXT NOT NULL CHECK (reason IN ('db_down', 'rls_reject', 'check_violation', 'scrubber_exception', 'other'))
        );
        CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures (ts DESC);
      `,
    },
    sql: '',
  },
  {
    version: 32,
    name: 'oauth_infrastructure',
    // v0.26 OAuth 2.1 tables for `gbrain serve --http`. Supports client credentials,
    // authorization code + PKCE, and refresh token rotation. Renumbered from v30
    // → v32 on merge with master's v0.23 (dream_verdicts at v30) + v0.25
    // (eval_capture_tables at v31). OAuth is independent of those chains so
    // ordering doesn't matter beyond version ledger correctness. CREATE TABLE
    // statements are idempotent so brains that previously applied this at v30
    // see version 32 as new and run IF NOT EXISTS DDL cleanly.
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id               TEXT PRIMARY KEY,
        client_secret_hash      TEXT,
        client_name             TEXT NOT NULL,
        redirect_uris           TEXT[],
        grant_types             TEXT[] DEFAULT '{"client_credentials"}',
        scope                   TEXT,
        token_endpoint_auth_method TEXT,
        client_id_issued_at     BIGINT,
        client_secret_expires_at BIGINT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash   TEXT PRIMARY KEY,
        token_type   TEXT NOT NULL,
        client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        scopes       TEXT[],
        expires_at   BIGINT,
        resource     TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash              TEXT PRIMARY KEY,
        client_id              TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        scopes                 TEXT[],
        code_challenge         TEXT NOT NULL,
        code_challenge_method  TEXT NOT NULL DEFAULT 'S256',
        redirect_uri           TEXT NOT NULL,
        state                  TEXT,
        resource               TEXT,
        expires_at             BIGINT NOT NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_log_time_agent ON mcp_request_log(created_at, token_name);
      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
        IF has_bypass THEN
          ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
          ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
          ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
        ELSE
          RAISE WARNING 'v32: role % lacks BYPASSRLS — skipping RLS on OAuth tables. Re-run as postgres (or a BYPASSRLS role) to harden.', current_user;
        END IF;
      END $$;
    `,
  },
  {
    version: 33,
    name: 'admin_dashboard_columns_v0_26_3',
    // v0.26.3 admin dashboard expansion. Adds 5 columns referenced by
    // src/commands/serve-http.ts and src/core/oauth-provider.ts that landed
    // in PR #586 without a corresponding schema migration. Without v33,
    // existing brains hit:
    //   - SELECT c.token_ttl, ... CASE WHEN c.deleted_at -> 503 on /admin/api/agents
    //   - INSERT INTO mcp_request_log (... agent_name, params, error_message)
    //     -> caught by best-effort try/catch, request log silently empties
    //   - UPDATE oauth_clients SET deleted_at = now() (revoke-client) -> 500
    //   - UPDATE oauth_clients SET token_ttl = ... (update-client-ttl) -> 500
    // All ALTERs use ADD COLUMN IF NOT EXISTS so re-running is a no-op.
    sql: `
      ALTER TABLE oauth_clients
        ADD COLUMN IF NOT EXISTS token_ttl INTEGER,
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

      ALTER TABLE mcp_request_log
        ADD COLUMN IF NOT EXISTS agent_name TEXT,
        ADD COLUMN IF NOT EXISTS params JSONB,
        ADD COLUMN IF NOT EXISTS error_message TEXT;

      -- Backfill agent_name on existing rows so the new "agent" column in
      -- the request log isn't blank for pre-v0.26.3 entries. LEFT JOIN
      -- pattern: prefer client_name from oauth_clients (current behavior),
      -- fall back to access_tokens.name (legacy bearer tokens), fall back
      -- to the raw client_id stored as token_name.
      UPDATE mcp_request_log m
      SET agent_name = COALESCE(
        (SELECT client_name FROM oauth_clients WHERE client_id = m.token_name LIMIT 1),
        (SELECT name FROM access_tokens WHERE name = m.token_name LIMIT 1),
        m.token_name
      )
      WHERE agent_name IS NULL;

      -- Index for the new agent filter on /admin/api/request-log. The
      -- existing idx_mcp_log_time_agent (created_at, token_name) doesn't
      -- help when filtering by the resolved agent_name. Use DESC on
      -- created_at to match the typical ORDER BY clause.
      CREATE INDEX IF NOT EXISTS idx_mcp_log_agent_time
        ON mcp_request_log(agent_name, created_at DESC);
    `,
  },
  {
    version: 34,
    name: 'destructive_guard_columns',
    // v0.26.5 — soft-delete + recovery window for sources AND pages.
    // Renumbered v33→v34 on master merge: master's v33 (admin_dashboard_columns_v0_26_3)
    // landed first in PR #586. v34 follows it.
    //
    // pages.deleted_at: `delete_page` op now sets deleted_at = now() instead of
    // hard-deleting. The autopilot purge phase hard-deletes rows where
    // deleted_at < now() - 72h. Search and `get_page` filter
    // `WHERE deleted_at IS NULL` by default; `include_deleted: true` opts in.
    //
    // sources.archived/archived_at/archive_expires_at: promoted from JSONB keys
    // to real columns. v0.26.0 + the cherry-picked PR #595 wrote these inside
    // `sources.config` JSONB. Real columns are faster to filter, avoid the
    // reserved-key footgun, and let the search visibility filter compile to a
    // column lookup. The 72h TTL is preserved by reading
    // `archive_expires_at = archived_at + INTERVAL '72 hours'`.
    //
    // Backfill: any row that previously stored `{"archived":true,"archived_at":"...","archive_expires_at":"..."}`
    // in config gets migrated to the new columns, then the keys are stripped
    // from JSONB so the JSONB shape stays canonical going forward.
    //
    // Engine-aware partial index: Postgres uses CREATE INDEX CONCURRENTLY (no
    // write-blocking lock); PGLite uses plain CREATE INDEX. Mirrors v14
    // (pages_updated_at_index) handler shape.
    sql: '',
    handler: async (engine) => {
      // 1. Add columns. ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent on
      //    both engines.
      await engine.runMigration(34, `
        ALTER TABLE pages   ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived           BOOLEAN     NOT NULL DEFAULT false;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS archive_expires_at TIMESTAMPTZ;
      `);

      // 2. Backfill from JSONB shape used by pre-v0.26.5 cherry-picks of PR #595.
      //    Idempotent: subsequent re-runs find zero matching rows.
      await engine.runMigration(34, `
        UPDATE sources
        SET archived = true,
            archived_at = COALESCE((config->>'archived_at')::timestamptz, now()),
            archive_expires_at = COALESCE(
              (config->>'archive_expires_at')::timestamptz,
              COALESCE((config->>'archived_at')::timestamptz, now()) + INTERVAL '72 hours'
            )
        WHERE config ? 'archived'
          AND (config->>'archived')::boolean = true
          AND archived = false;
      `);
      await engine.runMigration(34, `
        UPDATE sources
        SET config = config - 'archived' - 'archived_at' - 'archive_expires_at'
        WHERE config ?| ARRAY['archived', 'archived_at', 'archive_expires_at'];
      `);

      // 3. Partial index for the autopilot purge sweep. Postgres CONCURRENTLY
      //    avoids the SHARE lock on `pages`; PGLite has no concurrent writers.
      if (engine.kind === 'postgres') {
        // Pre-drop any invalid index from a prior CONCURRENTLY failure (matches v14 pattern).
        await engine.runMigration(34, `
          DO $$ BEGIN
            IF EXISTS (
              SELECT 1 FROM pg_index i
              JOIN pg_class c ON c.oid = i.indexrelid
              WHERE c.relname = 'pages_deleted_at_purge_idx' AND NOT i.indisvalid
            ) THEN
              EXECUTE 'DROP INDEX CONCURRENTLY IF EXISTS pages_deleted_at_purge_idx';
            END IF;
          END $$;
        `);
        await engine.runMigration(34, `
          CREATE INDEX CONCURRENTLY IF NOT EXISTS pages_deleted_at_purge_idx
            ON pages (deleted_at) WHERE deleted_at IS NOT NULL;
        `);
      } else {
        await engine.runMigration(34, `
          CREATE INDEX IF NOT EXISTS pages_deleted_at_purge_idx
            ON pages (deleted_at) WHERE deleted_at IS NOT NULL;
        `);
      }
    },
    // CONCURRENTLY on Postgres requires no surrounding transaction. PGLite ignores
    // this flag, so the index DDL runs in whatever wrapper applies.
    transaction: false,
  },
  {
    version: 35,
    name: 'auto_rls_event_trigger',
    sql: '', // engine-specific via sqlFor
    // v0.26.7 — Postgres event trigger that auto-enables RLS on every new public.*
    // table, plus one-time backfill on every existing public.* table without it.
    //
    // Problem: tables created outside gbrain migrations (Baku's face_detections,
    // manual SQL, other apps sharing the Supabase project) shipped without RLS.
    // doctor caught them after the fact; the gap window between create and next
    // doctor run was the silent vector.
    //
    // Fix has two halves:
    //   1. Event trigger — fires on ddl_command_end for CREATE TABLE,
    //      CREATE TABLE AS, and SELECT INTO; runs ALTER TABLE ... ENABLE ROW
    //      LEVEL SECURITY for any new public.* table. Supabase-recommended
    //      approach (no dashboard toggle exists).
    //   2. One-time backfill — every existing public.* table whose RLS is off
    //      and whose comment does NOT match the GBRAIN:RLS_EXEMPT contract
    //      (same regex doctor.ts uses) gets RLS enabled.
    //
    // Posture choices (vs PR-as-shipped):
    //   - ENABLE only, no FORCE — matches v24/v29/schema.sql. FORCE would lock
    //     out non-BYPASSRLS apps from their own newly-created tables (the
    //     trigger function inherits the caller's role, and the new table is
    //     owned by that role). gbrain has BYPASSRLS so gbrain itself is unaffected.
    //   - public-only schema scope — Supabase manages auth/storage/realtime/etc.
    //     and runs its own RLS posture there; we must not disturb those schemas.
    //   - No EXCEPTION wrap inside the trigger — ddl_command_end fires inside
    //     the DDL transaction, so a failed ALTER aborts the offending CREATE
    //     TABLE. That's a loud signal, not a silent gap. Wrapping would CREATE
    //     the silent path this migration exists to close.
    //   - No privilege pre-check — runMigrations rethrows on SQL failure and
    //     gates config.version, so a non-superuser run already fails loud with
    //     an actionable Postgres error.
    //
    // BREAKING CHANGE: the backfill is a one-time override of intentionally
    // RLS-off public tables that don't carry the GBRAIN:RLS_EXEMPT comment.
    // Operators with such tables MUST add the exempt comment BEFORE upgrading.
    //
    // PGLite: no-op — no RLS engine, no event triggers, single-tenant by design.
    sqlFor: {
      postgres: `
        -- Trigger function: fires post-DDL inside the CREATE TABLE transaction.
        -- A failure here aborts the CREATE TABLE so no public.* table is ever
        -- created without RLS. object_identity is pre-quoted by Postgres
        -- (e.g. "public"."My Table"), so %s is correct — %I would double-quote.
        CREATE OR REPLACE FUNCTION auto_enable_rls()
        RETURNS event_trigger AS $$
        DECLARE
          obj record;
        BEGIN
          FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
            WHERE object_type = 'table'
            AND schema_name = 'public'
          LOOP
            EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
          END LOOP;
        END;
        $$ LANGUAGE plpgsql;

        -- WHEN TAG covers all three table-creation syntaxes Postgres reports.
        -- CREATE TABLE / CREATE TABLE AS / SELECT INTO produce distinct command
        -- tags; covering only 'CREATE TABLE' would leave a syntax-shaped hole.
        DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table;
        CREATE EVENT TRIGGER auto_rls_on_create_table
          ON ddl_command_end
          WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
          EXECUTE FUNCTION auto_enable_rls();

        -- One-time backfill of every existing public.* base table without RLS.
        -- Honors the same GBRAIN:RLS_EXEMPT regex doctor.ts uses
        -- (^GBRAIN:RLS_EXEMPT\\s+reason=\\S.{3,}) so the two surfaces stay aligned.
        -- %I.%I quotes the schema and table names safely, including mixed-case.
        DO $$
        DECLARE
          has_bypass BOOLEAN;
          r record;
        BEGIN
          SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
          IF NOT has_bypass THEN
            -- Same posture as v24: raise to abort the migration so the runner
            -- leaves config.version unbumped and retries on the next call.
            RAISE EXCEPTION 'v35 auto_rls_event_trigger backfill: role % does not have BYPASSRLS — cannot enable RLS safely. Re-run as postgres (or another BYPASSRLS role).', current_user;
          END IF;

          FOR r IN
            SELECT n.nspname AS schema_name, c.relname AS table_name
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND c.relrowsecurity = false
              AND (d.description IS NULL OR d.description !~ '^GBRAIN:RLS_EXEMPT\\s+reason=\\S.{3,}')
          LOOP
            EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
            RAISE NOTICE 'v35: backfilled RLS on %.%', r.schema_name, r.table_name;
          END LOOP;
        END $$;
      `,
      pglite: '', // PGLite has no RLS and no event trigger support
    },
  },
  {
    version: 36,
    name: 'subagent_provider_neutral_persistence_v0_27',
    // v0.27 multi-provider subagent. Codex F-OV-1 / D11: the subagent_messages
    // and subagent_tool_executions tables stored Anthropic-shaped tool_use /
    // tool_result blocks as JSONB. When a worker resumes a job mid-loop and
    // the live model is OpenAI/DeepSeek/etc, the persisted shape becomes the
    // runtime contract — translation at read time is lossy.
    //
    // Fix: add schema_version + provider_id columns. schema_version=1 is the
    // legacy Anthropic-shape (existing rows). schema_version=2 is the
    // provider-neutral ChatBlock format documented in src/core/ai/gateway.ts
    // (text / tool-call / tool-result blocks with normalized field names).
    // Subagent.ts (commit 2) writes schema_version=2 going forward and reads
    // both shapes via a versioned mapper.
    //
    // Renumbered v34→v35→v36 across master merges: master's v34
    // (destructive_guard_columns, v0.26.5 soft-delete) and v35
    // (auto_rls_event_trigger, v0.26.8) landed first.
    //
    // No data migration. Existing in-flight jobs continue to replay against
    // their original shape; new jobs use v2. ADD COLUMN IF NOT EXISTS makes
    // the migration idempotent.
    sql: `
      ALTER TABLE subagent_messages
        ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS provider_id TEXT;

      ALTER TABLE subagent_tool_executions
        ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS provider_id TEXT;

      -- Lookup by provider for cost rollups + per-provider replay diagnostics.
      CREATE INDEX IF NOT EXISTS idx_subagent_messages_provider
        ON subagent_messages (job_id, provider_id);
    `,
  },
  {
    version: 39,
    name: 'multimodal_dual_column_v0_27_1',
    // v0.27.1 multimodal ingestion. Three changes that travel together:
    //
    // 1. content_chunks gains `modality TEXT NOT NULL DEFAULT 'text'` so image
    //    chunks declare themselves at the row level. Search filters use it to
    //    keep image OCR text out of text-page keyword search by default.
    //
    // 2. content_chunks gains `embedding_image vector(1024)` for Voyage
    //    multimodal embeddings. NULL on every text row; sparse on the column.
    //    Partial HNSW index ignores NULL rows so the index footprint stays
    //    proportional to image chunk count, not table size. Mixed-provider
    //    brains (e.g. OpenAI 1536 text + Voyage 1024 images) can keep both
    //    columns populated with distinct dim spaces.
    //
    // 3. PGLite gains the `files` table (mirroring the Postgres v0.18 shape)
    //    so the multimodal ingest pipeline can persist binary-asset metadata
    //    on the default engine. Image bytes never enter the DB; storage_path
    //    references a path inside the brain repo. The v0.18 "PGLite has no
    //    files table" omission was specific to blob storage — for path-
    //    referenced metadata PGLite hosts it fine.
    //
    // Eng-3C: a preflight handler refuses if pgvector < 0.5, BEFORE any DDL
    // fires, so the user gets a clear upgrade hint instead of a half-migrated
    // brain mid-DDL. Postgres-only — PGLite ships pgvector built in.
    // Handler-driven migration. The preflight pgvector check (Eng-3C) MUST
    // run BEFORE any DDL fires; if we used `sqlFor` the runner would DDL
    // before calling the handler. So we keep `sql` empty and let the handler
    // run preflight + DDL in the right order.
    sql: '',
    handler: async (engine: BrainEngine) => {
      // Eng-3C: refuse loudly if pgvector < 0.5 BEFORE any DDL fires.
      // Partial HNSW indexes need HNSW (pgvector 0.5.0+). PGLite ships a
      // recent pgvector inside its WASM bundle so this gate is Postgres-only.
      if (engine.kind === 'postgres') {
        const rows = await engine.executeRaw<{ extversion: string }>(
          `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
        );
        if (rows.length === 0) {
          throw new Error(
            `Migration v39 requires the pgvector extension. Install it via\n` +
            `  CREATE EXTENSION vector;\n` +
            `then re-run \`gbrain apply-migrations --yes\`.`
          );
        }
        const version = rows[0].extversion;
        const [maj, minStr] = version.split('.');
        const min = parseInt(minStr ?? '0', 10);
        const major = parseInt(maj ?? '0', 10);
        if (major === 0 && min < 5) {
          throw new Error(
            `Migration v39 requires pgvector >= 0.5.0 (HNSW partial indexes).\n` +
            `Found pgvector ${version}.\n\n` +
            `Fix: ALTER EXTENSION vector UPDATE; then re-run \`gbrain apply-migrations --yes\`.\n` +
            `If your Postgres provider doesn't ship pgvector >= 0.5, request\n` +
            `an upgrade or migrate to PGLite for v0.27.1 multimodal support.`
          );
        }
      }

      // Step 1: schema delta on content_chunks + widen pages.page_kind CHECK
      // to admit 'image'. Runs through engine.runMigration so multi-statement
      // DDL works on PGLite (db.exec) and Postgres (sql.unsafe).
      await engine.runMigration(39, `
        ALTER TABLE content_chunks
          ADD COLUMN IF NOT EXISTS modality TEXT NOT NULL DEFAULT 'text',
          ADD COLUMN IF NOT EXISTS embedding_image vector(1024);

        CREATE INDEX IF NOT EXISTS idx_chunks_embedding_image
          ON content_chunks USING hnsw (embedding_image vector_cosine_ops)
          WHERE embedding_image IS NOT NULL;

        -- Widen pages.page_kind CHECK to admit 'image'. The constraint name
        -- is auto-assigned by Postgres; locate + drop + recreate with the
        -- new value list. PGLite + Postgres share the same constraint shape.
        ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_page_kind_check;
        ALTER TABLE pages ADD CONSTRAINT pages_page_kind_check
          CHECK (page_kind IN ('markdown','code','image'));
      `);

      // Step 2: PGLite-only — add the files table that v0.18 deliberately
      // omitted. Postgres has had it since v0.18; this is parity catch-up.
      if (engine.kind === 'pglite') {
        await engine.runMigration(39, `
          CREATE TABLE IF NOT EXISTS files (
            id           SERIAL PRIMARY KEY,
            source_id    TEXT   NOT NULL DEFAULT 'default'
                         REFERENCES sources(id) ON DELETE CASCADE,
            page_slug    TEXT,
            page_id      INTEGER REFERENCES pages(id) ON DELETE SET NULL,
            filename     TEXT   NOT NULL,
            storage_path TEXT   NOT NULL,
            mime_type    TEXT,
            size_bytes   BIGINT,
            content_hash TEXT   NOT NULL,
            metadata     JSONB  NOT NULL DEFAULT '{}',
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE(storage_path)
          );

          CREATE INDEX IF NOT EXISTS idx_files_page ON files(page_slug);
          CREATE INDEX IF NOT EXISTS idx_files_page_id ON files(page_id);
          CREATE INDEX IF NOT EXISTS idx_files_source_id ON files(source_id);
          CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
        `);
      }
    },
  },
  {
    version: 40,
    name: 'pages_emotional_weight',
    // v0.29 — Salience + Anomaly Detection.
    //
    // Adds the `emotional_weight` column to pages. Populated by the new
    // `recompute_emotional_weight` cycle phase from tags + takes (deterministic;
    // no LLM). Default 0.0 so freshly imported pages don't pollute salience
    // ranking before the cycle has run; users run `gbrain dream --phase
    // recompute_emotional_weight` once after upgrading to backfill.
    //
    // No index: the salience query orders by a computed score (emotional_weight,
    // take_count, recency-decay), not by raw emotional_weight. Add an index
    // later only if a query orders by the raw column directly.
    //
    // Postgres ADD COLUMN with a constant DEFAULT is metadata-only on PG 11+
    // and PGLite (PG 17.5 via WASM) — instant on tables of any size.
    sql: `
      ALTER TABLE pages
        ADD COLUMN IF NOT EXISTS emotional_weight REAL NOT NULL DEFAULT 0.0;
    `,
  },
  {
    version: 41,
    name: 'pages_recency_columns',
    sql: '',
    // v0.29.1 — Salience-and-Recency, additive opt-in.
    //
    // Four new pages columns (all nullable, additive only, no behavior change
    // in the default search path; only consulted when a caller opts into
    // `salience='on'` / `recency='on'` or the new `since`/`until` filter):
    //
    //   effective_date         — content date (event_date / date / published /
    //                            filename-date / fallback). Read by the new
    //                            recency boost and date-filter paths only.
    //                            Auto-link doesn't touch it (immune to
    //                            updated_at churn).
    //   effective_date_source  — sentinel for the doctor's effective_date_health
    //                            check ('event_date' | 'date' | 'published' |
    //                            'filename' | 'fallback'). The 'fallback' value
    //                            is what surfaces "page that fell back to
    //                            updated_at when frontmatter was unparseable".
    //   import_filename        — basename without extension, captured at import.
    //                            computeEffectiveDate uses it for filename-date
    //                            precedence (daily/, meetings/ prefixes). Older
    //                            rows leave it NULL; backfill falls through.
    //   salience_touched_at    — bumped by recompute_emotional_weight when
    //                            emotional_weight changes. Salience window
    //                            uses GREATEST(updated_at, salience_touched_at)
    //                            so newly-salient old pages enter the recent
    //                            salience query.
    //
    // Plus an expression index used by since/until filters that read
    // COALESCE(effective_date, updated_at). Partial-index claim from earlier
    // plan iterations was wrong (codex pass-2 #15) — the planner won't use a
    // partial index for the negative side of a COALESCE; expression index does.
    //
    // CONCURRENTLY + pre-drop guard (mirror of v34) on Postgres; plain CREATE
    // INDEX on PGLite via the handler branching on engine.kind.
    handler: async (engine) => {
      // 1. ADD COLUMN x4. ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent.
      //    No defaults, all nullable, all metadata-only on PG 11+ and PGLite.
      await engine.runMigration(38, `
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date        TIMESTAMPTZ;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date_source TEXT;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS import_filename       TEXT;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS salience_touched_at   TIMESTAMPTZ;
      `);

      // 2. Expression index for since/until date-range filters.
      if (engine.kind === 'postgres') {
        // Pre-drop any invalid index from a prior CONCURRENTLY failure.
        await engine.runMigration(38, `
          DO $$ BEGIN
            IF EXISTS (
              SELECT 1 FROM pg_index i
              JOIN pg_class c ON c.oid = i.indexrelid
              WHERE c.relname = 'pages_coalesce_date_idx' AND NOT i.indisvalid
            ) THEN
              EXECUTE 'DROP INDEX CONCURRENTLY IF EXISTS pages_coalesce_date_idx';
            END IF;
          END $$;
        `);
        await engine.runMigration(38, `
          CREATE INDEX CONCURRENTLY IF NOT EXISTS pages_coalesce_date_idx
            ON pages ((COALESCE(effective_date, updated_at)));
        `);
      } else {
        await engine.runMigration(38, `
          CREATE INDEX IF NOT EXISTS pages_coalesce_date_idx
            ON pages ((COALESCE(effective_date, updated_at)));
        `);
      }
    },
    // CONCURRENTLY on Postgres requires no surrounding transaction.
    transaction: false,
  },
  {
    version: 42,
    name: 'eval_candidates_recency_capture',
    // v0.29.1 — capture agent-explicit recency + salience choices for replay
    // reproducibility (D11 codex resolution).
    //
    // Without these fields, `gbrain eval replay` cannot reproduce a captured
    // run: the live behavior depends on the resolved {salience, recency}
    // values, which are absent from v0.29.0's eval_candidates schema. Replays
    // of agent-explicit choices drift the same way as_of_ts replays drifted
    // before being captured.
    //
    // All columns are nullable + additive. Pre-v0.29.1 rows stay valid. The
    // NDJSON `schema_version` STAYS at 1 — the new fields are optional, and
    // gbrain-evals consumers that don't know about them ignore them
    // (standard permissive deserialization). No cross-repo coordination
    // required (codex pass-1 #C2 dissolved).
    //
    //   as_of_ts            — brain's logical NOW at capture (replay uses
    //                         this instead of wall-clock so old captures
    //                         reproduce identically against today's brain).
    //   salience_param      — what the caller passed (or NULL if omitted).
    //   recency_param       — same for recency.
    //   salience_resolved   — final value applied ('off' / 'on' / 'strong').
    //   recency_resolved    — same for recency.
    //   salience_source     — 'caller' or 'auto_heuristic'.
    //   recency_source      — same for recency.
    //
    // ADD COLUMN with no DEFAULT is metadata-only on PG 11+ and PGLite —
    // instant on tables of any size.
    sql: `
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS as_of_ts          TIMESTAMPTZ;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS salience_param    TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS recency_param     TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS salience_resolved TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS recency_resolved  TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS salience_source   TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS recency_source    TEXT;
    `,
  },
  {
    version: 43,
    name: 'takes_resolved_quality_and_drift_decisions',
    // v0.30.0 (Slice A1, Universal Takes Epistemology wave). Bundles ALL schema
    // for the v0.30 release wave so A2/B1/C1 add no migrations (codex F6 fix:
    // schema-first ordering eliminates the cross-lane migrate.ts contention).
    // Originally landed as v40 in the v0.30.0 branch; renumbered to v43 on
    // merge with master after master claimed v40-v42 with the v0.29 +
    // v0.29.1 salience-and-recency wave. Migration runner sorts by version
    // number, so renumbering is a pure-rename — no semantic change.
    //
    // 1. takes.resolved_quality TEXT — 3-state outcome label (correct/incorrect/
    //    partial) sitting alongside existing resolved_outcome BOOLEAN. Boolean
    //    stays for back-compat reads; quality is the new source of truth for
    //    calibration math. Backfill maps legacy resolved_outcome → quality.
    //
    // 2. takes_resolution_consistency CHECK constraint — fails contradictory
    //    states like (quality='correct', outcome=false). 'partial' maps to
    //    outcome=NULL because partial isn't a binary outcome. Added AFTER the
    //    backfill so existing rows pass.
    //
    // 3. idx_takes_scorecard partial index on (holder, kind, resolved_quality)
    //    WHERE resolved_quality IS NOT NULL — scorecard hot path. ~5KB on a
    //    50K-row brain; makes scorecard O(log n) instead of full scan.
    //
    // 4. drift_decisions audit table — consumed by Slice C1 (v0.30.3) when
    //    drift LLM judge ships. Defined here so C1 carries no migration.
    //    Sized for one row per drift recommendation (insert-only, never
    //    updated except for applied_at/applied_by when --auto-update lands).
    sql: `
      -- Step 1: add resolved_quality column with kind-of-outcome CHECK.
      -- The (quality, outcome) consistency constraint comes AFTER the backfill
      -- (Step 3) so existing legacy rows don't fail the new constraint.
      ALTER TABLE takes
        ADD COLUMN IF NOT EXISTS resolved_quality TEXT
          CHECK (resolved_quality IS NULL OR resolved_quality IN ('correct','incorrect','partial'));

      -- Step 2: backfill from legacy boolean. Idempotent: only writes rows
      -- where quality is still NULL and outcome is set. Re-runs are no-ops.
      UPDATE takes
      SET resolved_quality = CASE resolved_outcome
        WHEN true  THEN 'correct'
        WHEN false THEN 'incorrect'
      END
      WHERE resolved_outcome IS NOT NULL AND resolved_quality IS NULL;

      -- Step 3: (quality, outcome) consistency constraint. Drop-then-recreate
      -- so re-runs converge. The named constraint lets us evolve it later.
      ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_resolution_consistency;
      ALTER TABLE takes ADD CONSTRAINT takes_resolution_consistency CHECK (
        (resolved_quality IS NULL     AND resolved_outcome IS NULL)
        OR (resolved_quality = 'correct'   AND resolved_outcome = true)
        OR (resolved_quality = 'incorrect' AND resolved_outcome = false)
        OR (resolved_quality = 'partial'   AND resolved_outcome IS NULL)
      );

      -- Step 4: scorecard hot path. Partial index keeps footprint proportional
      -- to resolved-take count, not table size.
      CREATE INDEX IF NOT EXISTS idx_takes_scorecard
        ON takes (holder, kind, resolved_quality)
        WHERE resolved_quality IS NOT NULL;

      -- Step 5: drift_decisions audit table (consumed by Slice C1 in v0.30.3).
      CREATE TABLE IF NOT EXISTS drift_decisions (
        id                  BIGSERIAL   PRIMARY KEY,
        take_id             BIGINT      NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
        page_id             INTEGER     NOT NULL,
        row_num             INTEGER     NOT NULL,
        recommended_weight  REAL        NOT NULL CHECK (recommended_weight >= 0 AND recommended_weight <= 1),
        reasoning           TEXT,
        decided_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_at          TIMESTAMPTZ,
        applied_by          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_drift_decisions_take       ON drift_decisions(take_id);
      CREATE INDEX IF NOT EXISTS idx_drift_decisions_decided_at ON drift_decisions(decided_at DESC);

      -- RLS for the new table (Postgres-only — PGLite has no RLS engine).
      -- Mirrors the v37 takes/synthesis_evidence pattern: only flip RLS on
      -- when running as a BYPASSRLS role so non-BYPASSRLS apps still read.
      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
        IF has_bypass THEN
          ALTER TABLE drift_decisions ENABLE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `,
    sqlFor: {
      // PGLite: same DDL minus the RLS DO-block. Single-tenant by definition.
      pglite: `
        ALTER TABLE takes
          ADD COLUMN IF NOT EXISTS resolved_quality TEXT
            CHECK (resolved_quality IS NULL OR resolved_quality IN ('correct','incorrect','partial'));

        UPDATE takes
        SET resolved_quality = CASE resolved_outcome
          WHEN true  THEN 'correct'
          WHEN false THEN 'incorrect'
        END
        WHERE resolved_outcome IS NOT NULL AND resolved_quality IS NULL;

        ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_resolution_consistency;
        ALTER TABLE takes ADD CONSTRAINT takes_resolution_consistency CHECK (
          (resolved_quality IS NULL     AND resolved_outcome IS NULL)
          OR (resolved_quality = 'correct'   AND resolved_outcome = true)
          OR (resolved_quality = 'incorrect' AND resolved_outcome = false)
          OR (resolved_quality = 'partial'   AND resolved_outcome IS NULL)
        );

        CREATE INDEX IF NOT EXISTS idx_takes_scorecard
          ON takes (holder, kind, resolved_quality)
          WHERE resolved_quality IS NOT NULL;

        CREATE TABLE IF NOT EXISTS drift_decisions (
          id                  BIGSERIAL   PRIMARY KEY,
          take_id             BIGINT      NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
          page_id             INTEGER     NOT NULL,
          row_num             INTEGER     NOT NULL,
          recommended_weight  REAL        NOT NULL CHECK (recommended_weight >= 0 AND recommended_weight <= 1),
          reasoning           TEXT,
          decided_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          applied_at          TIMESTAMPTZ,
          applied_by          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_drift_decisions_take       ON drift_decisions(take_id);
        CREATE INDEX IF NOT EXISTS idx_drift_decisions_decided_at ON drift_decisions(decided_at DESC);
      `,
    },
  },
  {
    version: 44,
    name: 'pages_emotional_weight_recomputed_at',
    idempotent: true,
    // v0.30.1 (Codex X4 / Finding P2): emotional_weight = 0 is a VALID
    // steady-state value (migration v40 default). Indexing WHERE = 0
    // would be a permanent large index over normal data, not a backlog
    // index. The actual backlog predicate is "never recomputed" — for
    // that we need a separate timestamp column. ADD COLUMN with NULL
    // default is metadata-only on PG 11+ and PGLite — instant on tables
    // of any size.
    //
    // The recompute-emotional-weight cycle phase + the new
    // `gbrain backfill emotional_weight` command both stamp this column
    // with NOW() alongside the weight write, so existing rows progress
    // out of the backlog naturally as the cycle runs.
    //
    // Partial index: idx_pages_emotional_weight_pending lives on
    // `(id) WHERE emotional_weight_recomputed_at IS NULL` and is created
    // on first run by the backfill primitive (CONCURRENTLY) rather than
    // here, because schema-time CREATE INDEX isn't CONCURRENTLY-friendly
    // when the SCHEMA_SQL replay runs in a transaction.
    sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS emotional_weight_recomputed_at TIMESTAMPTZ;
    `,
  },
  {
    version: 45,
    name: 'facts_hot_memory_v0_31',
    // v0.31: hot memory layer — real-time working memory queryable across
    // sessions. Sits alongside `takes` (cold, markdown-mirrored) as the
    // ephemeral DB-only counterpart. Dream cycle's new `consolidate` phase
    // promotes facts → takes(kind='fact') overnight; the consolidated_into
    // pointer keeps facts as the audit trail.
    //
    // Schema decisions (from /plan-eng-review):
    //   - source_id TEXT (sources.id is TEXT — eE2). Per-source isolation;
    //     cross-brain federation stays agent-side.
    //   - kind CHECK constraint with 5 values; different decay halflives.
    //   - visibility column mirrors takes' world-default ACL contract (D21).
    //   - embedding column dim resolved at migration time from the
    //     `config.embedding_dimensions` row (matches content_chunks dim) so
    //     non-OpenAI brains (Voyage, etc.) work — codex F6 fix.
    //   - HALFVEC preferred (pgvector >= 0.7 needed); falls back to VECTOR
    //     with stderr warn on older pgvector — codex eE6 fix.
    //   - 5 partial indexes leading on source_id so every read uses the
    //     trust boundary as part of the index, not a callback.
    //   - consolidated_into BIGINT — takes.id is BIGSERIAL.
    sql: '',
    handler: async (engine: BrainEngine) => {
      // Step 1: resolve embedding dim from config table (already populated
      // by the schema-init __EMBEDDING_DIMS__ replacement on PGLite, or by
      // the seed config on Postgres). Default to 1536 (OpenAI text-embed-3-large).
      let embeddingDim = 1536;
      try {
        const dimRows = await engine.executeRaw<{ value: string }>(
          `SELECT value FROM config WHERE key = 'embedding_dimensions'`,
        );
        if (dimRows.length > 0) {
          const parsed = parseInt(dimRows[0].value, 10);
          if (Number.isFinite(parsed) && parsed > 0 && parsed <= 4096) {
            embeddingDim = parsed;
          }
        }
      } catch {
        // No config row yet — fall back to default. Fresh installs hit this
        // path on first initSchema; that's fine since the schema seeds
        // the row before subsequent migrations run.
      }

      // Step 2: pgvector version preflight for HALFVEC support (>=0.7).
      // PGLite ships a recent pgvector inside its WASM bundle; we still
      // probe to be honest about the column type.
      let useHalfvec = false;
      if (engine.kind === 'postgres') {
        try {
          const vrows = await engine.executeRaw<{ extversion: string }>(
            `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
          );
          if (vrows.length === 0) {
            throw new Error(
              `Migration v40 (facts hot memory) requires the pgvector extension. ` +
              `Install it via\n  CREATE EXTENSION vector;\n` +
              `then re-run \`gbrain apply-migrations --yes\`.`,
            );
          }
          const v = vrows[0].extversion;
          const parts = v.split('.');
          const major = parseInt(parts[0] ?? '0', 10);
          const minor = parseInt(parts[1] ?? '0', 10);
          // HALFVEC introduced in pgvector 0.7.0
          if (major > 0 || (major === 0 && minor >= 7)) {
            useHalfvec = true;
          } else {
            // Fall back to full-precision vector with stderr warning.
            // eslint-disable-next-line no-console
            console.warn(
              `[v40 facts] pgvector ${v} < 0.7 — falling back to VECTOR(${embeddingDim}). ` +
              `HALFVEC space savings unavailable; functionality otherwise identical. ` +
              `Upgrade pgvector to 0.7+ to enable HALFVEC.`,
            );
          }
        } catch (err) {
          // Re-throw the missing-extension error; tolerate other probe failures.
          if (err instanceof Error && err.message.includes('requires the pgvector')) throw err;
          // Probe failed for other reason — assume older pgvector and fall back.
        }
      } else {
        // PGLite: bundled pgvector is recent enough for HALFVEC. Use it.
        useHalfvec = true;
      }

      const vecType = useHalfvec ? 'HALFVEC' : 'VECTOR';
      // HNSW operator class must match the column type:
      //   VECTOR(n)  → vector_cosine_ops
      //   HALFVEC(n) → halfvec_cosine_ops
      const opclass = useHalfvec ? 'halfvec_cosine_ops' : 'vector_cosine_ops';
      // FK to sources is added in a separate ALTER TABLE rather than inline
      // on the column. Inline `REFERENCES` worked on PGLite but silently
      // got dropped by postgres.js's `unsafe()` multi-statement path on
      // Postgres in the v0.31 e2e run (table created without FK; CASCADE
      // delete didn't fire). Splitting the FK declaration out makes the
      // intent explicit and idempotent: the named constraint either
      // exists or doesn't, and the ALTER is a no-op on re-runs.
      const factsDDL = `
        CREATE TABLE IF NOT EXISTS facts (
          id                BIGSERIAL PRIMARY KEY,
          source_id         TEXT        NOT NULL DEFAULT 'default',
          entity_slug       TEXT,
          fact              TEXT        NOT NULL,
          kind              TEXT        NOT NULL DEFAULT 'fact'
                            CHECK (kind IN ('event','preference','commitment','belief','fact')),
          visibility        TEXT        NOT NULL DEFAULT 'private'
                            CHECK (visibility IN ('private','world')),
          notability        TEXT        NOT NULL DEFAULT 'medium'
                            CHECK (notability IN ('high','medium','low')),
          context           TEXT,
          valid_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
          valid_until       TIMESTAMPTZ,
          expired_at        TIMESTAMPTZ,
          superseded_by     BIGINT      REFERENCES facts(id),
          consolidated_at   TIMESTAMPTZ,
          consolidated_into BIGINT,
          source            TEXT        NOT NULL,
          source_session    TEXT,
          confidence        REAL        NOT NULL DEFAULT 1.0
                            CHECK (confidence BETWEEN 0 AND 1),
          embedding         ${vecType}(${embeddingDim}),
          embedded_at       TIMESTAMPTZ,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          -- v0.32.2 (migration v51): fence round-trip columns. Both nullable
          -- because pre-v0.32 rows didn't have them; the v0_32_2 orchestrator
          -- backfills via fence-append. New rows from the markdown-first
          -- runFactsBackstop/runFactsPipeline paths populate them at insert
          -- time. The partial unique index below enforces (source_id,
          -- source_markdown_slug, row_num) uniqueness only once row_num is
          -- set, so legacy NULL rows don't collide with each other or block
          -- the backfill.
          row_num               INTEGER,
          source_markdown_slug  TEXT
        );

        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'facts_source_id_fkey'
              AND conrelid = 'facts'::regclass
          ) THEN
            ALTER TABLE facts
              ADD CONSTRAINT facts_source_id_fkey
              FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE;
          END IF;
        END $$;

        CREATE INDEX IF NOT EXISTS idx_facts_entity_active
          ON facts(source_id, entity_slug, valid_from DESC)
          WHERE expired_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_facts_session
          ON facts(source_id, source_session, created_at DESC)
          WHERE expired_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_facts_since
          ON facts(source_id, created_at DESC)
          WHERE expired_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_facts_unconsolidated
          ON facts(source_id, entity_slug)
          WHERE consolidated_at IS NULL AND expired_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw
          ON facts USING hnsw (embedding ${opclass})
          WHERE embedding IS NOT NULL AND expired_at IS NULL;
      `;

      await engine.runMigration(40, factsDDL);

      // Step 3: enable RLS on Postgres when role has BYPASSRLS (v24/v29 pattern).
      // PGLite has no RLS engine.
      if (engine.kind === 'postgres') {
        await engine.runMigration(40, `
          DO $$
          DECLARE
            has_bypass BOOLEAN;
          BEGIN
            SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
            IF has_bypass THEN
              ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
            END IF;
          END $$;
        `);
      }
    },
  },
  {
    version: 46,
    name: 'mcp_request_log_params_jsonb_normalize',
    idempotent: true,
    // v0.31.3 wave (D-codex-2 / D1): mcp_request_log.params is JSONB, but
    // pre-v0.31.3 serve-http.ts wrote `JSON.stringify(...)` strings into it
    // via the postgres.js template tag's loose typing. The column was
    // technically JSONB but stored as a JSON-encoded string, so reads via
    // `params->>'op'` returned the encoded string '"search"' instead of
    // 'search'. The /admin/api/requests endpoint returned both shapes raw
    // to the SPA depending on row age.
    //
    // The v0.31.3 commit re-routes those INSERTs through executeRawJsonb,
    // which writes real objects. This one-shot UPDATE lifts existing
    // string-shaped rows up to objects so the read side sees one
    // consistent shape. Idempotent: subsequent runs find no rows where
    // jsonb_typeof = 'string' and the UPDATE is a no-op.
    //
    // `params #>> '{}'` extracts the underlying string at the top level,
    // then ::jsonb re-parses it as JSON. The `WHERE` filter guards against
    // running on already-object rows AND limits the unwrap to strings that
    // start with `{` (object-shaped) so a malformed legacy string can't
    // abort the migration.
    sql: `
      UPDATE mcp_request_log
        SET params = (params #>> '{}')::jsonb
        WHERE jsonb_typeof(params) = 'string'
          AND params #>> '{}' LIKE '{%';
    `,
  },
  {
    version: 47,
    name: 'facts_notability_alter',
    // v0.31.2 (B2 ship-blocker fix). Renumbered from v46 → v47 after the
    // merge from master picked up v0.31.3's mcp_request_log_params_jsonb_normalize
    // at v46. facts.notability column shipped via v45's inline CREATE TABLE
    // on fresh installs, but every brain that ran v45 BEFORE notability
    // landed in v45's blob is now missing the column. INSERT crashes with
    // "column does not exist" on first sync after upgrade.
    //
    // This migration is the ALTER counterpart for those existing brains.
    // Idempotent under all states:
    //   - Fresh install (v45 already added column): ADD COLUMN IF NOT EXISTS
    //     no-ops; named CHECK probe finds existing constraint → skip.
    //   - Old brain (no column): ADD COLUMN adds it with NOT NULL DEFAULT;
    //     named CHECK probe finds nothing → adds CHECK.
    //   - Partial state (column exists, no CHECK): ADD COLUMN no-ops;
    //     CHECK probe adds the named constraint.
    //
    // CHECK constraint is named `facts_notability_check` (named, not autogen)
    // so the idempotency probe can find it deterministically. If v45 inline
    // already created an autogen CHECK with identical semantics, the named
    // one is additive and non-conflicting (Postgres allows multiple CHECKs
    // covering the same predicate).
    //
    // Both engines run the same SQL — PGLite is real Postgres in WASM and
    // supports DO $$ blocks. PGLite users with older persistent brains hit
    // the same bug.
    sql: `
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS notability TEXT NOT NULL DEFAULT 'medium';

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'facts_notability_check'
            AND conrelid = 'facts'::regclass
        ) THEN
          ALTER TABLE facts ADD CONSTRAINT facts_notability_check
            CHECK (notability IN ('high','medium','low'));
        END IF;
      END $$;
    `,
  },
  {
    version: 48,
    name: 'takes_weight_round_to_grid',
    // v0.32.0 — Takes v2 wave (renumbered from v46 → v48 after merging master's
    // v0.31.3 wave which claimed v46 with mcp_request_log_params_jsonb_normalize).
    // Backfill the weight column to the 0.05 grid that v0.31's engine layer
    // enforces on insert (PR #795). Cross-modal eval over 100K production
    // takes flagged 0.74, 0.82-style values as false precision; the engine
    // now rounds new inserts to the grid, but pre-v0.32 rows still carry the
    // old precision and bias every query that reads weight (search ranking,
    // scorecard, calibration math).
    //
    // What `transaction: false` actually buys (codex review #2 correction):
    // it frees the migration runner from holding a long transaction across
    // the UPDATE so other gbrain processes (workers, MCP queries) can
    // interleave. It does NOT enable mid-statement resume — a single SQL
    // statement either completes or rolls back.
    //
    // Idempotency: the WHERE clause re-evaluates each row. After the first
    // complete pass every row is on-grid; a second invocation of the
    // migration is a zero-row UPDATE.
    //
    // The IS NOT NULL guard is cheap insurance against any stale schema
    // where weight was nullable; current schema (v28+) has NOT NULL.
    sql: `
      -- Tolerance-based comparison. weight is stored as REAL (float32), which
      -- has ~1e-7 representation noise. The 0.05 grid spacing is 5e-2. Any
      -- value with abs(weight - on_grid) > 1e-3 is genuinely off-grid; below
      -- that, the difference is float32 noise from prior round-trips and
      -- re-writing it would only re-introduce the same noise, not converge.
      -- (The naive "weight <> ROUND(...)" form fires every time because
      -- mixed REAL/NUMERIC comparison promotes weight to DOUBLE PRECISION
      -- first, surfacing the 1e-7 noise as inequality.)
      UPDATE takes
         SET weight = (ROUND(weight::numeric * 20) / 20)::real
       WHERE weight IS NOT NULL
         AND abs(weight::numeric - ROUND(weight::numeric * 20) / 20) > 0.001;
    `,
    transaction: false,
  },
  {
    version: 49,
    name: 'eval_takes_quality_runs',
    // v0.32 — Takes v2 wave (EXP-5). Renumbered from v47 → v49 after merging
    // master's v0.31.3 wave (v46 → mcp_request_log_params_jsonb_normalize).
    //
    // DB-authoritative store for the takes-quality eval CLI's receipts.
    // Codex review #6 corrected the original two-phase plan (split-brain
    // reconciliation gap) — DB row is the source of truth, the disk file
    // is a best-effort artifact.
    //
    // 4-sha unique key (corpus, prompt, model_set, rubric) so:
    //   - Re-running the same run is idempotent (ON CONFLICT DO NOTHING).
    //   - A future rubric tweak produces a different rubric_sha8 → distinct
    //     row → trend mode segregates by rubric_version (codex review #3).
    //
    // receipt_json carries the full receipt blob so `replay` can reconstruct
    // when the disk artifact is missing (DB-authoritative replay path).
    //
    // Index `(rubric_version, created_at DESC)` matches the trend query
    // shape: ORDER BY created_at DESC LIMIT N filtered by rubric_version.
    sql: `
      CREATE TABLE IF NOT EXISTS eval_takes_quality_runs (
        id                    BIGSERIAL    PRIMARY KEY,
        receipt_sha8_corpus   TEXT         NOT NULL,
        receipt_sha8_prompt   TEXT         NOT NULL,
        receipt_sha8_models   TEXT         NOT NULL,
        receipt_sha8_rubric   TEXT         NOT NULL,
        rubric_version        TEXT         NOT NULL,
        verdict               TEXT         NOT NULL CHECK (verdict IN ('pass','fail','inconclusive')),
        overall_score         REAL         NOT NULL,
        dim_scores            JSONB        NOT NULL,
        cost_usd              REAL         NOT NULL,
        receipt_json          JSONB        NOT NULL,
        receipt_disk_path     TEXT,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
        UNIQUE (receipt_sha8_corpus, receipt_sha8_prompt, receipt_sha8_models, receipt_sha8_rubric)
      );
      CREATE INDEX IF NOT EXISTS eval_takes_quality_runs_trend_idx
        ON eval_takes_quality_runs (rubric_version, created_at DESC);
    `,
  },
  {
    version: 50,
    name: 'ingest_log_source_id',
    // v0.31.2 (codex P1 #3). Renumbered from v47 → v50 after the merge from
    // master picked up v0.31.3's v46 + the takes v2 wave's v48 + v49.
    //
    // facts:absorb logging (commit 13 + doctor's facts_extraction_health
    // check in commit 12) needs source_id on ingest_log so multi-source
    // brains can scope failure counts per source. Pre-fix the column doesn't
    // exist; the schema.sql header even calls it out: "NOTE (v0.18.0 Step 1):
    // ingest_log.source_id is NOT added yet — lands in v17 alongside the
    // sync rewrite." Three years on, sync.ts writes ingest_log without
    // source_id and doctor only checks 'default'. This migration adds the
    // column + backfills existing rows to 'default' via NOT NULL DEFAULT.
    //
    // Idempotent under all states (matches v47's shape):
    //   - Fresh install: ALTER no-ops on IF NOT EXISTS.
    //   - Old brain (no column): ALTER adds it with NOT NULL DEFAULT 'default';
    //     existing rows inherit the default.
    //   - Re-run after success: IF NOT EXISTS short-circuits.
    //
    // Both engines run the same SQL; ingest_log is engine-agnostic.
    sql: `
      ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default';

      CREATE INDEX IF NOT EXISTS idx_ingest_log_source_type_created
        ON ingest_log (source_id, source_type, created_at DESC);
    `,
  },
  {
    version: 51,
    name: 'facts_fence_columns',
    // v0.32.2: facts join the system-of-record invariant. Markdown fences on
    // entity pages become canonical; the facts table becomes a derived index.
    // The fence parser keys each row by `row_num` (monotonic, append-only) and
    // ties it back to the page it lives on via `source_markdown_slug`.
    //
    // Two ADD COLUMN IF NOT EXISTS + one partial UNIQUE index. ALTERs are
    // metadata-only on PG 11+ and PGLite because the columns are NULL-DEFAULT
    // (no rewrite). Pre-v51 rows keep NULL until the v0_32_2 orchestrator
    // backfills them from the entity page's `## Facts` fence.
    //
    // Idempotent under all states (matches v50 shape):
    //   - Fresh install: the v40 CREATE TABLE block already includes the
    //     columns (post-v0.32.2 source); these ALTERs no-op on IF NOT EXISTS.
    //   - v0.31.x brain mid-upgrade: ALTERs add the columns; existing rows
    //     have NULL until backfill.
    //   - Re-run after success: ALTERs and index creation both short-circuit.
    //
    // Partial UNIQUE rationale: legacy NULL row_num rows must not collide
    // (multiple v0.31 facts about the same entity coexist before backfill).
    // The `WHERE row_num IS NOT NULL` clause makes the constraint inert for
    // legacy rows and fully enforced once the orchestrator assigns row_nums.
    //
    // Both engines run the same SQL; facts is engine-agnostic at the column
    // level. The partial-index syntax is supported by both Postgres and
    // PGLite. (Verified against migration v48's idx_facts_unconsolidated
    // partial-index precedent at line 2339.)
    sql: `
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS row_num              INTEGER;
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS source_markdown_slug TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_fence_key
        ON facts (source_id, source_markdown_slug, row_num)
        WHERE row_num IS NOT NULL;
    `,
  },
  {
    version: 52,
    name: 'eval_contradictions_cache',
    // v0.32.6 — P2 persistent judge cache for the contradiction probe.
    //
    // Composite primary key includes prompt_version + truncation_policy
    // (Codex outside-voice fix). Without these, a prompt edit would silently
    // serve stale verdicts to consumers. The cache key is the FULL
    // configuration that produced the verdict; bumping any component
    // invalidates prior entries cleanly.
    //
    // TTL via expires_at — readers can WHERE expires_at > now() to ignore
    // stale rows; an explicit DELETE WHERE expires_at <= now() sweep runs
    // periodically (lives in cache.ts orchestration, not here).
    //
    // verdict JSONB carries the full JudgeVerdict shape (contradicts,
    // severity, axis, confidence, resolution_kind) so a cache hit is a
    // complete answer without needing a second column.
    //
    // Idempotent across PGLite and Postgres; engine-agnostic DDL.
    sql: `
      CREATE TABLE IF NOT EXISTS eval_contradictions_cache (
        chunk_a_hash       TEXT         NOT NULL,
        chunk_b_hash       TEXT         NOT NULL,
        model_id           TEXT         NOT NULL,
        prompt_version     TEXT         NOT NULL,
        truncation_policy  TEXT         NOT NULL,
        verdict            JSONB        NOT NULL,
        created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
        expires_at         TIMESTAMPTZ  NOT NULL,
        PRIMARY KEY (chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy)
      );
      CREATE INDEX IF NOT EXISTS eval_contradictions_cache_expires_idx
        ON eval_contradictions_cache (expires_at);
    `,
  },
  {
    version: 53,
    name: 'eval_contradictions_runs',
    // v0.32.6 — M5 time-series tracking for the contradiction probe.
    //
    // One row per `gbrain eval suspected-contradictions` run. The headline
    // numbers (queries_evaluated, with_contradiction, total_flagged) plus
    // Wilson 95% CI bounds enable `gbrain eval suspected-contradictions
    // trend [--days N]` to plot brain consistency over time.
    //
    // report_json carries the full ProbeReport for replay/inspection.
    // source_tier_breakdown is also surfaced as a top-level JSONB column
    // so trend queries can group by tier without parsing the full report.
    //
    // No FK to other tables: this is an append-only metrics log, not a
    // relational record. Trend reads filter on ran_at.
    //
    // Idempotent across PGLite and Postgres.
    sql: `
      CREATE TABLE IF NOT EXISTS eval_contradictions_runs (
        run_id                       TEXT         PRIMARY KEY,
        ran_at                       TIMESTAMPTZ  NOT NULL DEFAULT now(),
        schema_version               INTEGER      NOT NULL DEFAULT 1,
        judge_model                  TEXT         NOT NULL,
        prompt_version               TEXT         NOT NULL,
        queries_evaluated            INTEGER      NOT NULL,
        queries_with_contradiction   INTEGER      NOT NULL,
        total_contradictions_flagged INTEGER      NOT NULL,
        wilson_ci_lower              REAL         NOT NULL,
        wilson_ci_upper              REAL         NOT NULL,
        judge_errors_total           INTEGER      NOT NULL,
        cost_usd_total               REAL         NOT NULL,
        duration_ms                  INTEGER      NOT NULL,
        source_tier_breakdown        JSONB        NOT NULL,
        report_json                  JSONB        NOT NULL
      );
      CREATE INDEX IF NOT EXISTS eval_contradictions_runs_ran_at_idx
        ON eval_contradictions_runs (ran_at DESC);
    `,
  },
  {
    version: 54,
    name: 'cjk_wave_pages_chunker_version_and_source_path',
    // v0.32.7 CJK fix wave. Two new columns on `pages` so the post-upgrade
    // reindex sweep can find markdown pages built by the old chunker AND so
    // sync's delete/rename code can resolve frontmatter-fallback slugs by
    // path (CJK files where path → slug is non-derivable).
    //
    //   chunker_version: bumped to 2 in this release. New imports populate
    //     it; existing rows inherit DEFAULT 1. `gbrain reindex --markdown`
    //     walks `WHERE chunker_version < 2 AND page_kind = 'markdown'`
    //     and re-imports each, bumping the column.
    //
    //   source_path: import-time repo-relative path. Lets sync's delete/
    //     rename resolve fallback slugs (`小米.md` w/ frontmatter slug →
    //     non-path-derivable). NULL for pre-migration rows; populated on
    //     next import / reindex.
    //
    // Both columns engine-agnostic. Partial indexes scope to the rows
    // we actually query (markdown-only chunker_version; non-NULL source_path).
    idempotent: true,
    sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS chunker_version SMALLINT NOT NULL DEFAULT 1;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_path TEXT;

      CREATE INDEX IF NOT EXISTS pages_chunker_version_idx
        ON pages (chunker_version) WHERE page_kind = 'markdown';

      CREATE INDEX IF NOT EXISTS pages_source_path_idx
        ON pages (source_path) WHERE source_path IS NOT NULL;
    `,
  },
  {
    version: 55,
    name: 'oauth_clients_source_id_fk',
    // v0.34.0 (#861 + D4 + D10 + D13 — P0 source-isolation leak seal).
    //
    // Adds oauth_clients.source_id, validates ALL existing rows can map to a
    // real source row, backfills NULL → 'default', and installs the FK with
    // ON DELETE SET NULL. PR #861's original migration claimed v47-v51; we
    // re-number to v55 because the branch already shipped through v54.
    //
    // D10 (codex outside-voice push-back): fail loud when stale source_id
    // rows exist instead of silently widening to NULL. Pre-fix this column
    // didn't exist; the only way a row has source_id IS a manual SQL poke,
    // so the stale-row branch fires only on operator-modified brains. The
    // GBRAIN_ACCEPT_SILENT_WIDEN=1 env var is the explicit opt-in for
    // operators who'd rather upgrade than psql-fix. Doctor surfaces orphan
    // rows post-clean via the v0.34.x follow-up TODO.
    //
    // D13: backfill NULL → 'default' BEFORE the FK ADD preserves the v0.33
    // effective behavior (legacy unscoped clients silently fell back to
    // 'default' via serve-http.ts:929 cast). Verify 'default' exists in
    // sources first — fresh brains have it from sources schema's default
    // seed; brains that scripted it out would otherwise wedge here.
    //
    // PGLite parity via the same DO blocks. PGLite supports DO/EXCEPTION
    // since 0.3; no engine branch needed.
    idempotent: true,
    sql: `
      -- v0.34.0 (#861 + D2 + D13 — P0 source-isolation leak seal).
      --
      -- This migration is intentionally lean: oauth_clients.source_id did
      -- NOT exist pre-v55, so the only state we inherit from upgrade is
      -- "rows with NULL source_id." Backfill those to 'default' (D13:
      -- preserves the pre-v0.34 effective fallback behavior verbatim) and
      -- install the FK with ON DELETE SET NULL.
      --
      -- D10 pre-clean is NOT NEEDED here: codex flagged the silent-widen
      -- footgun assuming source_id was an existing column with possibly-stale
      -- values. Since the column is brand new in this migration, the only
      -- post-backfill values are 'default' (which we just verified exists
      -- via the FK contract) plus any NULL the backfill left untouched
      -- because of WHERE-clause filtering — none possible. The
      -- GBRAIN_ACCEPT_SILENT_WIDEN env-flag stays in the runner for future
      -- migrations that need it; this one doesn't.

      -- 1. Add the column. NULL for every existing row.
      ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS source_id TEXT;

      -- 2. Backfill NULL → 'default'. Pre-v0.34 legacy clients then map
      --    to the same source the serve-http fallback chain used to put
      --    them in implicitly. No-op on fresh installs (no rows yet).
      UPDATE oauth_clients SET source_id = 'default' WHERE source_id IS NULL;

      -- 3. Install FK if not already present. The PGLite + Postgres fresh-
      --    install schemas (src/core/pglite-schema.ts, src/schema.sql) now
      --    include the FK inline on the CREATE TABLE, so this DO block
      --    skips on fresh installs and only fires on upgrade brains where
      --    oauth_clients was created pre-v55 without the FK. ON DELETE SET
      --    NULL matches the original PR #861 posture; #876 later flips to
      --    RESTRICT once federated_read provides the alternative
      --    scope-recovery path.
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'oauth_clients_source_id_fkey'
        ) THEN
          ALTER TABLE oauth_clients
            ADD CONSTRAINT oauth_clients_source_id_fkey
            FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL;
        END IF;
      END $$;

      -- 4. Index for token-verification lookups (verifyAccessToken's JOIN
      --    on oauth_clients.client_id → c.source_id). oauth_clients stays
      --    small so plain CREATE INDEX (no CONCURRENTLY) is fine.
      CREATE INDEX IF NOT EXISTS idx_oauth_clients_source_id
        ON oauth_clients(source_id) WHERE source_id IS NOT NULL;
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS.length > 0
  ? Math.max(...MIGRATIONS.map(m => m.version))
  : 1;

/**
 * Row returned by `getIdleBlockers`. The shape is the public contract
 * for both `gbrain doctor --locks` output and the internal DDL pre-flight.
 */
export interface IdleBlocker {
  pid: number;
  state: string;
  query_start: string;
  query: string;
}

/**
 * Find idle-in-transaction connections older than 5 minutes that might
 * block DDL. Postgres-only. Returns `[]` on PGLite, query failure, or
 * no blockers. The query-failure path is intentionally silent because
 * some managed Postgres configs restrict `pg_stat_activity` — a partial
 * view of the server is still useful for doctor/pre-flight.
 *
 * Single source of truth shared by:
 *   - `checkForBlockingConnections` (DDL pre-flight warning)
 *   - `gbrain doctor --locks` (CLI diagnostic)
 *   - any future `--exclusive` drain-wait logic
 */
export async function getIdleBlockers(engine: BrainEngine): Promise<IdleBlocker[]> {
  if (engine.kind !== 'postgres') return [];
  try {
    return await engine.executeRaw<IdleBlocker>(
      `SELECT pid, state, query_start::text, substring(query, 1, 120) as query
       FROM pg_stat_activity
       WHERE state = 'idle in transaction'
         AND query_start < NOW() - INTERVAL '5 minutes'
         AND pid != pg_backend_pid()`
    );
  } catch {
    return [];
  }
}

/**
 * Check for idle-in-transaction connections that might block DDL.
 * Returns true if blockers were found (logged as warnings).
 */
async function checkForBlockingConnections(engine: BrainEngine): Promise<boolean> {
  const rows = await getIdleBlockers(engine);
  if (rows.length > 0) {
    console.warn(`\n⚠️  Found ${rows.length} idle-in-transaction connection(s) older than 5 minutes:`);
    for (const r of rows) {
      console.warn(`  PID ${r.pid} — idle since ${r.query_start}`);
      console.warn(`    Query: ${r.query}`);
    }
    console.warn(`  These may block ALTER TABLE DDL. To kill: SELECT pg_terminate_backend(<pid>);\n`);
    return true;
  }
  return false;
}

/**
 * v0.30.1 (Cherry D3 / Finding F2): wrap a migration attempt in 3-attempt
 * retry+backoff (5s/15s/45s). Retry only on statement_timeout (57014) or
 * connection-reset patterns; other errors fail loud immediately.
 *
 * Before each retry: log idle-in-transaction blockers so the user knows
 * which PID is holding the lock. After exhaustion: throw
 * `MigrationRetryExhausted` with the named PID + suggested
 * pg_terminate_backend command.
 */
async function runMigrationSQLWithRetry(
  engine: BrainEngine,
  m: Migration,
  sql: string,
): Promise<void> {
  const { isStatementTimeoutError, isRetryableConnError } = await import('./retry-matcher.ts');
  // GBRAIN_MIGRATE_BACKOFF_MS lets tests skip the 5s/15s/45s backoff. In
  // production the env var is unset and the default cadence applies.
  const fastBackoff = process.env.GBRAIN_MIGRATE_BACKOFF_MS;
  const backoffs = fastBackoff !== undefined
    ? [parseInt(fastBackoff, 10) || 0, parseInt(fastBackoff, 10) || 0, parseInt(fastBackoff, 10) || 0]
    : [5000, 15000, 45000];
  let lastErr: Error | null = null;
  let lastBlockers: IdleBlocker[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Pre-attempt diagnostic: if there are idle blockers, log them so
      // the operator can see what we're racing against. Cherry D3.
      if (attempt > 0) {
        lastBlockers = await getIdleBlockers(engine);
        if (lastBlockers.length > 0) {
          console.warn(`  [retry ${attempt}/3] ${lastBlockers.length} idle-in-transaction blocker(s):`);
          for (const b of lastBlockers) {
            console.warn(`    PID ${b.pid} idle since ${b.query_start} — ${b.query.slice(0, 80)}`);
          }
        }
      }
      await runMigrationSQL(engine, m, sql);
      return;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const retryable = isStatementTimeoutError(err) || isRetryableConnError(err);
      if (!retryable || attempt === 2) {
        // Final failure: capture blockers + throw enriched envelope when
        // retry-eligible (named-PID UX from F2). Non-retryable errors fall
        // through to the existing 57014 handler in runMigrations.
        if (retryable) {
          lastBlockers = await getIdleBlockers(engine);
          throw new MigrationRetryExhausted(m.version, m.name, attempt + 1, lastBlockers, lastErr);
        }
        throw err;
      }
      const delay = backoffs[attempt];
      console.warn(`  [retry ${attempt + 1}/3] ${m.name} hit ${lastErr.message.slice(0, 80)}; retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  // Defensive: shouldn't reach here.
  if (lastErr) throw lastErr;
}

/**
 * Wrap migration SQL execution with Supabase-compatible timeout.
 * Uses SET LOCAL statement_timeout inside a transaction to override
 * server-enforced timeouts (required for Supabase Postgres).
 */
async function runMigrationSQL(
  engine: BrainEngine,
  m: Migration,
  sql: string,
): Promise<void> {
  const useTransaction = m.transaction !== false;

  if (useTransaction || engine.kind === 'pglite') {
    // Wrap in transaction with extended timeout for Supabase compatibility.
    // SET LOCAL scopes the timeout to this transaction only.
    await engine.transaction(async (tx) => {
      if (engine.kind === 'postgres') {
        try {
          await tx.runMigration(m.version, "SET LOCAL statement_timeout = '600000'");
        } catch {
          // Non-fatal: PGLite or older Postgres versions may not support this
        }
      }
      // v0.34.0 (#861 D10): expose the GBRAIN_ACCEPT_SILENT_WIDEN env
      // toggle to SQL via a session-local GUC so migration v55's pre-clean
      // can read it via current_setting('gbrain.accept_silent_widen').
      // Set per-transaction (SET LOCAL) so it never leaks to other
      // migrations or pooled connections. Tracked under the gbrain.* prefix
      // which Postgres permits for custom session-level variables.
      if (process.env.GBRAIN_ACCEPT_SILENT_WIDEN === '1') {
        try {
          await tx.runMigration(m.version, "SET LOCAL gbrain.accept_silent_widen = '1'");
        } catch {
          // Non-fatal — migration v55's DO block falls back to '0' on read failure.
        }
      }
      await tx.runMigration(m.version, sql);
    });
  } else {
    // Postgres + transaction:false → can't use SET LOCAL (needs a txn),
    // can't use plain SET on the pooled connection (leaks to other
    // queries). Instead: reserve a dedicated backend, set session-level
    // statement_timeout on just that connection, run the DDL there.
    //
    // On Supabase (both PgBouncer 6543 and direct 5432) a server-level
    // statement_timeout of ~2 min is enforced. Without this override a
    // CREATE INDEX CONCURRENTLY on a large table (e.g. 500K pages) hits
    // the timeout and aborts. SET on the reserved connection cleanly
    // overrides because the GUC scope is connection-local (session-scope
    // is fine when nobody else uses the connection).
    //
    // The reserved-connection primitive is new in PR #356. See
    // BrainEngine.withReservedConnection.
    await engine.withReservedConnection(async (conn) => {
      try {
        await conn.executeRaw("SET statement_timeout = '600000'");
      } catch {
        // Non-fatal: some managed Postgres may restrict this GUC.
        // Falling through means the DDL runs with the server default.
      }
      await conn.executeRaw(sql);
    });
  }
}

/**
 * Cheap probe: does this engine have schema migrations pending?
 *
 * Reads the `version` config row in a single round-trip (no schema replay,
 * no migration apply). Used by `connectEngine` to gate `initSchema()` so
 * short-lived CLI invocations on already-migrated brains don't pay the
 * full bootstrap-probe + SCHEMA_SQL replay + ledger-check cost on every
 * `gbrain stats` / `gbrain query` / `gbrain doctor`.
 *
 * Defensive: treats a getConfig failure (config table missing, query error)
 * as "yes pending" so the caller falls through to the full initSchema path.
 * Worst case on a wedged brain is one extra schema replay — same as before.
 *
 * Closes #651 in cooperation with the post-upgrade auto-apply hook (X1)
 * without the perf cost #652 would have introduced on every CLI call.
 */
export async function hasPendingMigrations(engine: BrainEngine): Promise<boolean> {
  try {
    const currentStr = await engine.getConfig('version');
    const current = parseInt(currentStr || '1', 10);
    return current < LATEST_VERSION;
  } catch {
    return true;
  }
}

export async function runMigrations(engine: BrainEngine): Promise<{ applied: number; current: number }> {
  const currentStr = await engine.getConfig('version');
  const current = parseInt(currentStr || '1', 10);

  // Sort by version ascending so array insertion order doesn't affect
  // correctness. Migrations MUST run in version order; if v16 accidentally
  // precedes v15 in MIGRATIONS, setConfig(version, 16) would cause v15 to
  // be skipped on the next iteration.
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  const pending = sorted.filter(m => m.version > current);
  if (pending.length === 0) {
    return { applied: 0, current };
  }

  console.log(`  Schema version ${current} → ${LATEST_VERSION} (${pending.length} migration(s) pending)`);

  // Pre-flight: warn about connections that might block DDL
  await checkForBlockingConnections(engine);

  let applied = 0;
  for (const m of pending) {
    console.log(`  [${m.version}] ${m.name}...`);

    // Pick SQL: engine-specific `sqlFor` wins over engine-agnostic `sql`.
    const sql = m.sqlFor?.[engine.kind] ?? m.sql;

    if (sql) {
      try {
        // v0.30.1: retry wrapper handles statement_timeout + conn-reset
        // across 3 attempts (5s/15s/45s). Other errors throw immediately.
        await runMigrationSQLWithRetry(engine, m, sql);
      } catch (err: unknown) {
        // Actionable diagnostics for statement timeout (Postgres error 57014).
        // Shape matches the 4-part error standard (what / why / fix / verify).
        const code = (err as { code?: string })?.code;
        if (code === '57014' || err instanceof MigrationRetryExhausted) {
          console.error(`\n❌ Migration ${m.version} (${m.name}) ${err instanceof MigrationRetryExhausted ? 'exhausted retries' : 'hit statement_timeout (SQLSTATE 57014)'}.`);
          if (err instanceof MigrationRetryExhausted && err.lastBlockers.length > 0) {
            const b = err.lastBlockers[0];
            console.error('');
            console.error(`   Likely blocker: PID ${b.pid}, idle since ${b.query_start}`);
            console.error(`   Query: ${b.query.slice(0, 120)}`);
            console.error('');
            console.error(`   Recovery: psql ... -c "SELECT pg_terminate_backend(${b.pid})"`);
            console.error('');
          } else {
            console.error('');
            console.error('   Cause: another connection holds a lock on the target table, or the');
            console.error('   server statement_timeout (~2 min on Supabase) is too short for this DDL.');
            console.error('');
            console.error('   Fix:');
            console.error('     1. gbrain doctor --locks    # find idle-in-transaction blockers');
            console.error('     2. Terminate blocker(s) shown by step 1 via pg_terminate_backend(<pid>)');
            console.error('     3. gbrain apply-migrations --yes  # re-run from the version that failed');
            console.error('');
          }
          console.error('   Verify:');
          console.error('     gbrain doctor              # schema_version should match latest');
          console.error('');
        }
        throw err;
      }
    }

    // Application-level handler (runs outside transaction for flexibility)
    if (m.handler) {
      await m.handler(engine);
    }

    // v0.30.1 (D6): post-condition probe. If a verify hook is declared, run
    // it before bumping config.version. When verify returns false, check
    // idempotent — if true, log + retry the same migration once; if false,
    // throw MigrationDriftError so operator runs --skip-verify deliberately.
    if (m.verify) {
      const verifyOk = await m.verify(engine).catch(() => false);
      if (!verifyOk) {
        const idempotent = isMigrationIdempotent(m);
        if (idempotent) {
          console.warn(`  [${m.version}] ⚠️  verify failed; re-running idempotent migration once`);
          if (sql) await runMigrationSQLWithRetry(engine, m, sql);
          if (m.handler) await m.handler(engine);
          // Best-effort: don't double-throw if second run still fails verify.
          // Operator's next run of doctor will re-detect drift.
        } else {
          throw new MigrationDriftError(
            m.version,
            m.name,
            `Schema does not match expected post-condition. Run with --skip-verify to force.`,
          );
        }
      }
    }

    // Update version after both SQL and handler succeed
    await engine.setConfig('version', String(m.version));
    console.log(`  [${m.version}] ✓ ${m.name}`);
    applied++;
  }

  return { applied, current: LATEST_VERSION };
}
