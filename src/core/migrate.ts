import type { BrainEngine } from './engine.ts';
import { buildFrontmatterSearchText } from './markdown.ts';
import { resolvePageChunkOptions } from './page-chunk-options.ts';
import { ensurePageChunks } from './page-chunks.ts';
import { buildPageCentroid } from './services/page-embedding.ts';
import { slugifyPath } from './sync.ts';
import type { Page } from './types.ts';

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
  sql: string;
  handler?: (engine: BrainEngine, context: MigrationContext) => Promise<void>;
}

type SqlMigrationEngine = BrainEngine & {
  runMigration(version: number, sql: string): Promise<void>;
};

type MigrationLog = (message: string) => void;

interface MigrationContext {
  log: MigrationLog;
}

export function shouldSilenceMigrationLogs(): boolean {
  return process.env.MBRAIN_TEST_SILENCE_MIGRATIONS === '1';
}

const defaultMigrationLog: MigrationLog = (message) => {
  if (!shouldSilenceMigrationLogs()) {
    console.log(message);
  }
};

// Migrations are embedded here, not loaded from files.
// Add new migrations at the end. Never modify existing ones.
const MIGRATIONS: Migration[] = [
  // Version 1 is the baseline (schema.sql creates everything with IF NOT EXISTS).
  {
    version: 2,
    name: 'slugify_existing_pages',
    sql: '',
    handler: async (engine, { log }) => {
      const pages = await listAllPages(engine);
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
            log(`  Warning: could not rename "${page.slug}" → "${newSlug}": ${msg}`);
          }
        }
      }
      if (renamed > 0) log(`  Renamed ${renamed} slugs`);
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
    name: 'pgvector_768_for_nomic',
    sql: `
      DROP INDEX IF EXISTS idx_chunks_embedding;
      ALTER TABLE content_chunks
        ALTER COLUMN embedding TYPE vector(768)
        USING NULL::vector(768);
      ALTER TABLE content_chunks
        ALTER COLUMN model SET DEFAULT 'nomic-embed-text';
      UPDATE content_chunks
      SET embedding = NULL,
          embedded_at = NULL,
          model = COALESCE((SELECT value FROM config WHERE key = 'embedding_model'), 'nomic-embed-text');
      INSERT INTO config (key, value) VALUES ('embedding_model', 'nomic-embed-text')
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO config (key, value) VALUES ('embedding_dimensions', '768')
      ON CONFLICT (key) DO NOTHING;
      CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
    `,
  },
  {
    version: 6,
    name: 'searchable_frontmatter',
    sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';
    `,
    handler: async (engine) => {
      const pages = await listAllPages(engine);
      const chunkOptions = await resolvePageChunkOptions(engine);
      for (const page of pages) {
        const searchText = buildFrontmatterSearchText(page.frontmatter);
        await backfillSearchText(engine, page.id, searchText);
        await ensurePageChunks(engine, page, chunkOptions);
      }
    },
  },
  {
    version: 7,
    name: 'page_embedding_upgrade',
    sql: '',
    handler: async (engine, { log }) => {
      await ensurePageEmbeddingColumn(engine);
      await backfillMissingPageEmbeddings(engine, log);
    },
  },
  {
    version: 8,
    name: 'task_memory_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS task_threads (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        repo_path TEXT,
        branch_name TEXT,
        current_summary TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_task_threads_status_updated ON task_threads(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_threads_scope_updated ON task_threads(scope, updated_at DESC);

      CREATE TABLE IF NOT EXISTS task_working_sets (
        task_id TEXT PRIMARY KEY REFERENCES task_threads(id) ON DELETE CASCADE,
        active_paths JSONB NOT NULL DEFAULT '[]',
        active_symbols JSONB NOT NULL DEFAULT '[]',
        blockers JSONB NOT NULL DEFAULT '[]',
        open_questions JSONB NOT NULL DEFAULT '[]',
        next_steps JSONB NOT NULL DEFAULT '[]',
        verification_notes JSONB NOT NULL DEFAULT '[]',
        last_verified_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS task_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES task_threads(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        outcome TEXT NOT NULL,
        applicability_context JSONB NOT NULL DEFAULT '{}',
        evidence JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_task_attempts_task_created ON task_attempts(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES task_threads(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        consequences JSONB NOT NULL DEFAULT '[]',
        validity_context JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_task_decisions_task_created ON task_decisions(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_traces (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
        scope TEXT NOT NULL,
        route JSONB NOT NULL DEFAULT '[]',
        source_refs JSONB NOT NULL DEFAULT '[]',
        verification JSONB NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_retrieval_traces_task_created ON retrieval_traces(task_id, created_at DESC);
    `,
  },
  {
    version: 9,
    name: 'note_manifest_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS note_manifest_entries (
        scope_id TEXT NOT NULL,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        path TEXT NOT NULL,
        page_type TEXT NOT NULL,
        title TEXT NOT NULL,
        frontmatter JSONB NOT NULL DEFAULT '{}',
        aliases JSONB NOT NULL DEFAULT '[]',
        tags JSONB NOT NULL DEFAULT '[]',
        outgoing_wikilinks JSONB NOT NULL DEFAULT '[]',
        outgoing_urls JSONB NOT NULL DEFAULT '[]',
        source_refs JSONB NOT NULL DEFAULT '[]',
        heading_index JSONB NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope_id, page_id)
      );
      CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_slug
        ON note_manifest_entries(scope_id, slug);
      CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_indexed
        ON note_manifest_entries(scope_id, last_indexed_at DESC);
    `,
  },
  {
    version: 10,
    name: 'note_section_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS note_section_entries (
        scope_id TEXT NOT NULL,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        page_slug TEXT NOT NULL,
        page_path TEXT NOT NULL,
        section_id TEXT NOT NULL,
        parent_section_id TEXT,
        heading_slug TEXT NOT NULL,
        heading_path JSONB NOT NULL DEFAULT '[]',
        heading_text TEXT NOT NULL,
        depth INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        section_text TEXT NOT NULL,
        outgoing_wikilinks JSONB NOT NULL DEFAULT '[]',
        outgoing_urls JSONB NOT NULL DEFAULT '[]',
        source_refs JSONB NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope_id, section_id)
      );
      CREATE INDEX IF NOT EXISTS idx_note_sections_scope_page
        ON note_section_entries(scope_id, page_slug, line_start);
      CREATE INDEX IF NOT EXISTS idx_note_sections_scope_indexed
        ON note_section_entries(scope_id, last_indexed_at DESC);
    `,
  },
  {
    version: 11,
    name: 'context_map_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS context_map_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        build_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        source_set_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL,
        community_count INTEGER NOT NULL DEFAULT 0,
        graph_json JSONB NOT NULL DEFAULT '{}',
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        stale_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_context_map_scope_generated
        ON context_map_entries(scope_id, generated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_context_map_scope_kind
        ON context_map_entries(scope_id, kind);
    `,
  },
  {
    version: 12,
    name: 'context_atlas_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS context_atlas_entries (
        id TEXT PRIMARY KEY,
        map_id TEXT NOT NULL REFERENCES context_map_entries(id) ON DELETE CASCADE,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        freshness TEXT NOT NULL,
        entrypoints JSONB NOT NULL DEFAULT '[]',
        budget_hint INTEGER NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_context_atlas_scope_generated
        ON context_atlas_entries(scope_id, generated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_context_atlas_scope_kind
        ON context_atlas_entries(scope_id, kind);
    `,
  },
  {
    version: 13,
    name: 'profile_memory_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS profile_memory_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        profile_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        source_refs JSONB NOT NULL DEFAULT '[]',
        sensitivity TEXT NOT NULL,
        export_status TEXT NOT NULL,
        last_confirmed_at TIMESTAMPTZ,
        superseded_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_profile_memory_scope_subject
        ON profile_memory_entries(scope_id, subject);
      CREATE INDEX IF NOT EXISTS idx_profile_memory_scope_type
        ON profile_memory_entries(scope_id, profile_type, updated_at DESC);
    `,
  },
  {
    version: 14,
    name: 'personal_episode_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS personal_episode_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        title TEXT NOT NULL,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ,
        source_kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_refs JSONB NOT NULL DEFAULT '[]',
        candidate_ids JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_personal_episode_scope_start
        ON personal_episode_entries(scope_id, start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_personal_episode_scope_title
        ON personal_episode_entries(scope_id, title);
    `,
  },
  {
    version: 15,
    name: 'memory_inbox_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_candidate_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        candidate_type TEXT NOT NULL CHECK (candidate_type IN ('fact', 'relationship', 'note_update', 'procedure', 'profile_update', 'open_question', 'rationale')),
        proposed_content TEXT NOT NULL,
        source_refs JSONB NOT NULL DEFAULT '[]',
        generated_by TEXT NOT NULL CHECK (generated_by IN ('agent', 'map_analysis', 'dream_cycle', 'manual', 'import')),
        extraction_kind TEXT NOT NULL CHECK (extraction_kind IN ('extracted', 'inferred', 'ambiguous', 'manual')),
        confidence_score DOUBLE PRECISION NOT NULL,
        importance_score DOUBLE PRECISION NOT NULL,
        recurrence_score DOUBLE PRECISION NOT NULL,
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'work', 'personal', 'secret', 'unknown')),
        status TEXT NOT NULL CHECK (status IN ('captured', 'candidate', 'staged_for_review')),
        target_object_type TEXT CHECK (target_object_type IS NULL OR target_object_type IN ('curated_note', 'procedure', 'profile_memory', 'personal_episode', 'other')),
        target_object_id TEXT,
        reviewed_at TIMESTAMPTZ,
        review_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_status
        ON memory_candidate_entries(scope_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_type
        ON memory_candidate_entries(scope_id, candidate_type, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_target
        ON memory_candidate_entries(target_object_type, target_object_id);
    `,
  },
  {
    version: 16,
    name: 'memory_inbox_rejection_slice',
    sql: `
      ALTER TABLE memory_candidate_entries
        DROP CONSTRAINT IF EXISTS memory_candidate_entries_status_check;
      ALTER TABLE memory_candidate_entries
        ADD CONSTRAINT memory_candidate_entries_status_check
        CHECK (status IN ('captured', 'candidate', 'staged_for_review', 'rejected'));
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_status
        ON memory_candidate_entries(scope_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_type
        ON memory_candidate_entries(scope_id, candidate_type, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_target
        ON memory_candidate_entries(target_object_type, target_object_id);
    `,
  },
  {
    version: 17,
    name: 'memory_inbox_promotion_slice',
    sql: `
      ALTER TABLE memory_candidate_entries
        DROP CONSTRAINT IF EXISTS memory_candidate_entries_status_check;
      ALTER TABLE memory_candidate_entries
        ADD CONSTRAINT memory_candidate_entries_status_check
        CHECK (status IN ('captured', 'candidate', 'staged_for_review', 'rejected', 'promoted'));
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_status
        ON memory_candidate_entries(scope_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_type
        ON memory_candidate_entries(scope_id, candidate_type, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_target
        ON memory_candidate_entries(target_object_type, target_object_id);
    `,
  },
  {
    version: 18,
    name: 'memory_inbox_supersession_slice',
    sql: `
      ALTER TABLE memory_candidate_entries
        DROP CONSTRAINT IF EXISTS memory_candidate_entries_status_check;
      ALTER TABLE memory_candidate_entries
        ADD CONSTRAINT memory_candidate_entries_status_check
        CHECK (status IN ('captured', 'candidate', 'staged_for_review', 'rejected', 'promoted', 'superseded'));
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_status
        ON memory_candidate_entries(scope_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_type
        ON memory_candidate_entries(scope_id, candidate_type, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_target
        ON memory_candidate_entries(target_object_type, target_object_id);

      CREATE TABLE IF NOT EXISTS memory_candidate_supersession_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        superseded_candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidate_entries(id),
        replacement_candidate_id TEXT NOT NULL REFERENCES memory_candidate_entries(id),
        reviewed_at TIMESTAMPTZ,
        review_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (superseded_candidate_id <> replacement_candidate_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_supersession_scope
        ON memory_candidate_supersession_entries(scope_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_supersession_replacement
        ON memory_candidate_supersession_entries(replacement_candidate_id);
      CREATE OR REPLACE FUNCTION enforce_memory_candidate_superseded_link_v18()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'superseded'
          AND NOT EXISTS (
            SELECT 1
            FROM memory_candidate_supersession_entries
            WHERE superseded_candidate_id = NEW.id
          ) THEN
          RAISE EXCEPTION 'superseded candidate requires a supersession link record';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_memory_candidate_superseded_link_v18 ON memory_candidate_entries;
      CREATE TRIGGER trg_memory_candidate_superseded_link_v18
      BEFORE INSERT OR UPDATE ON memory_candidate_entries
      FOR EACH ROW
      EXECUTE FUNCTION enforce_memory_candidate_superseded_link_v18();
    `,
  },
  {
    version: 19,
    name: 'memory_inbox_contradiction_slice',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_candidate_contradiction_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL REFERENCES memory_candidate_entries(id),
        challenged_candidate_id TEXT NOT NULL REFERENCES memory_candidate_entries(id),
        outcome TEXT NOT NULL CHECK (outcome IN ('rejected', 'unresolved', 'superseded')),
        supersession_entry_id TEXT REFERENCES memory_candidate_supersession_entries(id),
        reviewed_at TIMESTAMPTZ,
        review_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (candidate_id <> challenged_candidate_id),
        CHECK (
          (outcome = 'superseded' AND supersession_entry_id IS NOT NULL)
          OR (outcome IN ('rejected', 'unresolved') AND supersession_entry_id IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_contradiction_scope
        ON memory_candidate_contradiction_entries(scope_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_contradiction_candidate
        ON memory_candidate_contradiction_entries(candidate_id);
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_contradiction_challenged
        ON memory_candidate_contradiction_entries(challenged_candidate_id);
    `,
  },
  {
    version: 20,
    name: 'canonical_handoff_records',
    sql: `
      CREATE TABLE IF NOT EXISTS canonical_handoff_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidate_entries(id),
        target_object_type TEXT NOT NULL CHECK (target_object_type IN ('curated_note', 'procedure', 'profile_memory', 'personal_episode')),
        target_object_id TEXT NOT NULL,
        source_refs JSONB NOT NULL DEFAULT '[]',
        reviewed_at TIMESTAMPTZ,
        review_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_canonical_handoff_scope
        ON canonical_handoff_entries(scope_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_canonical_handoff_target
        ON canonical_handoff_entries(target_object_type, target_object_id);
    `,
  },
  {
    version: 21,
    name: 'interaction_id_on_event_rows',
    sql: `
      ALTER TABLE canonical_handoff_entries
        ADD COLUMN IF NOT EXISTS interaction_id TEXT;
      ALTER TABLE memory_candidate_supersession_entries
        ADD COLUMN IF NOT EXISTS interaction_id TEXT;
      ALTER TABLE memory_candidate_contradiction_entries
        ADD COLUMN IF NOT EXISTS interaction_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_canonical_handoff_interaction
        ON canonical_handoff_entries(interaction_id)
        WHERE interaction_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_supersession_interaction
        ON memory_candidate_supersession_entries(interaction_id)
        WHERE interaction_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_contradiction_interaction
        ON memory_candidate_contradiction_entries(interaction_id)
        WHERE interaction_id IS NOT NULL;
    `,
  },
  {
    version: 22,
    name: 'postgres_jsonb_scalar_string_repair',
    sql: `
      CREATE OR REPLACE FUNCTION mbrain_repair_jsonb_scalar_string(value JSONB, expected_types TEXT[])
      RETURNS JSONB AS $$
      DECLARE
        parsed JSONB;
      BEGIN
        IF jsonb_typeof(value) <> 'string' THEN
          RETURN value;
        END IF;

        BEGIN
          parsed := (value #>> '{}')::jsonb;
        EXCEPTION WHEN others THEN
          RETURN value;
        END;

        IF jsonb_typeof(parsed) = ANY(expected_types) THEN
          RETURN parsed;
        END IF;

        RETURN value;
      END;
      $$ LANGUAGE plpgsql;

      DO $$
      BEGIN
        IF to_regclass('pages') IS NOT NULL THEN
          UPDATE pages
          SET frontmatter = mbrain_repair_jsonb_scalar_string(frontmatter, ARRAY['object'])
          WHERE jsonb_typeof(frontmatter) = 'string';
        END IF;

        IF to_regclass('raw_data') IS NOT NULL THEN
          UPDATE raw_data
          SET data = mbrain_repair_jsonb_scalar_string(data, ARRAY['object', 'array'])
          WHERE jsonb_typeof(data) = 'string';
        END IF;

        IF to_regclass('page_versions') IS NOT NULL THEN
          UPDATE page_versions
          SET frontmatter = mbrain_repair_jsonb_scalar_string(frontmatter, ARRAY['object'])
          WHERE jsonb_typeof(frontmatter) = 'string';
        END IF;

        IF to_regclass('ingest_log') IS NOT NULL THEN
          UPDATE ingest_log
          SET pages_updated = mbrain_repair_jsonb_scalar_string(pages_updated, ARRAY['array'])
          WHERE jsonb_typeof(pages_updated) = 'string';
        END IF;

        IF to_regclass('task_working_sets') IS NOT NULL THEN
          UPDATE task_working_sets
          SET active_paths = mbrain_repair_jsonb_scalar_string(active_paths, ARRAY['array']),
              active_symbols = mbrain_repair_jsonb_scalar_string(active_symbols, ARRAY['array']),
              blockers = mbrain_repair_jsonb_scalar_string(blockers, ARRAY['array']),
              open_questions = mbrain_repair_jsonb_scalar_string(open_questions, ARRAY['array']),
              next_steps = mbrain_repair_jsonb_scalar_string(next_steps, ARRAY['array']),
              verification_notes = mbrain_repair_jsonb_scalar_string(verification_notes, ARRAY['array'])
          WHERE jsonb_typeof(active_paths) = 'string'
             OR jsonb_typeof(active_symbols) = 'string'
             OR jsonb_typeof(blockers) = 'string'
             OR jsonb_typeof(open_questions) = 'string'
             OR jsonb_typeof(next_steps) = 'string'
             OR jsonb_typeof(verification_notes) = 'string';
        END IF;

        IF to_regclass('task_attempts') IS NOT NULL THEN
          UPDATE task_attempts
          SET applicability_context = mbrain_repair_jsonb_scalar_string(applicability_context, ARRAY['object']),
              evidence = mbrain_repair_jsonb_scalar_string(evidence, ARRAY['array'])
          WHERE jsonb_typeof(applicability_context) = 'string'
             OR jsonb_typeof(evidence) = 'string';
        END IF;

        IF to_regclass('task_decisions') IS NOT NULL THEN
          UPDATE task_decisions
          SET consequences = mbrain_repair_jsonb_scalar_string(consequences, ARRAY['array']),
              validity_context = mbrain_repair_jsonb_scalar_string(validity_context, ARRAY['object'])
          WHERE jsonb_typeof(consequences) = 'string'
             OR jsonb_typeof(validity_context) = 'string';
        END IF;

        IF to_regclass('retrieval_traces') IS NOT NULL THEN
          UPDATE retrieval_traces
          SET route = mbrain_repair_jsonb_scalar_string(route, ARRAY['array']),
              source_refs = mbrain_repair_jsonb_scalar_string(source_refs, ARRAY['array']),
              verification = mbrain_repair_jsonb_scalar_string(verification, ARRAY['array'])
          WHERE jsonb_typeof(route) = 'string'
             OR jsonb_typeof(source_refs) = 'string'
             OR jsonb_typeof(verification) = 'string';
        END IF;

        IF to_regclass('profile_memory_entries') IS NOT NULL THEN
          UPDATE profile_memory_entries
          SET source_refs = mbrain_repair_jsonb_scalar_string(source_refs, ARRAY['array'])
          WHERE jsonb_typeof(source_refs) = 'string';
        END IF;

        IF to_regclass('personal_episode_entries') IS NOT NULL THEN
          UPDATE personal_episode_entries
          SET source_refs = mbrain_repair_jsonb_scalar_string(source_refs, ARRAY['array']),
              candidate_ids = mbrain_repair_jsonb_scalar_string(candidate_ids, ARRAY['array'])
          WHERE jsonb_typeof(source_refs) = 'string'
             OR jsonb_typeof(candidate_ids) = 'string';
        END IF;

        IF to_regclass('memory_candidate_entries') IS NOT NULL THEN
          UPDATE memory_candidate_entries
          SET source_refs = mbrain_repair_jsonb_scalar_string(source_refs, ARRAY['array'])
          WHERE jsonb_typeof(source_refs) = 'string';
        END IF;

        IF to_regclass('canonical_handoff_entries') IS NOT NULL THEN
          UPDATE canonical_handoff_entries
          SET source_refs = mbrain_repair_jsonb_scalar_string(source_refs, ARRAY['array'])
          WHERE jsonb_typeof(source_refs) = 'string';
        END IF;

        IF to_regclass('note_manifest_entries') IS NOT NULL THEN
          UPDATE note_manifest_entries
          SET frontmatter = mbrain_repair_jsonb_scalar_string(frontmatter, ARRAY['object']),
              aliases = mbrain_repair_jsonb_scalar_string(aliases, ARRAY['array']),
              tags = mbrain_repair_jsonb_scalar_string(tags, ARRAY['array']),
              outgoing_wikilinks = mbrain_repair_jsonb_scalar_string(outgoing_wikilinks, ARRAY['array']),
              outgoing_urls = mbrain_repair_jsonb_scalar_string(outgoing_urls, ARRAY['array']),
              source_refs = mbrain_repair_jsonb_scalar_string(source_refs, ARRAY['array']),
              heading_index = mbrain_repair_jsonb_scalar_string(heading_index, ARRAY['array'])
          WHERE jsonb_typeof(frontmatter) = 'string'
             OR jsonb_typeof(aliases) = 'string'
             OR jsonb_typeof(tags) = 'string'
             OR jsonb_typeof(outgoing_wikilinks) = 'string'
             OR jsonb_typeof(outgoing_urls) = 'string'
             OR jsonb_typeof(source_refs) = 'string'
             OR jsonb_typeof(heading_index) = 'string';
        END IF;

        IF to_regclass('note_section_entries') IS NOT NULL THEN
          UPDATE note_section_entries
          SET heading_path = mbrain_repair_jsonb_scalar_string(heading_path, ARRAY['array']),
              outgoing_wikilinks = mbrain_repair_jsonb_scalar_string(outgoing_wikilinks, ARRAY['array']),
              outgoing_urls = mbrain_repair_jsonb_scalar_string(outgoing_urls, ARRAY['array']),
              source_refs = mbrain_repair_jsonb_scalar_string(source_refs, ARRAY['array'])
          WHERE jsonb_typeof(heading_path) = 'string'
             OR jsonb_typeof(outgoing_wikilinks) = 'string'
             OR jsonb_typeof(outgoing_urls) = 'string'
             OR jsonb_typeof(source_refs) = 'string';
        END IF;

        IF to_regclass('context_map_entries') IS NOT NULL THEN
          UPDATE context_map_entries
          SET graph_json = mbrain_repair_jsonb_scalar_string(graph_json, ARRAY['object'])
          WHERE jsonb_typeof(graph_json) = 'string';
        END IF;

        IF to_regclass('context_atlas_entries') IS NOT NULL THEN
          UPDATE context_atlas_entries
          SET entrypoints = mbrain_repair_jsonb_scalar_string(entrypoints, ARRAY['array'])
          WHERE jsonb_typeof(entrypoints) = 'string';
        END IF;

        IF to_regclass('files') IS NOT NULL THEN
          UPDATE files
          SET metadata = mbrain_repair_jsonb_scalar_string(metadata, ARRAY['object'])
          WHERE jsonb_typeof(metadata) = 'string';
        END IF;
      END $$;

      DROP FUNCTION IF EXISTS mbrain_repair_jsonb_scalar_string(JSONB, TEXT[]);
    `,
  },
  {
    version: 23,
    name: 'retrieval_trace_fidelity_columns',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('retrieval_traces') IS NOT NULL THEN
          ALTER TABLE retrieval_traces
            ADD COLUMN IF NOT EXISTS derived_consulted JSONB NOT NULL DEFAULT '[]';
          ALTER TABLE retrieval_traces
            ADD COLUMN IF NOT EXISTS write_outcome TEXT NOT NULL DEFAULT 'no_durable_write'
            CHECK (write_outcome IN (
              'no_durable_write',
              'operational_write',
              'candidate_created',
              'promoted',
              'rejected',
              'superseded'
            ));
          ALTER TABLE retrieval_traces
            ADD COLUMN IF NOT EXISTS selected_intent TEXT
            CHECK (selected_intent IS NULL OR selected_intent IN (
              'task_resume',
              'broad_synthesis',
              'precision_lookup',
              'mixed_scope_bridge',
              'personal_profile_lookup',
              'personal_episode_lookup'
            ));
          ALTER TABLE retrieval_traces
            ADD COLUMN IF NOT EXISTS scope_gate_policy TEXT
            CHECK (scope_gate_policy IS NULL OR scope_gate_policy IN ('allow', 'deny', 'defer'));
          ALTER TABLE retrieval_traces
            ADD COLUMN IF NOT EXISTS scope_gate_reason TEXT;

          WITH backfill AS (
            SELECT rt.id, substring(entry.value FROM 8) AS selected_intent
            FROM retrieval_traces rt
            CROSS JOIN LATERAL jsonb_array_elements_text(rt.verification) AS entry(value)
            WHERE entry.value LIKE 'intent:%'
              AND substring(entry.value FROM 8) IN (
                'task_resume',
                'broad_synthesis',
                'precision_lookup',
                'mixed_scope_bridge',
                'personal_profile_lookup',
                'personal_episode_lookup'
              )
          )
          UPDATE retrieval_traces rt
          SET selected_intent = backfill.selected_intent
          FROM backfill
          WHERE rt.id = backfill.id
            AND rt.selected_intent IS NULL;

          WITH gate_backfill AS (
            SELECT
              rt.id,
              max(CASE
                WHEN entry.value LIKE 'scope_gate:%' THEN substring(entry.value FROM 12)
                ELSE NULL
              END) AS scope_gate_policy,
              max(CASE
                WHEN entry.value LIKE 'scope_gate_reason:%' THEN substring(entry.value FROM 19)
                ELSE NULL
              END) AS scope_gate_reason
            FROM retrieval_traces rt
            CROSS JOIN LATERAL jsonb_array_elements_text(rt.verification) AS entry(value)
            WHERE entry.value LIKE 'scope_gate:%'
               OR entry.value LIKE 'scope_gate_reason:%'
            GROUP BY rt.id
          )
          UPDATE retrieval_traces rt
          SET scope_gate_policy = COALESCE(
                CASE
                  WHEN gate_backfill.scope_gate_policy IN ('allow', 'deny', 'defer')
                    THEN gate_backfill.scope_gate_policy
                  ELSE NULL
                END,
                rt.scope_gate_policy
              ),
              scope_gate_reason = COALESCE(gate_backfill.scope_gate_reason, rt.scope_gate_reason)
          FROM gate_backfill
          WHERE rt.id = gate_backfill.id
            AND (
              (rt.scope_gate_policy IS NULL AND gate_backfill.scope_gate_policy IN ('allow', 'deny', 'defer'))
              OR (rt.scope_gate_reason IS NULL AND gate_backfill.scope_gate_reason IS NOT NULL)
            );

          CREATE INDEX IF NOT EXISTS idx_retrieval_traces_write_outcome
            ON retrieval_traces(write_outcome, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_retrieval_traces_selected_intent
            ON retrieval_traces(selected_intent, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_retrieval_traces_gate_policy
            ON retrieval_traces(scope_gate_policy, created_at DESC)
            WHERE scope_gate_policy IS NOT NULL;
        END IF;
      END $$;
    `,
  },
  {
    version: 24,
    name: 'brain_loop_audit_window_indexes',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('retrieval_traces') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_retrieval_traces_created
            ON retrieval_traces(created_at DESC, id DESC);
          CREATE INDEX IF NOT EXISTS idx_retrieval_traces_scope_created
            ON retrieval_traces(scope, created_at DESC, id DESC);
        END IF;

        IF to_regclass('memory_candidate_entries') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_memory_candidates_created
            ON memory_candidate_entries(created_at DESC, id ASC);
          CREATE INDEX IF NOT EXISTS idx_memory_candidates_status_reviewed
            ON memory_candidate_entries(status, reviewed_at DESC, id ASC)
            WHERE reviewed_at IS NOT NULL;
        END IF;
      END $$;
    `,
  },
  {
    version: 25,
    name: 'memory_candidate_status_events',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_candidate_status_events (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        from_status TEXT CHECK (
          from_status IS NULL
          OR from_status IN ('captured', 'candidate', 'staged_for_review', 'promoted', 'rejected', 'superseded')
        ),
        to_status TEXT NOT NULL CHECK (
          to_status IN ('captured', 'candidate', 'staged_for_review', 'promoted', 'rejected', 'superseded')
        ),
        event_kind TEXT NOT NULL CHECK (
          event_kind IN ('created', 'advanced', 'promoted', 'rejected', 'superseded')
        ),
        interaction_id TEXT,
        reviewed_at TIMESTAMPTZ,
        review_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_status_events_candidate_created
        ON memory_candidate_status_events(candidate_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_status_events_interaction
        ON memory_candidate_status_events(interaction_id)
        WHERE interaction_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_status_events_scope_created
        ON memory_candidate_status_events(scope_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidate_status_events_kind_created
        ON memory_candidate_status_events(event_kind, created_at DESC, id DESC);
      DO $$
      BEGIN
        IF to_regclass('memory_candidate_entries') IS NOT NULL THEN
          INSERT INTO memory_candidate_status_events (
            id, candidate_id, scope_id, from_status, to_status, event_kind,
            interaction_id, reviewed_at, review_reason, created_at
          )
          SELECT
            'candidate-status-created:' || id,
            id,
            scope_id,
            NULL,
            status,
            'created',
            NULL,
            reviewed_at,
            review_reason,
            created_at
          FROM memory_candidate_entries
          WHERE status IN ('captured', 'candidate', 'staged_for_review')
          ON CONFLICT (id) DO NOTHING;
        END IF;
      END $$;
    `,
  },
  {
    version: 26,
    name: 'memory_mutation_events',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_mutation_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        realm_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        operation TEXT NOT NULL CONSTRAINT chk_memory_mutation_events_operation CHECK (
          operation IN (
            'create_memory_session',
            'close_memory_session',
            'expire_memory_session',
            'revoke_memory_session',
            'dry_run_memory_mutation',
            'list_memory_mutation_events',
            'record_memory_mutation_event',
            'create_memory_patch_candidate',
            'dry_run_memory_patch_candidate',
            'review_memory_patch_candidate',
            'apply_memory_patch_candidate',
            'create_redaction_plan',
            'dry_run_redaction_plan',
            'execute_redaction_plan',
            'put_page',
            'delete_page',
            'upsert_profile_memory_entry',
            'write_profile_memory_entry',
            'delete_profile_memory_entry',
            'record_personal_episode',
            'write_personal_episode_entry',
            'delete_personal_episode_entry',
            'upsert_memory_realm',
            'create_memory_candidate_entry',
            'advance_memory_candidate_status',
            'reject_memory_candidate_entry',
            'delete_memory_candidate_entry',
            'promote_memory_candidate_entry',
            'supersede_memory_candidate_entry',
            'export_memory_artifact',
            'sync_memory_artifact',
            'repair_memory_ledger',
            'physical_delete_memory_record',
            'governed_canonical_write',
            'pause_source_processing',
            'revoke_source_consent',
            'rerun_memory_job'
          )
        ),
        target_kind TEXT NOT NULL CONSTRAINT chk_memory_mutation_events_target_kind CHECK (
          target_kind IN (
            'page',
            'source_record',
            'task_thread',
            'working_set',
            'task_event',
            'task_episode',
            'attempt',
            'decision',
            'procedure',
            'memory_candidate',
            'memory_patch_candidate',
            'profile_memory',
            'personal_episode',
            'memory_realm',
            'context_map',
            'context_atlas',
            'file_artifact',
            'export_artifact',
            'ledger_event'
          )
        ),
        target_id TEXT,
        scope_id TEXT,
        source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected_target_snapshot_hash TEXT,
        current_target_snapshot_hash TEXT,
        result TEXT NOT NULL CHECK (
          result IN (
            'dry_run',
            'staged_for_review',
            'approved',
            'applied',
            'conflict',
            'denied',
            'failed',
            'redacted'
          )
        ),
        conflict_info JSONB,
        dry_run BOOLEAN NOT NULL DEFAULT false,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        redaction_visibility TEXT NOT NULL DEFAULT 'visible' CHECK (
          redaction_visibility IN ('visible', 'partially_redacted', 'tombstoned')
        ),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        decided_at TIMESTAMPTZ,
        applied_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_events_session_created
        ON memory_mutation_events(session_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_events_realm_created
        ON memory_mutation_events(realm_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_events_actor_created
        ON memory_mutation_events(actor, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_events_operation_created
        ON memory_mutation_events(operation, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_events_target
        ON memory_mutation_events(target_kind, target_id);
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_events_result_created
        ON memory_mutation_events(result, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_events_scope_created
        ON memory_mutation_events(scope_id, created_at DESC, id DESC)
        WHERE scope_id IS NOT NULL;
    `,
  },
  {
    version: 27,
    name: 'memory_mutation_events_operation_contract_repair',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('memory_mutation_events') IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'memory_mutation_events'::regclass
              AND conname = 'chk_memory_mutation_events_operation'
          ) THEN
            ALTER TABLE memory_mutation_events
              ADD CONSTRAINT chk_memory_mutation_events_operation
              CHECK (
                operation IN (
                  'create_memory_session',
                  'close_memory_session',
                  'expire_memory_session',
                  'revoke_memory_session',
                  'dry_run_memory_mutation',
                  'list_memory_mutation_events',
                  'record_memory_mutation_event',
                  'create_memory_patch_candidate',
                  'dry_run_memory_patch_candidate',
                  'review_memory_patch_candidate',
                  'apply_memory_patch_candidate',
                  'create_redaction_plan',
                  'dry_run_redaction_plan',
                  'execute_redaction_plan',
                  'put_page',
                  'delete_page',
                  'upsert_profile_memory_entry',
                  'write_profile_memory_entry',
                  'delete_profile_memory_entry',
                  'record_personal_episode',
                  'write_personal_episode_entry',
                  'delete_personal_episode_entry',
                  'upsert_memory_realm',
                  'create_memory_candidate_entry',
                  'advance_memory_candidate_status',
                  'reject_memory_candidate_entry',
                  'delete_memory_candidate_entry',
                  'promote_memory_candidate_entry',
                  'supersede_memory_candidate_entry',
                  'export_memory_artifact',
                  'sync_memory_artifact',
                  'repair_memory_ledger',
                  'physical_delete_memory_record',
                  'governed_canonical_write',
                  'pause_source_processing',
                  'revoke_source_consent',
                  'rerun_memory_job'
                )
              );
          END IF;
        END IF;
      END $$;
      DROP INDEX IF EXISTS idx_memory_mutation_events_scope_created;
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_events_scope_created
        ON memory_mutation_events(scope_id, created_at DESC, id DESC)
        WHERE scope_id IS NOT NULL;
    `,
  },
  {
    version: 28,
    name: 'memory_mutation_events_required_target_provenance_contract',
    sql: `
      CREATE OR REPLACE FUNCTION mbrain_trim_memory_text(input text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      AS $mbrain$
        SELECT btrim(
          input,
          chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) ||
          chr(160) || chr(5760) ||
          chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) ||
          chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) ||
          chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) ||
          chr(12288) || chr(65279)
        )
      $mbrain$;

      CREATE OR REPLACE FUNCTION mbrain_jsonb_non_empty_string_array(input jsonb)
      RETURNS boolean
      LANGUAGE sql
      IMMUTABLE
      AS $mbrain$
        SELECT CASE
          WHEN jsonb_typeof(input) IS DISTINCT FROM 'array' THEN false
          WHEN jsonb_array_length(input) = 0 THEN false
          ELSE COALESCE((
            SELECT bool_and(
              jsonb_typeof(entry.value) = 'string'
              AND mbrain_trim_memory_text(entry.value #>> '{}') <> ''
            )
            FROM jsonb_array_elements(input) AS entry(value)
          ), false)
        END
      $mbrain$;

      UPDATE memory_mutation_events
      SET target_id = CASE
        WHEN target_id IS NULL OR mbrain_trim_memory_text(target_id) = '' THEN 'unknown:' || id
        ELSE mbrain_trim_memory_text(target_id)
      END
      WHERE target_id IS NULL
         OR mbrain_trim_memory_text(target_id) = ''
         OR target_id <> mbrain_trim_memory_text(target_id);

      UPDATE memory_mutation_events
      SET source_refs = '["Source: mbrain migration 28 required provenance backfill"]'::jsonb
      WHERE NOT mbrain_jsonb_non_empty_string_array(source_refs);

      UPDATE memory_mutation_events
      SET dry_run = (result = 'dry_run');

      DO $$
      BEGIN
        IF to_regclass('memory_mutation_events') IS NOT NULL THEN
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_target_id_present;
            ALTER TABLE memory_mutation_events
              ADD CONSTRAINT chk_memory_mutation_events_target_id_present
            CHECK (target_id IS NOT NULL AND mbrain_trim_memory_text(target_id) <> '');

          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_source_refs_non_empty;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_source_refs_non_empty
            CHECK (mbrain_jsonb_non_empty_string_array(source_refs));

          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_dry_run_result_consistency;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_dry_run_result_consistency
            CHECK (
              (result = 'dry_run' AND dry_run = true)
              OR (result <> 'dry_run' AND dry_run = false)
            );
        END IF;
      END $$;
    `,
  },
  {
    version: 29,
    name: 'memory_realms',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_realms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL CHECK (scope IN ('work', 'personal', 'mixed')),
        default_access TEXT NOT NULL CHECK (default_access IN ('read_only', 'read_write')),
        retention_policy TEXT NOT NULL DEFAULT 'retain',
        export_policy TEXT NOT NULL DEFAULT 'private',
        agent_instructions TEXT NOT NULL DEFAULT '',
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_memory_realms_scope
        ON memory_realms(scope, updated_at DESC);
    `,
  },
  {
    version: 30,
    name: 'memory_mutation_events_realm_upsert_contract',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('memory_mutation_events') IS NOT NULL THEN
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_operation;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_operation
            CHECK (
              operation IN (
                'create_memory_session',
                'close_memory_session',
                'expire_memory_session',
                'revoke_memory_session',
                'dry_run_memory_mutation',
                'list_memory_mutation_events',
                'record_memory_mutation_event',
                'create_memory_patch_candidate',
                'dry_run_memory_patch_candidate',
                'review_memory_patch_candidate',
                'apply_memory_patch_candidate',
                'create_redaction_plan',
                'dry_run_redaction_plan',
                'execute_redaction_plan',
                'put_page',
                'delete_page',
                'upsert_profile_memory_entry',
                'write_profile_memory_entry',
                'delete_profile_memory_entry',
                'record_personal_episode',
                'write_personal_episode_entry',
                'delete_personal_episode_entry',
                'upsert_memory_realm',
                'create_memory_candidate_entry',
                'advance_memory_candidate_status',
                'reject_memory_candidate_entry',
                'delete_memory_candidate_entry',
                'promote_memory_candidate_entry',
                'supersede_memory_candidate_entry',
                'export_memory_artifact',
                'sync_memory_artifact',
                'repair_memory_ledger',
                'physical_delete_memory_record',
                'governed_canonical_write',
                'pause_source_processing',
                'revoke_source_consent',
                'rerun_memory_job'
              )
            );

          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_target_kind;
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS memory_mutation_events_target_kind_check;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_target_kind
            CHECK (
              target_kind IN (
                'page',
                'source_record',
                'task_thread',
                'working_set',
                'task_event',
                'task_episode',
                'attempt',
                'decision',
                'procedure',
                'memory_candidate',
                'memory_patch_candidate',
                'profile_memory',
                'personal_episode',
                'memory_realm',
                'context_map',
                'context_atlas',
                'file_artifact',
                'export_artifact',
                'ledger_event'
              )
            );
        END IF;
      END $$;
    `,
  },
  {
    version: 31,
    name: 'memory_sessions_and_realm_attachments',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
        actor_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_memory_sessions_status_created
        ON memory_sessions(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_session_attachments (
        session_id TEXT NOT NULL REFERENCES memory_sessions(id) ON DELETE CASCADE,
        realm_id TEXT NOT NULL REFERENCES memory_realms(id) ON DELETE CASCADE,
        access TEXT NOT NULL CHECK (access IN ('read_only', 'read_write')),
        instructions TEXT NOT NULL DEFAULT '',
        attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, realm_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_session_attachments_realm
        ON memory_session_attachments(realm_id, attached_at DESC);

      DO $$
      BEGIN
        IF to_regclass('memory_mutation_events') IS NOT NULL THEN
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_operation;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_operation
            CHECK (
              operation IN (
                'create_memory_session',
                'close_memory_session',
                'expire_memory_session',
                'revoke_memory_session',
                'dry_run_memory_mutation',
                'list_memory_mutation_events',
                'record_memory_mutation_event',
                'create_memory_patch_candidate',
                'dry_run_memory_patch_candidate',
                'review_memory_patch_candidate',
                'apply_memory_patch_candidate',
                'create_redaction_plan',
                'dry_run_redaction_plan',
                'execute_redaction_plan',
                'put_page',
                'delete_page',
                'upsert_profile_memory_entry',
                'write_profile_memory_entry',
                'delete_profile_memory_entry',
                'record_personal_episode',
                'write_personal_episode_entry',
                'delete_personal_episode_entry',
                'upsert_memory_realm',
                'attach_memory_realm_to_session',
                'create_memory_candidate_entry',
                'advance_memory_candidate_status',
                'reject_memory_candidate_entry',
                'delete_memory_candidate_entry',
                'promote_memory_candidate_entry',
                'supersede_memory_candidate_entry',
                'export_memory_artifact',
                'sync_memory_artifact',
                'repair_memory_ledger',
                'physical_delete_memory_record',
                'governed_canonical_write',
                'pause_source_processing',
                'revoke_source_consent',
                'rerun_memory_job'
              )
            );

          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_target_kind;
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS memory_mutation_events_target_kind_check;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_target_kind
            CHECK (
              target_kind IN (
                'page',
                'source_record',
                'task_thread',
                'working_set',
                'task_event',
                'task_episode',
                'attempt',
                'decision',
                'procedure',
                'memory_candidate',
                'memory_patch_candidate',
                'profile_memory',
                'personal_episode',
                'memory_realm',
                'memory_session',
                'memory_session_attachment',
                'context_map',
                'context_atlas',
                'file_artifact',
                'export_artifact',
                'ledger_event'
              )
            );
        END IF;
      END $$;
    `,
  },
  {
    version: 32,
    name: 'memory_session_expiry_contract',
    sql: `
      DO $$
      DECLARE
        status_constraint_name TEXT;
      BEGIN
        IF to_regclass('memory_sessions') IS NOT NULL THEN
          ALTER TABLE memory_sessions
            ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

          FOR status_constraint_name IN
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'memory_sessions'::regclass
              AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%status%'
          LOOP
            EXECUTE format('ALTER TABLE memory_sessions DROP CONSTRAINT IF EXISTS %I', status_constraint_name);
          END LOOP;

          ALTER TABLE memory_sessions
            ADD CONSTRAINT chk_memory_sessions_status
            CHECK (status IN ('active', 'expired', 'closed'));
        END IF;
      END $$;
    `,
  },
  {
    version: 33,
    name: 'memory_patch_candidate_fields',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('memory_candidate_entries') IS NOT NULL THEN
          ALTER TABLE memory_candidate_entries
            ADD COLUMN IF NOT EXISTS patch_target_kind TEXT,
            ADD COLUMN IF NOT EXISTS patch_target_id TEXT,
            ADD COLUMN IF NOT EXISTS patch_base_target_snapshot_hash TEXT,
            ADD COLUMN IF NOT EXISTS patch_body JSONB,
            ADD COLUMN IF NOT EXISTS patch_format TEXT,
            ADD COLUMN IF NOT EXISTS patch_operation_state TEXT,
            ADD COLUMN IF NOT EXISTS patch_risk_class TEXT,
            ADD COLUMN IF NOT EXISTS patch_expected_resulting_target_snapshot_hash TEXT,
            ADD COLUMN IF NOT EXISTS patch_provenance_summary TEXT,
            ADD COLUMN IF NOT EXISTS patch_actor TEXT,
            ADD COLUMN IF NOT EXISTS patch_originating_session_id TEXT,
            ADD COLUMN IF NOT EXISTS patch_ledger_event_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

          ALTER TABLE memory_candidate_entries
            DROP CONSTRAINT IF EXISTS chk_memory_candidate_entries_patch_target_kind;
          ALTER TABLE memory_candidate_entries
            ADD CONSTRAINT chk_memory_candidate_entries_patch_target_kind
            CHECK (
              patch_target_kind IS NULL
              OR patch_target_kind IN (
                'page',
                'source_record',
                'task_thread',
                'working_set',
                'task_event',
                'task_episode',
                'attempt',
                'decision',
                'procedure',
                'memory_candidate',
                'memory_patch_candidate',
                'profile_memory',
                'personal_episode',
                'memory_realm',
                'memory_session',
                'memory_session_attachment',
                'context_map',
                'context_atlas',
                'file_artifact',
                'export_artifact',
                'ledger_event'
              )
            );

          ALTER TABLE memory_candidate_entries
            DROP CONSTRAINT IF EXISTS chk_memory_candidate_entries_patch_body_object;
          ALTER TABLE memory_candidate_entries
            ADD CONSTRAINT chk_memory_candidate_entries_patch_body_object
            CHECK (patch_body IS NULL OR jsonb_typeof(patch_body) IN ('object', 'array'));

          ALTER TABLE memory_candidate_entries
            DROP CONSTRAINT IF EXISTS chk_memory_candidate_entries_patch_format;
          ALTER TABLE memory_candidate_entries
            ADD CONSTRAINT chk_memory_candidate_entries_patch_format
            CHECK (
              patch_format IS NULL
              OR patch_format IN ('merge_patch', 'json_patch', 'unified_diff', 'whole_record', 'operation')
            );

          ALTER TABLE memory_candidate_entries
            DROP CONSTRAINT IF EXISTS chk_memory_candidate_entries_patch_operation_state;
          ALTER TABLE memory_candidate_entries
            ADD CONSTRAINT chk_memory_candidate_entries_patch_operation_state
            CHECK (
              patch_operation_state IS NULL
              OR patch_operation_state IN (
                'proposed',
                'dry_run_validated',
                'approved_for_apply',
                'apply_in_progress',
                'applied',
                'conflicted',
                'failed'
              )
            );

          ALTER TABLE memory_candidate_entries
            DROP CONSTRAINT IF EXISTS chk_memory_candidate_entries_patch_risk_class;
          ALTER TABLE memory_candidate_entries
            ADD CONSTRAINT chk_memory_candidate_entries_patch_risk_class
            CHECK (
              patch_risk_class IS NULL
              OR patch_risk_class IN ('low', 'medium', 'high', 'critical', 'unknown')
            );

          ALTER TABLE memory_candidate_entries
            DROP CONSTRAINT IF EXISTS chk_memory_candidate_entries_patch_ledger_ids_array;
          ALTER TABLE memory_candidate_entries
            ADD CONSTRAINT chk_memory_candidate_entries_patch_ledger_ids_array
            CHECK (jsonb_typeof(patch_ledger_event_ids) = 'array');

          CREATE INDEX IF NOT EXISTS idx_memory_candidates_patch_state
            ON memory_candidate_entries(patch_operation_state, updated_at DESC)
            WHERE patch_operation_state IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_memory_candidates_patch_target
            ON memory_candidate_entries(patch_target_kind, patch_target_id)
            WHERE patch_target_kind IS NOT NULL;
        END IF;
      END $$;
    `,
  },
  {
    version: 34,
    name: 'memory_redaction_plan_lifecycle',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_redaction_plans (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        query TEXT NOT NULL,
        replacement_text TEXT NOT NULL DEFAULT '[REDACTED]',
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'applied', 'rejected')),
        requested_by TEXT,
        review_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reviewed_at TIMESTAMPTZ,
        applied_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_memory_redaction_plans_scope_status
        ON memory_redaction_plans(scope_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_redaction_plan_items (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES memory_redaction_plans(id) ON DELETE CASCADE,
        target_object_type TEXT NOT NULL,
        target_object_id TEXT NOT NULL,
        field_path TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'applied', 'unsupported')),
        preview_text TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_redaction_items_plan
        ON memory_redaction_plan_items(plan_id, status);
      CREATE INDEX IF NOT EXISTS idx_memory_redaction_items_target
        ON memory_redaction_plan_items(target_object_type, target_object_id);
    `,
  },
  {
    version: 35,
    name: 'derived_jobs_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS derived_jobs (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('page_chunks', 'note_manifest', 'note_sections', 'context_map', 'context_atlas')),
        target_content_hash TEXT NOT NULL,
        manifest_path TEXT,
        derived_parameters JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'failed', 'superseded')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_derived_jobs_pending
        ON derived_jobs(status, updated_at ASC)
        WHERE status = 'pending';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_derived_jobs_active_slug_artifact
        ON derived_jobs(scope_id, slug, artifact_kind)
        WHERE status IN ('pending', 'running');
      CREATE INDEX IF NOT EXISTS idx_derived_jobs_scope_slug
        ON derived_jobs(scope_id, slug, updated_at DESC);

      CREATE TABLE IF NOT EXISTS derived_index_state (
        scope_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('page_chunks', 'note_manifest', 'note_sections', 'context_map', 'context_atlas')),
        target_content_hash TEXT NOT NULL,
        indexed_content_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
        extractor_version TEXT NOT NULL,
        derived_schema_version TEXT NOT NULL,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope_id, slug, artifact_kind)
      );

      CREATE INDEX IF NOT EXISTS idx_derived_index_state_status
        ON derived_index_state(scope_id, status, updated_at DESC);
    `,
  },
  {
    version: 36,
    name: 'chunk_content_hash_freshness',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('content_chunks') IS NOT NULL THEN
          ALTER TABLE content_chunks
            ADD COLUMN IF NOT EXISTS chunk_content_hash TEXT NOT NULL DEFAULT '';

          UPDATE content_chunks
          SET chunk_content_hash = md5(chunk_source || E'\\n' || chunk_text)
          WHERE chunk_content_hash = '';
        END IF;
      END;
      $$;
    `,
  },
  {
    version: 37,
    name: 'governed_canonical_write_foundations',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('memory_mutation_events') IS NOT NULL THEN
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_operation;
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS memory_mutation_events_operation_check;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_operation
            CHECK (
              operation IN (
                'create_memory_session',
                'close_memory_session',
                'expire_memory_session',
                'revoke_memory_session',
                'dry_run_memory_mutation',
                'list_memory_mutation_events',
                'record_memory_mutation_event',
                'create_memory_patch_candidate',
                'dry_run_memory_patch_candidate',
                'review_memory_patch_candidate',
                'apply_memory_patch_candidate',
                'create_redaction_plan',
                'dry_run_redaction_plan',
                'execute_redaction_plan',
                'put_page',
                'delete_page',
                'upsert_profile_memory_entry',
                'write_profile_memory_entry',
                'delete_profile_memory_entry',
                'record_personal_episode',
                'write_personal_episode_entry',
                'delete_personal_episode_entry',
                'upsert_memory_realm',
                'attach_memory_realm_to_session',
                'create_memory_candidate_entry',
                'advance_memory_candidate_status',
                'reject_memory_candidate_entry',
                'delete_memory_candidate_entry',
                'promote_memory_candidate_entry',
                'supersede_memory_candidate_entry',
                'export_memory_artifact',
                'sync_memory_artifact',
                'repair_memory_ledger',
                'physical_delete_memory_record',
                'governed_canonical_write',
                'pause_source_processing',
                'revoke_source_consent',
                'rerun_memory_job'
              )
            );
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS canonical_write_attempts (
        id TEXT PRIMARY KEY,
        policy_decision TEXT NOT NULL CHECK (policy_decision IN ('auto_canonical', 'candidate', 'verify_first', 'conflict', 'reject', 'quarantine', 'no_write')),
        policy_explanation TEXT NOT NULL DEFAULT '',
        policy_explanation_hash TEXT,
        assertion_ids JSONB NOT NULL DEFAULT '[]',
        assertion_evidence_ids JSONB NOT NULL DEFAULT '[]',
        extracted_claim_ids JSONB NOT NULL DEFAULT '[]',
        source_refs JSONB NOT NULL DEFAULT '[]',
        target_projection_ids JSONB NOT NULL DEFAULT '[]',
        before_db_hash TEXT,
        after_db_hash TEXT,
        before_markdown_hash TEXT,
        after_markdown_hash TEXT,
        actor TEXT NOT NULL DEFAULT '',
        session_id TEXT,
        job_id TEXT,
        runner_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('applied', 'pending_reconcile', 'failed_db', 'failed_markdown', 'conflict')),
        error_json JSONB NOT NULL DEFAULT '{}',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_canonical_write_attempts_status_created
        ON canonical_write_attempts(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_canonical_write_attempts_session_created
        ON canonical_write_attempts(session_id, created_at DESC)
        WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_canonical_write_attempts_policy_created
        ON canonical_write_attempts(policy_decision, created_at DESC);

      CREATE TABLE IF NOT EXISTS canonical_projection_mutations (
        id TEXT PRIMARY KEY,
        canonical_write_attempt_id TEXT REFERENCES canonical_write_attempts(id) ON DELETE CASCADE,
        projection_kind TEXT NOT NULL,
        projection_slug TEXT NOT NULL,
        mutation_kind TEXT NOT NULL,
        assertion_ids JSONB NOT NULL DEFAULT '[]',
        assertion_evidence_ids JSONB NOT NULL DEFAULT '[]',
        extracted_claim_ids JSONB NOT NULL DEFAULT '[]',
        source_refs JSONB NOT NULL DEFAULT '[]',
        before_markdown_hash TEXT,
        after_markdown_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'applied', 'failed_markdown', 'pending_reconcile')),
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_canonical_projection_mutations_projection_created
        ON canonical_projection_mutations(projection_kind, projection_slug, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_canonical_projection_mutations_status_created
        ON canonical_projection_mutations(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS canonical_projection_reconcile_marks (
        id TEXT PRIMARY KEY,
        canonical_write_attempt_id TEXT REFERENCES canonical_write_attempts(id) ON DELETE SET NULL,
        projection_kind TEXT NOT NULL,
        projection_slug TEXT NOT NULL,
        assertion_ids JSONB NOT NULL DEFAULT '[]',
        projection_ids JSONB NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('pending_reconcile', 'reconciled', 'failed')),
        reason TEXT NOT NULL CHECK (reason IN ('failed_markdown', 'failed_ledger', 'projection_drift', 'manual_review')),
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_canonical_projection_reconcile_marks_status_updated
        ON canonical_projection_reconcile_marks(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_canonical_projection_reconcile_marks_projection_updated
        ON canonical_projection_reconcile_marks(projection_kind, projection_slug, updated_at DESC);
    `,
  },
  {
    version: 38,
    name: 'maintenance_runtime_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_jobs (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        queue             TEXT NOT NULL DEFAULT 'maintenance',
        status            TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'completed', 'failed', 'dead', 'cancelled', 'delayed', 'paused', 'waiting_children')),
        priority          INTEGER NOT NULL DEFAULT 0,
        payload_json      JSONB NOT NULL DEFAULT '{}',
        result_json       JSONB,
        progress_json     JSONB NOT NULL DEFAULT '{}',
        max_attempts      INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
        attempts_started  INTEGER NOT NULL DEFAULT 0 CHECK (attempts_started >= 0),
        attempts_finished INTEGER NOT NULL DEFAULT 0 CHECK (attempts_finished >= 0),
        backoff_type      TEXT NOT NULL DEFAULT 'none' CHECK (backoff_type IN ('none', 'fixed', 'exponential')),
        backoff_delay_ms  INTEGER NOT NULL DEFAULT 0 CHECK (backoff_delay_ms >= 0),
        lock_token        TEXT,
        lock_owner        TEXT,
        lock_expires_at   TIMESTAMPTZ,
        timeout_ms        INTEGER CHECK (timeout_ms IS NULL OR timeout_ms > 0),
        timeout_at        TIMESTAMPTZ,
        idempotency_key   TEXT,
        parent_job_id     TEXT REFERENCES memory_jobs(id) ON DELETE SET NULL,
        failure_class     TEXT CHECK (
          failure_class IS NULL OR failure_class IN (
            'database',
            'lock_timeout',
            'runner_unavailable',
            'llm_unavailable',
            'policy_denied',
            'source_unavailable',
            'prompt_injection_quarantine',
            'secret_redaction_required',
            'projection_failed',
            'timeout',
            'cancelled',
            'internal'
          )
        ),
        last_error        TEXT,
        next_run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at        TIMESTAMPTZ,
        finished_at       TIMESTAMPTZ,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_jobs_active_idempotency
        ON memory_jobs(idempotency_key)
        WHERE idempotency_key IS NOT NULL
          AND status NOT IN ('completed', 'failed', 'dead', 'cancelled');
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_claimable
        ON memory_jobs(queue, status, priority DESC, next_run_at ASC, created_at ASC)
        WHERE status IN ('waiting', 'delayed', 'active');
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_name_status
        ON memory_jobs(name, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_parent
        ON memory_jobs(parent_job_id)
        WHERE parent_job_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS memory_job_events (
        id            TEXT PRIMARY KEY,
        job_id        TEXT REFERENCES memory_jobs(id) ON DELETE SET NULL,
        event_type    TEXT NOT NULL,
        worker_id     TEXT,
        failure_class TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_job_events_job_created
        ON memory_job_events(job_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_memory_job_events_type_created
        ON memory_job_events(event_type, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_job_logs (
        id            TEXT PRIMARY KEY,
        job_id        TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,
        level         TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        message       TEXT NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_job_logs_job_created
        ON memory_job_logs(job_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS memory_job_artifacts (
        id            TEXT PRIMARY KEY,
        job_id        TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,
        artifact_kind TEXT NOT NULL,
        artifact_ref  TEXT NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_job_artifacts_job_kind
        ON memory_job_artifacts(job_id, artifact_kind, created_at DESC);

      CREATE OR REPLACE FUNCTION prevent_maintenance_audit_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'maintenance audit tables are append-only';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS prevent_memory_job_events_update ON memory_job_events;
      CREATE TRIGGER prevent_memory_job_events_update
        BEFORE UPDATE ON memory_job_events
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
      DROP TRIGGER IF EXISTS prevent_memory_job_events_delete ON memory_job_events;
      CREATE TRIGGER prevent_memory_job_events_delete
        BEFORE DELETE ON memory_job_events
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

      DROP TRIGGER IF EXISTS prevent_memory_job_logs_update ON memory_job_logs;
      CREATE TRIGGER prevent_memory_job_logs_update
        BEFORE UPDATE ON memory_job_logs
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
      DROP TRIGGER IF EXISTS prevent_memory_job_logs_delete ON memory_job_logs;
      CREATE TRIGGER prevent_memory_job_logs_delete
        BEFORE DELETE ON memory_job_logs
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

      DROP TRIGGER IF EXISTS prevent_memory_job_artifacts_update ON memory_job_artifacts;
      CREATE TRIGGER prevent_memory_job_artifacts_update
        BEFORE UPDATE ON memory_job_artifacts
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
      DROP TRIGGER IF EXISTS prevent_memory_job_artifacts_delete ON memory_job_artifacts;
      CREATE TRIGGER prevent_memory_job_artifacts_delete
        BEFORE DELETE ON memory_job_artifacts
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

      CREATE TABLE IF NOT EXISTS memory_cycle_locks (
        id             TEXT PRIMARY KEY,
        cycle_name     TEXT NOT NULL UNIQUE,
        holder_pid     INTEGER NOT NULL,
        holder_host    TEXT NOT NULL,
        holder_kind    TEXT NOT NULL,
        acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        ttl_expires_at TIMESTAMPTZ NOT NULL,
        heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_cycle_locks_ttl
        ON memory_cycle_locks(ttl_expires_at ASC);

      CREATE TABLE IF NOT EXISTS memory_worker_heartbeats (
        worker_id     TEXT PRIMARY KEY,
        worker_host   TEXT NOT NULL,
        worker_pid    INTEGER NOT NULL,
        queues        JSONB NOT NULL DEFAULT '[]',
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        metadata_json JSONB NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_memory_worker_heartbeats_seen
        ON memory_worker_heartbeats(last_seen_at DESC);
    `,
  },
  {
    version: 39,
    name: 'lifecycle_forgetting_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS forgetting_policies (
        id                      TEXT PRIMARY KEY,
        scope_id                TEXT NOT NULL DEFAULT 'workspace:default',
        entity_type             TEXT NOT NULL,
        source_kind             TEXT,
        claim_type              TEXT,
        sensitivity_level       TEXT,
        importance              TEXT,
        stale_after             TEXT,
        expire_after            TEXT,
        archive_after           TEXT,
        restore_window          TEXT,
        archive_retention       TEXT,
        purge_after             TEXT,
        purge_eligible          BOOLEAN NOT NULL DEFAULT false,
        report_visibility       TEXT NOT NULL DEFAULT 'summary' CHECK (report_visibility IN ('hidden', 'summary', 'audit')),
        policy_json             JSONB NOT NULL DEFAULT '{}',
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_forgetting_policies_scope_entity
        ON forgetting_policies(scope_id, entity_type);

      CREATE TABLE IF NOT EXISTS memory_lifecycle_states (
        id                       TEXT PRIMARY KEY,
        scope_id                 TEXT NOT NULL DEFAULT 'workspace:default',
        entity_type              TEXT NOT NULL,
        entity_id                TEXT NOT NULL,
        lifecycle_state          TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'stale', 'expired', 'archived', 'purged')),
        policy_id                TEXT REFERENCES forgetting_policies(id) ON DELETE SET NULL,
        reason                   TEXT NOT NULL DEFAULT '',
        source_id                TEXT,
        sensitivity_level        TEXT,
        importance               TEXT,
        restore_until            TIMESTAMPTZ,
        purge_after              TIMESTAMPTZ,
        last_transition_event_id TEXT,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(scope_id, entity_type, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_states_entity
        ON memory_lifecycle_states(scope_id, entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_states_state
        ON memory_lifecycle_states(scope_id, lifecycle_state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_states_purge_after
        ON memory_lifecycle_states(purge_after ASC)
        WHERE purge_after IS NOT NULL;

      CREATE TABLE IF NOT EXISTS forgetting_events (
        id                   TEXT PRIMARY KEY,
        scope_id             TEXT NOT NULL DEFAULT 'workspace:default',
        entity_type          TEXT NOT NULL,
        entity_id            TEXT NOT NULL,
        event_type           TEXT NOT NULL,
        from_lifecycle_state TEXT CHECK (from_lifecycle_state IS NULL OR from_lifecycle_state IN ('active', 'stale', 'expired', 'archived', 'purged')),
        to_lifecycle_state   TEXT CHECK (to_lifecycle_state IS NULL OR to_lifecycle_state IN ('active', 'stale', 'expired', 'archived', 'purged')),
        policy_id            TEXT REFERENCES forgetting_policies(id) ON DELETE SET NULL,
        reason               TEXT NOT NULL DEFAULT '',
        source_refs_json     JSONB NOT NULL DEFAULT '[]',
        actor                TEXT NOT NULL DEFAULT 'mbrain:lifecycle',
        job_id               TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_forgetting_events_entity_created
        ON forgetting_events(scope_id, entity_type, entity_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS purge_plans (
        id            TEXT PRIMARY KEY,
        scope_id      TEXT NOT NULL DEFAULT 'workspace:default',
        status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'applied', 'rejected', 'cancelled')),
        reason        TEXT NOT NULL DEFAULT '',
        requested_by  TEXT,
        review_reason TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        reviewed_at   TIMESTAMPTZ,
        applied_at    TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_purge_plans_scope_status
        ON purge_plans(scope_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS purge_plan_items (
        id                 TEXT PRIMARY KEY,
        plan_id            TEXT NOT NULL REFERENCES purge_plans(id) ON DELETE CASCADE,
        entity_type        TEXT NOT NULL,
        entity_id          TEXT NOT NULL,
        lifecycle_state    TEXT NOT NULL CHECK (lifecycle_state IN ('expired', 'archived', 'purged')),
        status             TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'approved', 'purged', 'skipped', 'blocked')),
        purge_after        TIMESTAMPTZ,
        tombstone_id       TEXT,
        before_hash        TEXT,
        evidence_ids_json  JSONB NOT NULL DEFAULT '[]',
        reason             TEXT NOT NULL DEFAULT '',
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_purge_plan_items_plan
        ON purge_plan_items(plan_id, status);
      CREATE INDEX IF NOT EXISTS idx_purge_plan_items_target
        ON purge_plan_items(entity_type, entity_id);

      CREATE TABLE IF NOT EXISTS restore_events (
        id                   TEXT PRIMARY KEY,
        scope_id             TEXT NOT NULL DEFAULT 'workspace:default',
        entity_type          TEXT NOT NULL,
        entity_id            TEXT NOT NULL,
        from_lifecycle_state TEXT NOT NULL CHECK (from_lifecycle_state IN ('stale', 'expired', 'archived')),
        to_lifecycle_state   TEXT NOT NULL CHECK (to_lifecycle_state IN ('active', 'stale')),
        policy_id            TEXT REFERENCES forgetting_policies(id) ON DELETE SET NULL,
        reason               TEXT NOT NULL DEFAULT '',
        source_refs_json     JSONB NOT NULL DEFAULT '[]',
        actor                TEXT NOT NULL DEFAULT 'mbrain:lifecycle',
        restored_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_restore_events_entity_restored
        ON restore_events(scope_id, entity_type, entity_id, restored_at DESC);

      CREATE TABLE IF NOT EXISTS memory_tombstones (
        id             TEXT PRIMARY KEY,
        scope_id       TEXT NOT NULL DEFAULT 'workspace:default',
        entity_type    TEXT NOT NULL,
        entity_id      TEXT NOT NULL,
        purge_event_id TEXT REFERENCES forgetting_events(id) ON DELETE SET NULL,
        purge_plan_id  TEXT REFERENCES purge_plans(id) ON DELETE SET NULL,
        reason         TEXT NOT NULL DEFAULT '',
        content_hash   TEXT,
        metadata_json  JSONB NOT NULL DEFAULT '{}',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(scope_id, entity_type, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_tombstones_entity
        ON memory_tombstones(scope_id, entity_type, entity_id);

      CREATE OR REPLACE FUNCTION prevent_lifecycle_audit_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'lifecycle audit tables are append-only';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS prevent_forgetting_events_update ON forgetting_events;
      CREATE TRIGGER prevent_forgetting_events_update
        BEFORE UPDATE ON forgetting_events
        FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();
      DROP TRIGGER IF EXISTS prevent_forgetting_events_delete ON forgetting_events;
      CREATE TRIGGER prevent_forgetting_events_delete
        BEFORE DELETE ON forgetting_events
        FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();

      DROP TRIGGER IF EXISTS prevent_restore_events_update ON restore_events;
      CREATE TRIGGER prevent_restore_events_update
        BEFORE UPDATE ON restore_events
        FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();
      DROP TRIGGER IF EXISTS prevent_restore_events_delete ON restore_events;
      CREATE TRIGGER prevent_restore_events_delete
        BEFORE DELETE ON restore_events
        FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();

      DROP TRIGGER IF EXISTS prevent_memory_tombstones_update ON memory_tombstones;
      CREATE TRIGGER prevent_memory_tombstones_update
        BEFORE UPDATE ON memory_tombstones
        FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();
      DROP TRIGGER IF EXISTS prevent_memory_tombstones_delete ON memory_tombstones;
      CREATE TRIGGER prevent_memory_tombstones_delete
        BEFORE DELETE ON memory_tombstones
        FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();
    `,
  },
  {
    version: 40,
    name: 'assertion_pipeline_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS extracted_claims (
        id                    TEXT PRIMARY KEY,
        source_id             TEXT NOT NULL,
        source_item_id        TEXT NOT NULL,
        source_chunk_id       TEXT NOT NULL,
        extractor_kind        TEXT NOT NULL,
        extractor_version     TEXT NOT NULL,
        runner_job_id         TEXT,
        claim_text            TEXT NOT NULL,
        claim_type            TEXT NOT NULL,
        target_hint           TEXT NOT NULL,
        property_hint         TEXT NOT NULL,
        value_json            JSONB NOT NULL,
        confidence            REAL NOT NULL,
        sensitivity_level     TEXT NOT NULL,
        prompt_injection_flag BOOLEAN NOT NULL DEFAULT false,
        secret_flag           BOOLEAN NOT NULL DEFAULT false,
        status                TEXT NOT NULL CHECK (status IN ('pending', 'pending_resolution', 'resolved', 'rejected')),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_extracted_claims_source_chunk
        ON extracted_claims(source_chunk_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_extracted_claims_target
        ON extracted_claims(claim_type, target_hint, property_hint);

      CREATE TABLE IF NOT EXISTS assertions (
        id                         TEXT PRIMARY KEY,
        claim_type                 TEXT NOT NULL,
        target_type                TEXT NOT NULL,
        target_id                  TEXT NOT NULL,
        target_slug                TEXT,
        property                   TEXT NOT NULL,
        value_json                 JSONB NOT NULL,
        normalized_claim           TEXT NOT NULL,
        authority_summary          JSONB NOT NULL DEFAULT '{}',
        confidence                 REAL NOT NULL DEFAULT 0,
        evidence_count             INTEGER NOT NULL DEFAULT 0,
        authority_state            TEXT NOT NULL CHECK (authority_state IN ('unresolved', 'candidate', 'canonical', 'conflicted', 'rejected')),
        lifecycle_state            TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'stale', 'expired', 'archived', 'purged')),
        valid_from                 TIMESTAMPTZ,
        valid_until                TIMESTAMPTZ,
        supersedes_assertion_id    TEXT,
        superseded_by_assertion_id TEXT,
        conflict_set_id            TEXT,
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_assertions_target_property
        ON assertions(target_type, target_id, property);
      CREATE INDEX IF NOT EXISTS idx_assertions_authority_lifecycle
        ON assertions(authority_state, lifecycle_state);

      CREATE TABLE IF NOT EXISTS assertion_events (
        id                   TEXT PRIMARY KEY,
        assertion_id          TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
        event_type            TEXT NOT NULL,
        from_authority_state  TEXT,
        to_authority_state    TEXT,
        from_lifecycle_state  TEXT,
        to_lifecycle_state    TEXT,
        reason                TEXT NOT NULL DEFAULT '',
        source_refs_json      JSONB NOT NULL DEFAULT '[]',
        actor                 TEXT NOT NULL DEFAULT '',
        job_id                TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_assertion_events_assertion_created
        ON assertion_events(assertion_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS assertion_evidence (
        id                  TEXT PRIMARY KEY,
        assertion_id         TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
        extracted_claim_id   TEXT NOT NULL,
        source_id            TEXT NOT NULL,
        source_item_id       TEXT NOT NULL,
        source_chunk_id      TEXT NOT NULL,
        session_id           TEXT,
        task_event_id        TEXT,
        contribution_type    TEXT NOT NULL CHECK (contribution_type IN ('supports', 'contradicts', 'supersedes', 'superseded_by', 'context', 'audit_only')),
        evidence_authority   TEXT NOT NULL,
        evidence_confidence  REAL NOT NULL,
        valid_from           TIMESTAMPTZ,
        valid_until          TIMESTAMPTZ,
        revocation_state     TEXT NOT NULL DEFAULT 'active',
        forgetting_state     TEXT NOT NULL DEFAULT 'retained',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_assertion_evidence_assertion
        ON assertion_evidence(assertion_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assertion_evidence_source
        ON assertion_evidence(source_id, source_item_id, source_chunk_id);

      CREATE TABLE IF NOT EXISTS assertion_lineage (
        id                 TEXT PRIMARY KEY,
        assertion_id       TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
        extracted_claim_id TEXT NOT NULL,
        source_id          TEXT NOT NULL,
        source_item_id     TEXT NOT NULL,
        source_chunk_id    TEXT NOT NULL,
        session_id         TEXT,
        task_event_id      TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS assertion_links (
        id                 TEXT PRIMARY KEY,
        from_assertion_id  TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
        to_assertion_id    TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
        link_type          TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(from_assertion_id, to_assertion_id, link_type)
      );

      CREATE TABLE IF NOT EXISTS conflict_sets (
        id             TEXT PRIMARY KEY,
        target_type    TEXT NOT NULL,
        target_id      TEXT NOT NULL,
        property       TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'open',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS conflict_set_assertions (
        conflict_set_id TEXT NOT NULL REFERENCES conflict_sets(id) ON DELETE CASCADE,
        assertion_id     TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
        role             TEXT NOT NULL DEFAULT 'member',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(conflict_set_id, assertion_id)
      );
    `,
  },
  {
    version: 41,
    name: 'restricted_runner_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS runner_jobs (
        id                               TEXT PRIMARY KEY,
        memory_job_id                    TEXT REFERENCES memory_jobs(id) ON DELETE SET NULL,
        runner_kind                      TEXT NOT NULL CHECK (runner_kind IN ('claude_code', 'codex', 'local_model', 'remote_model', 'deterministic_fallback')),
        runner_version                   TEXT,
        model                            TEXT,
        provider                         TEXT,
        task_type                        TEXT NOT NULL CHECK (task_type IN ('assertion_extraction', 'consolidation_review', 'contradiction_review', 'forgetting_review', 'source_summary', 'daily_report')),
        source_scope_json                JSONB NOT NULL DEFAULT '{}',
        prompt_hash                      TEXT NOT NULL,
        input_hash                       TEXT NOT NULL,
        output_hash                      TEXT,
        status                           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'degraded', 'cancelled')),
        failure_class                    TEXT CHECK (
          failure_class IS NULL OR failure_class IN (
            'database',
            'lock_timeout',
            'runner_unavailable',
            'llm_unavailable',
            'policy_denied',
            'source_unavailable',
            'prompt_injection_quarantine',
            'secret_redaction_required',
            'projection_failed',
            'timeout',
            'cancelled',
            'internal'
          )
        ),
        token_usage_json                 JSONB NOT NULL DEFAULT '{}',
        cost_estimate_usd                NUMERIC(12,6),
        can_execute_shell                BOOLEAN NOT NULL DEFAULT false CHECK (can_execute_shell = false),
        can_access_connector_credentials BOOLEAN NOT NULL DEFAULT false CHECK (can_access_connector_credentials = false),
        created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_runner_jobs_task_status
        ON runner_jobs(task_type, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runner_jobs_memory_job
        ON runner_jobs(memory_job_id)
        WHERE memory_job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_runner_jobs_source_scope
        ON runner_jobs USING GIN(source_scope_json);

      CREATE OR REPLACE FUNCTION prevent_runner_job_identity_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'runner jobs are append-only';
        END IF;

        IF OLD.id IS DISTINCT FROM NEW.id
          OR OLD.memory_job_id IS DISTINCT FROM NEW.memory_job_id
          OR OLD.runner_kind IS DISTINCT FROM NEW.runner_kind
          OR OLD.runner_version IS DISTINCT FROM NEW.runner_version
          OR OLD.model IS DISTINCT FROM NEW.model
          OR OLD.provider IS DISTINCT FROM NEW.provider
          OR OLD.task_type IS DISTINCT FROM NEW.task_type
          OR OLD.source_scope_json IS DISTINCT FROM NEW.source_scope_json
          OR OLD.prompt_hash IS DISTINCT FROM NEW.prompt_hash
          OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
          OR OLD.can_execute_shell IS DISTINCT FROM NEW.can_execute_shell
          OR OLD.can_access_connector_credentials IS DISTINCT FROM NEW.can_access_connector_credentials
          OR OLD.created_at IS DISTINCT FROM NEW.created_at
        THEN
          RAISE EXCEPTION 'runner job identity fields are append-only';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS prevent_runner_jobs_identity_update ON runner_jobs;
      CREATE TRIGGER prevent_runner_jobs_identity_update
        BEFORE UPDATE ON runner_jobs
        FOR EACH ROW EXECUTE FUNCTION prevent_runner_job_identity_mutation();
      DROP TRIGGER IF EXISTS prevent_runner_jobs_delete ON runner_jobs;
      CREATE TRIGGER prevent_runner_jobs_delete
        BEFORE DELETE ON runner_jobs
        FOR EACH ROW EXECUTE FUNCTION prevent_runner_job_identity_mutation();

      CREATE TABLE IF NOT EXISTS runner_tool_calls (
        id                TEXT PRIMARY KEY,
        runner_job_id     TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
        tool_name         TEXT NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('allowed', 'denied', 'failed', 'succeeded')),
        policy_reason     TEXT NOT NULL DEFAULT '',
        request_hash      TEXT NOT NULL,
        response_hash     TEXT,
        token_usage_json  JSONB NOT NULL DEFAULT '{}',
        cost_estimate_usd NUMERIC(12,6),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_runner_tool_calls_job_created
        ON runner_tool_calls(runner_job_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_runner_tool_calls_name_status
        ON runner_tool_calls(tool_name, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS runner_messages (
        id               TEXT PRIMARY KEY,
        runner_job_id    TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
        role             TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content_hash     TEXT NOT NULL,
        redacted_preview TEXT NOT NULL DEFAULT '',
        token_count      INTEGER NOT NULL DEFAULT 0 CHECK (token_count >= 0),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_runner_messages_job_created
        ON runner_messages(runner_job_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS runner_artifacts (
        id             TEXT PRIMARY KEY,
        runner_job_id  TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
        artifact_kind  TEXT NOT NULL,
        artifact_ref   TEXT NOT NULL,
        content_hash   TEXT,
        metadata_json  JSONB NOT NULL DEFAULT '{}',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_runner_artifacts_job_kind
        ON runner_artifacts(runner_job_id, artifact_kind, created_at DESC);

      DROP TRIGGER IF EXISTS prevent_runner_tool_calls_update ON runner_tool_calls;
      CREATE TRIGGER prevent_runner_tool_calls_update
        BEFORE UPDATE ON runner_tool_calls
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
      DROP TRIGGER IF EXISTS prevent_runner_tool_calls_delete ON runner_tool_calls;
      CREATE TRIGGER prevent_runner_tool_calls_delete
        BEFORE DELETE ON runner_tool_calls
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

      DROP TRIGGER IF EXISTS prevent_runner_messages_update ON runner_messages;
      CREATE TRIGGER prevent_runner_messages_update
        BEFORE UPDATE ON runner_messages
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
      DROP TRIGGER IF EXISTS prevent_runner_messages_delete ON runner_messages;
      CREATE TRIGGER prevent_runner_messages_delete
        BEFORE DELETE ON runner_messages
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

      DROP TRIGGER IF EXISTS prevent_runner_artifacts_update ON runner_artifacts;
      CREATE TRIGGER prevent_runner_artifacts_update
        BEFORE UPDATE ON runner_artifacts
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
      DROP TRIGGER IF EXISTS prevent_runner_artifacts_delete ON runner_artifacts;
      CREATE TRIGGER prevent_runner_artifacts_delete
        BEFORE DELETE ON runner_artifacts
        FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
    `,
  },
  {
    version: 42,
    name: 'append_only_audit_fk_restrict',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('forgetting_events') IS NOT NULL AND to_regclass('forgetting_policies') IS NOT NULL THEN
          ALTER TABLE forgetting_events DROP CONSTRAINT IF EXISTS forgetting_events_policy_id_fkey;
          ALTER TABLE forgetting_events
            ADD CONSTRAINT forgetting_events_policy_id_fkey
            FOREIGN KEY (policy_id) REFERENCES forgetting_policies(id) ON DELETE RESTRICT;
        END IF;

        IF to_regclass('restore_events') IS NOT NULL AND to_regclass('forgetting_policies') IS NOT NULL THEN
          ALTER TABLE restore_events DROP CONSTRAINT IF EXISTS restore_events_policy_id_fkey;
          ALTER TABLE restore_events
            ADD CONSTRAINT restore_events_policy_id_fkey
            FOREIGN KEY (policy_id) REFERENCES forgetting_policies(id) ON DELETE RESTRICT;
        END IF;

        IF to_regclass('memory_tombstones') IS NOT NULL AND to_regclass('forgetting_events') IS NOT NULL THEN
          ALTER TABLE memory_tombstones DROP CONSTRAINT IF EXISTS memory_tombstones_purge_event_id_fkey;
          ALTER TABLE memory_tombstones
            ADD CONSTRAINT memory_tombstones_purge_event_id_fkey
            FOREIGN KEY (purge_event_id) REFERENCES forgetting_events(id) ON DELETE RESTRICT;
        END IF;

        IF to_regclass('memory_tombstones') IS NOT NULL AND to_regclass('purge_plans') IS NOT NULL THEN
          ALTER TABLE memory_tombstones DROP CONSTRAINT IF EXISTS memory_tombstones_purge_plan_id_fkey;
          ALTER TABLE memory_tombstones
            ADD CONSTRAINT memory_tombstones_purge_plan_id_fkey
            FOREIGN KEY (purge_plan_id) REFERENCES purge_plans(id) ON DELETE RESTRICT;
        END IF;

        IF to_regclass('runner_jobs') IS NOT NULL AND to_regclass('memory_jobs') IS NOT NULL THEN
          ALTER TABLE runner_jobs DROP CONSTRAINT IF EXISTS runner_jobs_memory_job_id_fkey;
          ALTER TABLE runner_jobs
            ADD CONSTRAINT runner_jobs_memory_job_id_fkey
            FOREIGN KEY (memory_job_id) REFERENCES memory_jobs(id) ON DELETE RESTRICT;
        END IF;
      END $$;
    `,
  },
  {
    version: 43,
    name: 'system_of_record_projection_targets',
    sql: `
      CREATE TABLE IF NOT EXISTS canonical_projection_targets (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK (target_type IN ('markdown_page', 'page_timeline', 'profile_memory', 'personal_episode', 'task_resume', 'project_doc', 'system_doc', 'source_summary', 'daily_report')),
        target_id TEXT NOT NULL,
        locator TEXT NOT NULL,
        source_assertion_ids JSONB NOT NULL DEFAULT '[]',
        projection_hash TEXT NOT NULL,
        rendered_markdown TEXT NOT NULL DEFAULT '',
        last_rendered_at TIMESTAMPTZ,
        last_reconciled_at TIMESTAMPTZ,
        status TEXT NOT NULL CHECK (status IN ('applied', 'pending_reconcile', 'reconciled', 'failed', 'conflict')),
        runtime_only BOOLEAN NOT NULL DEFAULT false,
        canonical_changed_since_projection BOOLEAN NOT NULL DEFAULT false,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_projection_targets_target
        ON canonical_projection_targets(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_canonical_projection_targets_status_updated
        ON canonical_projection_targets(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_canonical_projection_targets_locator
        ON canonical_projection_targets(locator);
    `,
  },
  {
    version: 44,
    name: 'personal_data_connector_foundations',
    sql: `
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        connector_id TEXT,
        locator TEXT,
        consent_state TEXT NOT NULL CHECK (consent_state IN ('not_requested', 'granted', 'denied', 'revoked')),
        enabled BOOLEAN NOT NULL DEFAULT false,
        paused_at TIMESTAMPTZ,
        policy_id TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        archived_at TIMESTAMPTZ
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_kind_locator
        ON sources(kind, locator)
        WHERE locator IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sources_kind_state
        ON sources(kind, consent_state, enabled);

      CREATE TABLE IF NOT EXISTS source_policies (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL UNIQUE,
        ingest_mode TEXT NOT NULL,
        index_mode TEXT NOT NULL,
        extraction_mode TEXT NOT NULL,
        raw_copy_mode TEXT NOT NULL,
        chunk_retention TEXT NOT NULL,
        llm_access TEXT NOT NULL,
        runner_access TEXT NOT NULL,
        automatic_canonical_write_authority TEXT NOT NULL,
        candidate_route_conditions JSONB NOT NULL DEFAULT '[]',
        conflict_route_conditions JSONB NOT NULL DEFAULT '[]',
        forgetting_lifecycle TEXT NOT NULL,
        restore_window TEXT NOT NULL,
        purge_policy TEXT NOT NULL,
        export_reconcile_behavior TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS source_policy_overrides (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        dimension TEXT NOT NULL,
        override_value JSONB NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at TIMESTAMPTZ,
        UNIQUE(source_id, dimension)
      );

      CREATE TABLE IF NOT EXISTS source_authority_rules (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('auto_canonical', 'candidate', 'verify_first', 'conflict_check', 'never_canonical', 'quarantine')),
        conditions_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(source_kind, claim_type)
      );

      CREATE TABLE IF NOT EXISTS source_retention_rules (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL UNIQUE,
        raw_retention TEXT NOT NULL,
        chunk_retention TEXT NOT NULL,
        restore_window TEXT NOT NULL,
        purge_policy TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS source_llm_rules (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL UNIQUE,
        llm_access TEXT NOT NULL,
        runner_access TEXT NOT NULL,
        redaction_required BOOLEAN NOT NULL DEFAULT true,
        explicit_grant_required BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS source_status_events (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        previous_state TEXT,
        next_state TEXT,
        actor_ref TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_source_status_events_source_created
        ON source_status_events(source_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS source_items (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        origin_event TEXT NOT NULL CHECK (origin_event IN ('initial_import', 'connector_sync', 'manual_entry', 'user_direct_entry', 'session_capture', 'markdown_edit')),
        locator TEXT,
        title TEXT NOT NULL DEFAULT '',
        source_created_at TIMESTAMPTZ,
        source_updated_at TIMESTAMPTZ,
        ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        content_hash TEXT NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        raw_copy_mode TEXT NOT NULL,
        raw_copy_ref TEXT,
        sensitivity_level TEXT NOT NULL DEFAULT 'normal',
        ingest_status TEXT NOT NULL CHECK (ingest_status IN ('pending', 'ready', 'failed', 'revoked', 'purged')),
        retention_policy_id TEXT,
        UNIQUE(source_id, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_source_items_source_ingested
        ON source_items(source_id, ingested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_source_items_hash
        ON source_items(content_hash);

      CREATE TABLE IF NOT EXISTS source_chunks (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        chunk_hash TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        redacted_text TEXT NOT NULL DEFAULT '',
        token_count INTEGER NOT NULL DEFAULT 0,
        parser_version TEXT NOT NULL,
        extractor_version TEXT NOT NULL DEFAULT '',
        sensitivity_flags JSONB NOT NULL DEFAULT '[]',
        prompt_injection_risk TEXT NOT NULL CHECK (prompt_injection_risk IN ('none', 'flagged', 'quarantined')),
        secret_risk TEXT NOT NULL CHECK (secret_risk IN ('none', 'flagged', 'detected', 'redacted')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ,
        UNIQUE(source_item_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_source_chunks_item_index
        ON source_chunks(source_item_id, chunk_index);
      CREATE INDEX IF NOT EXISTS idx_source_chunks_hash
        ON source_chunks(chunk_hash);

      CREATE TABLE IF NOT EXISTS source_item_events (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_source_item_events_item_created
        ON source_item_events(source_item_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS raw_access_ledger (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT,
        job_id TEXT,
        source_id TEXT NOT NULL,
        source_item_id TEXT REFERENCES source_items(id) ON DELETE SET NULL,
        chunk_ids JSONB NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL,
        policy_decision TEXT NOT NULL,
        policy_reason TEXT NOT NULL DEFAULT '',
        prompt_hash TEXT,
        input_hash TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_raw_access_ledger_source_created
        ON raw_access_ledger(source_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_raw_access_ledger_actor_created
        ON raw_access_ledger(actor_type, actor_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS secret_detections (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        source_chunk_id TEXT REFERENCES source_chunks(id) ON DELETE CASCADE,
        secret_type TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        confidence REAL NOT NULL,
        redaction_status TEXT NOT NULL CHECK (redaction_status IN ('pending', 'redacted', 'purged')),
        purge_plan_status TEXT NOT NULL DEFAULT 'pending' CHECK (purge_plan_status IN ('pending', 'approved', 'purged', 'ignored')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_secret_detections_item
        ON secret_detections(source_item_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS prompt_injection_flags (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        source_chunk_id TEXT REFERENCES source_chunks(id) ON DELETE CASCADE,
        flag_type TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('flagged', 'quarantined')),
        evidence_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_injection_flags_item
        ON prompt_injection_flags(source_item_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ingest_attempts (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_item_id TEXT REFERENCES source_items(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'skipped')),
        error_message TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_ingest_attempts_source_started
        ON ingest_attempts(source_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS credential_refs (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('credential_gateway', 'os_keychain', 'password_manager', 'local_encrypted_vault')),
        reference TEXT NOT NULL,
        scopes_json JSONB NOT NULL DEFAULT '[]',
        expires_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        rotation_status TEXT NOT NULL CHECK (rotation_status IN ('current', 'rotation_due', 'rotating', 'revoked')),
        health_status TEXT NOT NULL CHECK (health_status IN ('healthy', 'unhealthy', 'expired', 'unknown')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(connector_id, account_id, provider, reference)
      );

      CREATE INDEX IF NOT EXISTS idx_credential_refs_account
        ON credential_refs(connector_id, account_id);
      CREATE INDEX IF NOT EXISTS idx_credential_refs_health
        ON credential_refs(health_status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS connector_accounts (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
        account_locator TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        credential_ref_id TEXT REFERENCES credential_refs(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked', 'failed')),
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(connector_id, account_locator)
      );

      CREATE INDEX IF NOT EXISTS idx_connector_accounts_source
        ON connector_accounts(source_id);
      CREATE INDEX IF NOT EXISTS idx_connector_accounts_status
        ON connector_accounts(connector_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS connector_grants (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        grant_state TEXT NOT NULL CHECK (grant_state IN ('granted', 'denied', 'revoked')),
        granted_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(account_id, scope)
      );

      CREATE INDEX IF NOT EXISTS idx_connector_grants_state
        ON connector_grants(account_id, grant_state);

      CREATE TABLE IF NOT EXISTS connector_sync_states (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL,
        cursor_json JSONB NOT NULL DEFAULT '{}',
        last_sync_started_at TIMESTAMPTZ,
        last_sync_finished_at TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        last_failure_at TIMESTAMPTZ,
        health_status TEXT NOT NULL CHECK (health_status IN ('healthy', 'unhealthy', 'paused', 'revoked', 'unknown')),
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        last_error TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(account_id, connector_id)
      );

      CREATE INDEX IF NOT EXISTS idx_connector_sync_states_health
        ON connector_sync_states(connector_id, health_status, updated_at DESC);
    `,
  },
  {
    version: 45,
    name: 'memory_report_action_operation_contract',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('memory_mutation_events') IS NOT NULL THEN
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_operation;
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS memory_mutation_events_operation_check;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_operation
            CHECK (
              operation IN (
                'create_memory_session',
                'close_memory_session',
                'expire_memory_session',
                'revoke_memory_session',
                'dry_run_memory_mutation',
                'list_memory_mutation_events',
                'record_memory_mutation_event',
                'create_memory_patch_candidate',
                'dry_run_memory_patch_candidate',
                'review_memory_patch_candidate',
                'apply_memory_patch_candidate',
                'create_redaction_plan',
                'dry_run_redaction_plan',
                'execute_redaction_plan',
                'put_page',
                'delete_page',
                'upsert_profile_memory_entry',
                'write_profile_memory_entry',
                'delete_profile_memory_entry',
                'record_personal_episode',
                'write_personal_episode_entry',
                'delete_personal_episode_entry',
                'upsert_memory_realm',
                'attach_memory_realm_to_session',
                'create_memory_candidate_entry',
                'advance_memory_candidate_status',
                'reject_memory_candidate_entry',
                'delete_memory_candidate_entry',
                'promote_memory_candidate_entry',
                'supersede_memory_candidate_entry',
                'export_memory_artifact',
                'sync_memory_artifact',
                'repair_memory_ledger',
                'physical_delete_memory_record',
                'governed_canonical_write',
                'pause_source_processing',
                'revoke_source_consent',
                'rerun_memory_job'
              )
            );
        END IF;
        IF to_regclass('source_status_events') IS NOT NULL THEN
          CREATE OR REPLACE FUNCTION prevent_source_status_event_mutation()
          RETURNS trigger AS $fn$
          BEGIN
            RAISE EXCEPTION 'source status events are append-only';
          END;
          $fn$ LANGUAGE plpgsql;

          DROP TRIGGER IF EXISTS prevent_source_status_events_update ON source_status_events;
          CREATE TRIGGER prevent_source_status_events_update
            BEFORE UPDATE ON source_status_events
            FOR EACH ROW EXECUTE FUNCTION prevent_source_status_event_mutation();
          DROP TRIGGER IF EXISTS prevent_source_status_events_delete ON source_status_events;
          CREATE TRIGGER prevent_source_status_events_delete
            BEFORE DELETE ON source_status_events
            FOR EACH ROW EXECUTE FUNCTION prevent_source_status_event_mutation();
        END IF;
      END $$;
    `,
  },
  {
    version: 46,
    name: 'oauth_dcr_clients_and_authorization_codes',
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_dcr_clients (
        client_id                  TEXT PRIMARY KEY,
        client_name                TEXT NOT NULL,
        redirect_uris              TEXT[] NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
        issued_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_authorized_at         TIMESTAMPTZ
      );

      ALTER TABLE oauth_dcr_clients
        ADD COLUMN IF NOT EXISTS last_authorized_at TIMESTAMPTZ;
      DROP INDEX IF EXISTS idx_oauth_dcr_clients_active;

      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash      TEXT PRIMARY KEY,
        client_id      TEXT NOT NULL REFERENCES oauth_dcr_clients(client_id) ON DELETE CASCADE,
        redirect_uri   TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope          TEXT[] NOT NULL DEFAULT ARRAY['mcp'],
        expires_at     TIMESTAMPTZ NOT NULL,
        used_at        TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_client
        ON oauth_authorization_codes(client_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_unexpired
        ON oauth_authorization_codes(expires_at)
        WHERE used_at IS NULL;
    `,
  },
  {
    version: 47,
    name: 'remove_oauth_dcr_client_revocation_state',
    sql: `
      DROP INDEX IF EXISTS idx_oauth_dcr_clients_active;
      ALTER TABLE oauth_dcr_clients
        DROP COLUMN IF EXISTS revoked_at;
    `,
  },
  {
    version: 48,
    name: 'auto_promote_verdicts',
    sql: `
      CREATE TABLE IF NOT EXISTS auto_promote_verdicts (
        candidate_id    TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        runner_kind     TEXT NOT NULL,
        prompt_version  TEXT NOT NULL,
        decision        TEXT NOT NULL,
        confidence      REAL NOT NULL,
        reasoning       TEXT NOT NULL DEFAULT '',
        judged_at       TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (candidate_id, content_hash, runner_kind, prompt_version)
      );
    `,
  },
  {
    version: 49,
    name: 'pgvector_1024_for_qwen3',
    sql: `
      DROP INDEX IF EXISTS idx_chunks_embedding;
      DO $$
      BEGIN
        IF to_regclass('pages') IS NOT NULL THEN
          ALTER TABLE pages
            ADD COLUMN IF NOT EXISTS page_embedding vector(1024);
          ALTER TABLE pages
            ALTER COLUMN page_embedding TYPE vector(1024)
            USING NULL::vector(1024);
          UPDATE pages
          SET page_embedding = NULL;
        END IF;

        IF to_regclass('content_chunks') IS NOT NULL THEN
          ALTER TABLE content_chunks
            ALTER COLUMN embedding TYPE vector(1024)
            USING NULL::vector(1024);
          ALTER TABLE content_chunks
            ALTER COLUMN model SET DEFAULT 'qwen3-embedding:0.6b';
          UPDATE content_chunks
          SET embedding = NULL,
              embedded_at = NULL,
              model = COALESCE((SELECT value FROM config WHERE key = 'embedding_model'), 'qwen3-embedding:0.6b');
          CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
        END IF;
      END;
      $$;
      INSERT INTO config (key, value) VALUES ('embedding_model', 'qwen3-embedding:0.6b')
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO config (key, value) VALUES ('embedding_dimensions', '1024')
      ON CONFLICT (key) DO NOTHING;
    `,
  },
  {
    version: 50,
    name: 'qwen3_token_chunk_defaults',
    sql: `
      INSERT INTO config (key, value) VALUES ('chunk_size_tokens', '768')
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO config (key, value) VALUES ('chunk_overlap_tokens', '128')
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO config (key, value) VALUES ('chunk_strategy', 'qwen3_token_recursive')
      ON CONFLICT (key) DO NOTHING;
      DO $$
      BEGIN
        IF to_regclass('pages') IS NOT NULL THEN
          UPDATE pages
          SET page_embedding = NULL;
        END IF;

        IF to_regclass('content_chunks') IS NOT NULL THEN
          UPDATE content_chunks
          SET embedding = NULL,
              embedded_at = NULL,
              model = COALESCE((SELECT value FROM config WHERE key = 'embedding_model'), 'qwen3-embedding:0.6b');
        END IF;
      END;
      $$;
    `,
  },
  {
    version: 51,
    name: 'assertion_scope_policy_labels',
    sql: `
      ALTER TABLE assertions
        ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT 'workspace:default',
        ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'policy:v1',
        ADD COLUMN IF NOT EXISTS authority_scope TEXT NOT NULL DEFAULT 'work';

      ALTER TABLE assertion_evidence
        ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT 'workspace:default',
        ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'policy:v1',
        ADD COLUMN IF NOT EXISTS authority_scope TEXT NOT NULL DEFAULT 'work';

      ALTER TABLE assertion_links
        ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT 'workspace:default',
        ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'policy:v1';

      CREATE INDEX IF NOT EXISTS idx_assertions_scope_target_property
        ON assertions(scope_id, target_slug, target_type, target_id, property);
      CREATE INDEX IF NOT EXISTS idx_assertion_evidence_scope_assertion
        ON assertion_evidence(scope_id, assertion_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assertion_links_scope_from
        ON assertion_links(scope_id, from_assertion_id, link_type);
    `,
  },
  {
    version: 52,
    name: 'embedding_coverage_indexes',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('content_chunks') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_chunks_embedded
            ON content_chunks(page_id) WHERE embedded_at IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_chunks_missing_embedding
            ON content_chunks(page_id) WHERE embedded_at IS NULL;
        END IF;
      END
      $$;
    `,
  },
  {
    version: 53,
    name: 'memory_candidate_verification_fields',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('memory_candidate_entries') IS NOT NULL THEN
          ALTER TABLE memory_candidate_entries
            ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified',
            ADD COLUMN IF NOT EXISTS verification_method TEXT,
            ADD COLUMN IF NOT EXISTS verification_evidence TEXT,
            ADD COLUMN IF NOT EXISTS verification_source_refs JSONB NOT NULL DEFAULT '[]',
            ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
          ALTER TABLE memory_candidate_entries
            DROP CONSTRAINT IF EXISTS memory_candidate_entries_verification_status_check;
          ALTER TABLE memory_candidate_entries
            ADD CONSTRAINT memory_candidate_entries_verification_status_check
            CHECK (verification_status IN ('unverified', 'verified', 'refuted'));
          ALTER TABLE memory_candidate_entries
            DROP CONSTRAINT IF EXISTS memory_candidate_entries_verification_method_check;
          ALTER TABLE memory_candidate_entries
            ADD CONSTRAINT memory_candidate_entries_verification_method_check
            CHECK (verification_method IS NULL OR verification_method IN ('command_execution', 'db_query', 'file_inspection', 'source_recheck', 'user_confirmation', 'external_lookup'));
          CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_verification
            ON memory_candidate_entries(scope_id, verification_status, updated_at DESC);
        END IF;
      END
      $$;
    `,
  },
  {
    version: 54,
    name: 'memory_mutation_events_approved_result',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('memory_mutation_events') IS NOT NULL THEN
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS memory_mutation_events_result_check;
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_result;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_result
            CHECK (
              result IN (
                'dry_run',
                'staged_for_review',
                'approved',
                'applied',
                'conflict',
                'denied',
                'failed',
                'redacted'
              )
            );
        END IF;
      END
      $$;
    `,
  },
  {
    version: 55,
    name: 'canonical_target_proposal_storage',
    sql: `
      CREATE TABLE IF NOT EXISTS canonical_target_proposal_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        source_candidate_id TEXT NOT NULL,
        linked_candidate_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(linked_candidate_ids) = 'array'),
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')),
        status_reason TEXT,
        proposal_kind TEXT NOT NULL CHECK (proposal_kind IN ('project_root', 'project_doc', 'system_page', 'concept_page', 'idea_page', 'original_page')),
        target_object_type TEXT NOT NULL CHECK (target_object_type IN ('curated_note')),
        proposed_slug TEXT NOT NULL,
        proposed_title TEXT NOT NULL,
        proposed_page_type TEXT NOT NULL CHECK (proposed_page_type IN ('project', 'system', 'concept')),
        proposed_repo_path TEXT,
        confidence_score REAL NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
        importance_score REAL NOT NULL CHECK (importance_score >= 0 AND importance_score <= 1),
        rationale TEXT NOT NULL DEFAULT '',
        filing_basis JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filing_basis) = 'object'),
        source_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_refs) = 'array'),
        candidate_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(candidate_snapshot) = 'object'),
        duplicate_review JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(duplicate_review) = 'object'),
        slug_quality_warnings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(slug_quality_warnings) = 'array'),
        approval_actor TEXT,
        approved_at TIMESTAMPTZ,
        approval_reason TEXT,
        bound_candidate_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(bound_candidate_ids) = 'array'),
        stub_patch_candidate_id TEXT,
        stub_patch_state TEXT,
        rejected_at TIMESTAMPTZ,
        rejection_reason TEXT,
        superseded_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_canonical_target_proposals_scope_status
        ON canonical_target_proposal_entries(scope_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_canonical_target_proposals_scope_slug
        ON canonical_target_proposal_entries(scope_id, proposed_slug);
      CREATE INDEX IF NOT EXISTS idx_canonical_target_proposals_source_candidate
        ON canonical_target_proposal_entries(source_candidate_id);
      CREATE INDEX IF NOT EXISTS idx_canonical_target_proposals_linked_candidates
        ON canonical_target_proposal_entries USING GIN (linked_candidate_ids);

      CREATE TABLE IF NOT EXISTS canonical_target_proposal_status_events (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL
          CONSTRAINT fk_canonical_target_proposal_status_events_proposal
          REFERENCES canonical_target_proposal_entries(id) ON DELETE CASCADE,
        scope_id TEXT NOT NULL,
        from_status TEXT CHECK (
          from_status IS NULL
          OR from_status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')
        ),
        to_status TEXT NOT NULL CHECK (
          to_status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')
        ),
        event_kind TEXT NOT NULL CHECK (
          event_kind IN ('created', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')
        ),
        actor TEXT,
        review_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_canonical_target_proposal_status_events_proposal_created
        ON canonical_target_proposal_status_events(proposal_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_canonical_target_proposal_status_events_scope_created
        ON canonical_target_proposal_status_events(scope_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_canonical_target_proposal_status_events_kind_created
        ON canonical_target_proposal_status_events(event_kind, created_at DESC, id DESC);

      DO $$
      BEGIN
        IF to_regclass('canonical_target_proposal_entries') IS NOT NULL
          AND to_regclass('memory_candidate_entries') IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'canonical_target_proposal_entries'::regclass
              AND conname = 'fk_canonical_target_proposals_source_candidate'
          ) THEN
            ALTER TABLE canonical_target_proposal_entries
              ADD CONSTRAINT fk_canonical_target_proposals_source_candidate
              FOREIGN KEY (source_candidate_id)
              REFERENCES memory_candidate_entries(id);
          END IF;

          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'canonical_target_proposal_entries'::regclass
              AND conname = 'fk_canonical_target_proposals_stub_patch_candidate'
          ) THEN
            ALTER TABLE canonical_target_proposal_entries
              ADD CONSTRAINT fk_canonical_target_proposals_stub_patch_candidate
              FOREIGN KEY (stub_patch_candidate_id)
              REFERENCES memory_candidate_entries(id);
          END IF;
        END IF;

        IF to_regclass('canonical_target_proposal_entries') IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'canonical_target_proposal_entries'::regclass
              AND conname = 'fk_canonical_target_proposals_superseded_by'
          ) THEN
            ALTER TABLE canonical_target_proposal_entries
              ADD CONSTRAINT fk_canonical_target_proposals_superseded_by
              FOREIGN KEY (superseded_by)
              REFERENCES canonical_target_proposal_entries(id);
          END IF;
        END IF;
      END
      $$;

      DO $$
      BEGIN
        IF to_regclass('memory_candidate_entries') IS NOT NULL THEN
          ALTER TABLE memory_candidate_entries
            DROP CONSTRAINT IF EXISTS chk_memory_candidate_entries_patch_target_kind;
          ALTER TABLE memory_candidate_entries
            ADD CONSTRAINT chk_memory_candidate_entries_patch_target_kind
            CHECK (
              patch_target_kind IS NULL
              OR patch_target_kind IN (
                'page',
                'source_record',
                'task_thread',
                'working_set',
                'task_event',
                'task_episode',
                'attempt',
                'decision',
                'procedure',
                'memory_candidate',
                'memory_patch_candidate',
                'canonical_target_proposal',
                'profile_memory',
                'personal_episode',
                'memory_realm',
                'memory_session',
                'memory_session_attachment',
                'context_map',
                'context_atlas',
                'file_artifact',
                'export_artifact',
                'ledger_event'
              )
            );
        END IF;
      END
      $$;

      DO $$
      BEGIN
        IF to_regclass('memory_mutation_events') IS NOT NULL THEN
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_operation;
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS memory_mutation_events_operation_check;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_operation
            CHECK (
              operation IN (
                'create_memory_session',
                'close_memory_session',
                'expire_memory_session',
                'revoke_memory_session',
                'dry_run_memory_mutation',
                'list_memory_mutation_events',
                'record_memory_mutation_event',
                'create_memory_patch_candidate',
                'dry_run_memory_patch_candidate',
                'review_memory_patch_candidate',
                'apply_memory_patch_candidate',
                'create_redaction_plan',
                'dry_run_redaction_plan',
                'execute_redaction_plan',
                'put_page',
                'delete_page',
                'upsert_profile_memory_entry',
                'write_profile_memory_entry',
                'delete_profile_memory_entry',
                'record_personal_episode',
                'write_personal_episode_entry',
                'delete_personal_episode_entry',
                'upsert_memory_realm',
                'attach_memory_realm_to_session',
                'create_memory_candidate_entry',
                'advance_memory_candidate_status',
                'verify_memory_candidate_entry',
                'reject_memory_candidate_entry',
                'delete_memory_candidate_entry',
                'promote_memory_candidate_entry',
                'supersede_memory_candidate_entry',
                'create_canonical_target_proposal',
                'approve_canonical_target_proposal',
                'reject_canonical_target_proposal',
                'complete_canonical_target_proposal_binding',
                'bind_memory_candidate_target',
                'export_memory_artifact',
                'sync_memory_artifact',
                'repair_memory_ledger',
                'physical_delete_memory_record',
                'governed_canonical_write',
                'pause_source_processing',
                'revoke_source_consent',
                'rerun_memory_job'
              )
            );

          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS chk_memory_mutation_events_target_kind;
          ALTER TABLE memory_mutation_events
            DROP CONSTRAINT IF EXISTS memory_mutation_events_target_kind_check;
          ALTER TABLE memory_mutation_events
            ADD CONSTRAINT chk_memory_mutation_events_target_kind
            CHECK (
              target_kind IN (
                'page',
                'source_record',
                'task_thread',
                'working_set',
                'task_event',
                'task_episode',
                'attempt',
                'decision',
                'procedure',
                'memory_candidate',
                'memory_patch_candidate',
                'canonical_target_proposal',
                'profile_memory',
                'personal_episode',
                'memory_realm',
                'memory_session',
                'memory_session_attachment',
                'context_map',
                'context_atlas',
                'file_artifact',
                'export_artifact',
                'ledger_event'
              )
            );
        END IF;
      END
      $$;
    `,
  },
  {
    version: 56,
    name: 'mcp_surface_request_log_context',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('access_tokens') IS NOT NULL THEN
          ALTER TABLE access_tokens
            ALTER COLUMN scopes SET DEFAULT ARRAY['mcp']::TEXT[];
          UPDATE access_tokens SET scopes = ARRAY['mcp']::TEXT[] WHERE scopes IS NULL;
        END IF;

        IF to_regclass('mcp_request_log') IS NOT NULL THEN
          ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS error_code TEXT;
          ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS error_reason TEXT;
          ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS surface_profile TEXT;
        END IF;
      END
      $$;
    `,
  },
  {
    version: 57,
    name: 'mcp_request_log_auth_principal',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('mcp_request_log') IS NOT NULL THEN
          ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS auth_principal_json TEXT;
        END IF;
      END
      $$;
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS.length > 0
  ? MIGRATIONS[MIGRATIONS.length - 1].version
  : 1;

export function freshSchemaMigrationSql(afterVersion = 1): string {
  return MIGRATIONS
    .filter(migration => migration.version > afterVersion)
    .map(migration => migration.sql.trim())
    .filter(sql => sql.length > 0)
    .join('\n\n');
}

export async function runMigrations(
  engine: SqlMigrationEngine,
  options: { log?: MigrationLog } = {},
): Promise<{ applied: number; current: number }> {
  const log = options.log ?? defaultMigrationLog;
  const currentStr = await engine.getConfig('version');
  const current = parseInt(currentStr || '1', 10);

  // Common startup case: schema already current — return without scanning
  // the migration list.
  const firstPendingIndex = MIGRATIONS.findIndex((m) => m.version > current);
  if (firstPendingIndex === -1) {
    return { applied: 0, current };
  }

  let applied = 0;
  for (let index = firstPendingIndex; index < MIGRATIONS.length;) {
    const m = MIGRATIONS[index]!;
    if (m.version <= current) {
      index++;
      continue;
    }

    if (!m.handler) {
      const batch: Migration[] = [];
      while (index < MIGRATIONS.length) {
        const candidate = MIGRATIONS[index]!;
        if (candidate.version <= current) {
          index++;
          continue;
        }
        if (candidate.handler) {
          break;
        }
        batch.push(candidate);
        index++;
      }

      await engine.transaction(async (tx) => {
        for (const migration of batch) {
          if (migration.sql) {
            await (tx as SqlMigrationEngine).runMigration(migration.version, migration.sql);
          }
          await tx.setConfig('version', String(migration.version));
        }
      });

      for (const migration of batch) {
        log(`  Migration ${migration.version} applied: ${migration.name}`);
        applied++;
      }
      continue;
    }

    if (m.version > current) {
      // SQL migration (transactional)
      if (m.sql) {
        await engine.transaction(async (tx) => {
          await (tx as SqlMigrationEngine).runMigration(m.version, m.sql);
        });
      }

      // Application-level handler (runs outside transaction for flexibility)
      if (m.handler) {
        await m.handler(engine, { log });
      }

      // Update version after both SQL and handler succeed
      await engine.setConfig('version', String(m.version));
      log(`  Migration ${m.version} applied: ${m.name}`);
      applied++;
    }
    index++;
  }

  return { applied, current: applied > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : current };
}

async function backfillSearchText(engine: BrainEngine, pageId: number, searchText: string): Promise<void> {
  const candidate = engine as BrainEngine & {
    sql?: (TemplateStringsArray | any);
    db?: { query: (query: string, values?: unknown[]) => Promise<unknown> };
  };

  if ('sql' in candidate && candidate.sql) {
    await candidate.sql`UPDATE pages SET search_text = ${searchText} WHERE id = ${pageId}`;
    return;
  }

  if ('db' in candidate && candidate.db) {
    await candidate.db.query('UPDATE pages SET search_text = $1 WHERE id = $2', [searchText, pageId]);
    return;
  }

  throw new Error('search_text backfill requires a SQL-capable engine');
}

async function ensurePageEmbeddingColumn(engine: BrainEngine): Promise<void> {
  const candidate = engine as BrainEngine & {
    sql?: (TemplateStringsArray | any);
    db?: { query: (query: string, values?: unknown[]) => Promise<unknown> };
  };

  if ('sql' in candidate && candidate.sql) {
    await candidate.sql`ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_embedding vector(1024)`;
    return;
  }

  if ('db' in candidate && candidate.db) {
    await candidate.db.query(
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_embedding vector(1024)'
    );
  }
}

async function backfillMissingPageEmbeddings(engine: BrainEngine, log: MigrationLog): Promise<void> {
  const pageEmbeddings = await engine.getPageEmbeddings();
  let backfilled = 0;

  for (const page of pageEmbeddings) {
    if (page.embedding) {
      continue;
    }

    const chunks = await engine.getChunksWithEmbeddings(page.slug);
    const centroid = buildPageCentroid(chunks.map(chunk => normalizeEmbeddingValue(chunk.embedding)));
    if (!centroid) {
      continue;
    }

    await engine.updatePageEmbedding(page.slug, centroid);
    backfilled++;
  }

  if (backfilled > 0) {
    log(`  Backfilled ${backfilled} page embedding centroid(s)`);
  }
}

function normalizeEmbeddingValue(value: unknown): Float32Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return new Float32Array(value.map((entry) => Number(entry)));

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const body = trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
    if (body.length === 0) return new Float32Array(0);

    const parts = body.split(',').map((entry) => Number(entry.trim()));
    if (parts.some((entry) => Number.isNaN(entry))) return null;
    return new Float32Array(parts);
  }

  return null;
}

async function listAllPages(engine: BrainEngine, batchSize = 1000): Promise<Page[]> {
  const pages: Page[] = [];

  for (let offset = 0; ; offset += batchSize) {
    const batch = await engine.listPages({ limit: batchSize, offset });
    pages.push(...batch);
    if (batch.length < batchSize) {
      break;
    }
  }

  return pages;
}
