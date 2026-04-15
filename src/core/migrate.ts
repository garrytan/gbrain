import type { BrainEngine } from './engine.ts';
import { buildFrontmatterSearchText } from './markdown.ts';
import { ensurePageChunks } from './page-chunks.ts';
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
