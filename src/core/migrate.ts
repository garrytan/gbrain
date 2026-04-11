import type { BrainEngine } from './engine.ts';
import { slugifyPath } from './sync.ts';
import { qualifiedModel, embeddingAlterSQL } from './utils.ts';

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
    name: 'dynamic_embedding_dimensions',
    sql: '',
    handler: async (engine) => {
      const { getProvider } = await import('./embedding/index.ts');
      const provider = getProvider();
      const newDims = provider.dimensions;
      const newModel = qualifiedModel(provider);

      const [currentDims, rawModel, currentProvider] = await Promise.all([
        engine.getConfig('embedding_dimensions'),
        engine.getConfig('embedding_model'),
        engine.getConfig('embedding_provider'),
      ]);
      let currentModel = rawModel;
      const dbDims = parseInt(currentDims || '1536', 10);

      // Normalize legacy format: 'text-embedding-3-large' → 'openai:text-embedding-3-large'
      if (currentModel && !currentModel.includes(':')) {
        currentModel = `openai:${currentModel}`;
        await engine.setConfig('embedding_model', currentModel);
      }

      // Ensure embedding_provider key exists (added in this version)
      if (!currentProvider) {
        await engine.setConfig('embedding_provider', provider.name);
      }

      if (dbDims !== newDims) {
        console.log(`  Embedding dimensions changed: ${dbDims} → ${newDims}`);
        await engine.transaction(async (tx) => {
          await tx.runMigration(5, embeddingAlterSQL(newDims));
        });

        await engine.setConfig('embedding_provider', provider.name);
        await engine.setConfig('embedding_dimensions', String(newDims));
        await engine.setConfig('embedding_model', newModel);

        const stats = await engine.getStats();
        console.log(`  Schema updated to vector(${newDims}). Run \`gbrain embed --all\` to re-embed ${stats.chunk_count} chunks.`);
      } else if (currentModel !== newModel) {
        console.log(`  Embedding model changed: ${currentModel} → ${newModel}`);
        await engine.transaction(async (tx) => {
          await tx.runMigration(5, `UPDATE content_chunks SET embedded_at = NULL WHERE embedded_at IS NOT NULL;`);
        });
        await engine.setConfig('embedding_provider', provider.name);
        await engine.setConfig('embedding_model', newModel);
        console.log(`  Run \`gbrain embed --all\` to re-embed with new model.`);
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
