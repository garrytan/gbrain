import type { BrainEngine } from './engine.ts';
import { buildFrontmatterSearchText } from './markdown.ts';
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
  handler?: (engine: BrainEngine) => Promise<void>;
}

// Migrations are embedded here, not loaded from files.
// Add new migrations at the end. Never modify existing ones.
const MIGRATIONS: Migration[] = [
  // Version 1 is the baseline (schema.sql creates everything with IF NOT EXISTS).
  {
    version: 2,
    name: 'slugify_existing_pages',
    sql: '',
    handler: async (engine) => {
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
          model = 'nomic-embed-text';
      INSERT INTO config (key, value) VALUES ('embedding_model', 'nomic-embed-text')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
      INSERT INTO config (key, value) VALUES ('embedding_dimensions', '768')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
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
      for (const page of pages) {
        const searchText = buildFrontmatterSearchText(page.frontmatter);
        await backfillSearchText(engine, page.id, searchText);
        await ensurePageChunks(engine, page);
      }
    },
  },
  {
    version: 7,
    name: 'page_embedding_upgrade',
    sql: '',
    handler: async (engine) => {
      await ensurePageEmbeddingColumn(engine);
      await backfillMissingPageEmbeddings(engine);
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
      // SQL migration (transactional)
      if (m.sql) {
        await engine.transaction(async (tx) => {
          await tx.runMigration(m.version, m.sql);
        });
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
    await candidate.sql`ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_embedding vector(768)`;
    return;
  }

  if ('db' in candidate && candidate.db) {
    await candidate.db.query(
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_embedding vector(768)'
    );
  }
}

async function backfillMissingPageEmbeddings(engine: BrainEngine): Promise<void> {
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
    console.log(`  Backfilled ${backfilled} page embedding centroid(s)`);
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
