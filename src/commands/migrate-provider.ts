/**
 * FORK: gbrain migrate --provider <openai|gemini> [--dimensions N] [--dry-run]
 *
 * Migrates an existing brain from one embedding provider to another.
 *
 * Steps:
 *  1. Read current provider from config table
 *  2. Alter vector column to new dimensions (if dimensions differ)
 *  3. Re-embed all chunks using the new provider
 *  4. Update config table (embedding_model, embedding_dimensions, embedding_provider)
 *  5. Persist new provider choice to ~/.gbrain/config.json
 *
 * This is safe to resume: if interrupted, re-running will re-embed any
 * chunks whose embedding is NULL (step 3 is idempotent given that the
 * ALTER completed).
 */

import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, saveConfig } from '../core/config.ts';
import { getActiveProvider, resetActiveProvider } from '../core/embedding-provider.ts';
import { GeminiEmbedder } from '../core/providers/gemini-embedder.ts';
import { OpenAIEmbedder } from '../core/providers/openai-embedder.ts';
import type { ChunkInput } from '../core/types.ts';
import { PGLiteEngine } from '../core/pglite-engine.ts';
import { PostgresEngine } from '../core/postgres-engine.ts';

const EMBED_BATCH = 50; // conservative for migration (avoids rate-limit spikes)

export async function runMigrateProvider(engine: BrainEngine, args: string[]): Promise<void> {
  const providerIdx = args.indexOf('--provider');
  if (providerIdx === -1 || !args[providerIdx + 1]) {
    console.error('Usage: gbrain migrate --provider <openai|gemini> [--dimensions N] [--dry-run]');
    process.exit(1);
  }

  const newProviderName = args[providerIdx + 1] as 'openai' | 'gemini';
  if (newProviderName !== 'openai' && newProviderName !== 'gemini') {
    console.error(`Unknown provider "${newProviderName}". Use: openai or gemini`);
    process.exit(1);
  }

  const dimsIdx = args.indexOf('--dimensions');
  const requestedDims = dimsIdx !== -1 ? parseInt(args[dimsIdx + 1], 10) : undefined;
  const dryRun = args.includes('--dry-run');

  // Build the new provider instance to get its defaults
  const newProvider = newProviderName === 'gemini'
    ? new GeminiEmbedder(requestedDims ?? 768)
    : new OpenAIEmbedder();

  // Read current state from config table
  const currentModel = await getConfigValue(engine, 'embedding_model') ?? 'text-embedding-3-large';
  const currentDims = parseInt(await getConfigValue(engine, 'embedding_dimensions') ?? '1536', 10);
  const currentProviderName = await getConfigValue(engine, 'embedding_provider') ?? 'openai';

  const newDims = newProvider.dimensions;
  const newModel = newProvider.model;
  const dimsChange = currentDims !== newDims;

  // Count chunks to re-embed
  const allSlugs = await engine.getAllSlugs();
  let totalChunks = 0;
  for (const slug of allSlugs) {
    const chunks = await engine.getChunks(slug);
    totalChunks += chunks.length;
  }

  console.log('');
  console.log(`Switching embedding provider:`);
  console.log(`  From: ${currentProviderName} — ${currentModel} (${currentDims} dims)`);
  console.log(`  To:   ${newProviderName} — ${newModel} (${newDims} dims)`);
  console.log('');
  console.log(`Brain has ${allSlugs.size} pages, ${totalChunks} chunks to re-embed.`);
  if (dimsChange) {
    console.log(`Vector column will change: vector(${currentDims}) → vector(${newDims})`);
    console.log('All existing embeddings will be dropped during the alter.');
  }
  const batches = Math.ceil(totalChunks / EMBED_BATCH);
  console.log(`Estimated API batches: ${batches} (${EMBED_BATCH} chunks/batch)`);
  console.log('');

  if (dryRun) {
    console.log('[dry-run] No changes made.');
    return;
  }

  // Step 1: Alter vector column if dimensions change
  if (dimsChange) {
    console.log(`Altering vector column: vector(${currentDims}) → vector(${newDims})...`);
    const alterSql = [
      `DROP INDEX IF EXISTS idx_chunks_embedding`,
      `ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding`,
      `ALTER TABLE content_chunks ADD COLUMN embedding vector(${newDims})`,
      `CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)`,
    ].join(';\n');
    await execRawSQL(engine, alterSql);
    console.log('  Schema altered.');
  }

  // Step 2: Set the new provider in env before embedding
  process.env.GBRAIN_EMBEDDING_PROVIDER = newProviderName;
  if (requestedDims) process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(requestedDims);
  resetActiveProvider(); // force factory to re-read env

  // Step 3: Re-embed all chunks slug by slug
  console.log('Re-embedding chunks...');
  let done = 0;
  for (const slug of allSlugs) {
    const chunks = await engine.getChunks(slug);
    if (chunks.length === 0) continue;

    // Embed in sub-batches
    const chunkInputs: ChunkInput[] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const texts = batch.map(c => c.chunk_text);
      const embeddings = await newProvider.embedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        chunkInputs.push({
          chunk_index: batch[j].chunk_index,
          chunk_text: batch[j].chunk_text,
          chunk_source: batch[j].chunk_source,
          embedding: embeddings[j],
          model: newModel,
          token_count: batch[j].token_count,
        });
      }
      done += batch.length;
      const pct = Math.round((done / totalChunks) * 100);
      process.stdout.write(`\r  Progress: ${done}/${totalChunks} chunks (${pct}%)`);
    }

    await engine.upsertChunks(slug, chunkInputs);
  }
  console.log('\n  Done re-embedding.');

  // Step 4: Update config table
  await setConfigValue(engine, 'embedding_model', newModel);
  await setConfigValue(engine, 'embedding_dimensions', String(newDims));
  await setConfigValue(engine, 'embedding_provider', newProviderName);
  console.log('Config table updated.');

  // Step 5: Persist to ~/.gbrain/config.json
  const fileConfig = loadConfig();
  if (fileConfig) {
    saveConfig({
      ...fileConfig,
      embedding_provider: newProviderName,
      embedding_dimensions: newDims,
    });
    console.log('~/.gbrain/config.json updated.');
  }

  console.log('');
  console.log(`Migration complete. Brain now uses ${newProviderName} (${newModel}, ${newDims} dims).`);
  console.log(`Verify: gbrain query "test"`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function getConfigValue(engine: BrainEngine, key: string): Promise<string | null> {
  try {
    if (engine instanceof PGLiteEngine) {
      const { rows } = await engine.db.query<{ value: string }>(
        `SELECT value FROM config WHERE key = $1`, [key]
      );
      return rows[0]?.value ?? null;
    } else if (engine instanceof PostgresEngine) {
      const rows = await engine.sql`SELECT value FROM config WHERE key = ${key}`;
      return (rows[0] as { value: string } | undefined)?.value ?? null;
    }
  } catch { /* table may not exist yet */ }
  return null;
}

async function setConfigValue(engine: BrainEngine, key: string, value: string): Promise<void> {
  if (engine instanceof PGLiteEngine) {
    await engine.db.query(
      `INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  } else if (engine instanceof PostgresEngine) {
    await engine.sql`
      INSERT INTO config (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }
}

async function execRawSQL(engine: BrainEngine, sql: string): Promise<void> {
  if (engine instanceof PGLiteEngine) {
    await engine.db.exec(sql);
  } else if (engine instanceof PostgresEngine) {
    await engine.sql.unsafe(sql);
  } else {
    throw new Error('Unsupported engine for raw SQL migration');
  }
}
