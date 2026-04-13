import type { BrainEngine } from '../core/engine.ts';
import * as db from '../core/db.ts';
import { LATEST_VERSION } from '../core/migrate.ts';
import { loadConfig } from '../core/config.ts';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export async function runDoctor(engine: BrainEngine, args: string[]) {
  const jsonOutput = args.includes('--json');
  const checks: Check[] = [];

  // 1. Connection
  try {
    const stats = await engine.getStats();
    checks.push({ name: 'connection', status: 'ok', message: `Connected, ${stats.page_count} pages` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'connection', status: 'fail', message: msg });
    outputResults(checks, jsonOutput);
    return;
  }

  // 2. pgvector extension
  try {
    const sql = db.getConnection();
    const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    if (ext.length > 0) {
      checks.push({ name: 'pgvector', status: 'ok', message: 'Extension installed' });
    } else {
      checks.push({ name: 'pgvector', status: 'fail', message: 'Extension not found. Run: CREATE EXTENSION vector;' });
    }
  } catch {
    checks.push({ name: 'pgvector', status: 'warn', message: 'Could not check pgvector extension' });
  }

  // 3. RLS
  try {
    const sql = db.getConnection();
    const tables = await sql`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('pages','content_chunks','links','tags','raw_data',
                           'page_versions','timeline_entries','ingest_log','config','files')
    `;
    const noRls = tables.filter((t: any) => !t.rowsecurity);
    if (noRls.length === 0) {
      checks.push({ name: 'rls', status: 'ok', message: 'RLS enabled on all tables' });
    } else {
      const names = noRls.map((t: any) => t.tablename).join(', ');
      checks.push({ name: 'rls', status: 'warn', message: `RLS not enabled on: ${names}` });
    }
  } catch {
    checks.push({ name: 'rls', status: 'warn', message: 'Could not check RLS status' });
  }

  // 4. Schema version
  try {
    const version = await engine.getConfig('version');
    const v = parseInt(version || '0', 10);
    if (v >= LATEST_VERSION) {
      checks.push({ name: 'schema_version', status: 'ok', message: `Version ${v} (latest: ${LATEST_VERSION})` });
    } else {
      checks.push({ name: 'schema_version', status: 'warn', message: `Version ${v}, latest is ${LATEST_VERSION}. Run gbrain init to migrate.` });
    }
  } catch {
    checks.push({ name: 'schema_version', status: 'warn', message: 'Could not check schema version' });
  }

  // 5. Embedding health
  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      checks.push({ name: 'embeddings', status: 'ok', message: `${pct}% coverage, ${health.missing_embeddings} missing` });
    } else if (health.embed_coverage > 0) {
      checks.push({ name: 'embeddings', status: 'warn', message: `${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed refresh` });
    } else {
      checks.push({ name: 'embeddings', status: 'warn', message: 'No embeddings yet. Run: gbrain embed refresh' });
    }
  } catch {
    checks.push({ name: 'embeddings', status: 'warn', message: 'Could not check embedding health' });
  }

  // 6. API keys
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (hasOpenAI && hasAnthropic) {
    checks.push({ name: 'api_keys', status: 'ok', message: 'OPENAI_API_KEY and ANTHROPIC_API_KEY set' });
  } else if (hasOpenAI) {
    checks.push({ name: 'api_keys', status: 'warn', message: 'OPENAI_API_KEY set; ANTHROPIC_API_KEY missing (query expansion disabled)' });
  } else {
    checks.push({ name: 'api_keys', status: 'fail', message: 'OPENAI_API_KEY not set. Vector search and embedding will fail. Run: export OPENAI_API_KEY=sk-...' });
  }

  // 7. Embedding smoke test (only if OPENAI set)
  if (hasOpenAI) {
    try {
      const { embed } = await import('../core/embedding.ts');
      await embed('gbrain doctor smoke test');
      checks.push({ name: 'embedding_smoke', status: 'ok', message: 'OpenAI embeddings reachable' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      checks.push({ name: 'embedding_smoke', status: 'fail', message: `Smoke test failed: ${msg}. Check API key validity, quota, and network.` });
    }
  }

  // 8. Storage backend
  const config = loadConfig();
  const storageCfg = (config as unknown as { storage?: { backend?: string } } | null)?.storage;
  if (!storageCfg || !storageCfg.backend) {
    checks.push({ name: 'storage_backend', status: 'ok', message: 'No storage backend configured (files commands disabled)' });
  } else if (storageCfg.backend === 'local') {
    checks.push({ name: 'storage_backend', status: 'ok', message: 'Local storage backend' });
  } else {
    try {
      const { createStorage } = await import('../core/storage.ts');
      const storage = await createStorage(storageCfg as Parameters<typeof createStorage>[0]);
      await storage.list('');
      checks.push({ name: 'storage_backend', status: 'ok', message: `${storageCfg.backend} storage reachable` });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      checks.push({ name: 'storage_backend', status: 'fail', message: `${storageCfg.backend} storage unreachable: ${msg}` });
    }
  }

  // 9. HNSW index on content_chunks.embedding
  try {
    const sql = db.getConnection();
    const indexes = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'content_chunks'
    `;
    const hasHnsw = (indexes as { indexdef: string }[]).some(i => /USING\s+hnsw/i.test(i.indexdef));
    if (hasHnsw) {
      checks.push({ name: 'hnsw_index', status: 'ok', message: 'HNSW index present on content_chunks.embedding' });
    } else {
      checks.push({ name: 'hnsw_index', status: 'warn', message: 'HNSW index missing on content_chunks.embedding (vector search will be slow). Run gbrain init to rebuild schema.' });
    }
  } catch {
    checks.push({ name: 'hnsw_index', status: 'warn', message: 'Could not check HNSW index' });
  }

  outputResults(checks, jsonOutput);
}

function outputResults(checks: Check[], json: boolean) {
  if (json) {
    const hasFail = checks.some(c => c.status === 'fail');
    console.log(JSON.stringify({ status: hasFail ? 'unhealthy' : 'healthy', checks }));
    process.exit(hasFail ? 1 : 0);
    return;
  }

  console.log('\nGBrain Health Check');
  console.log('===================');
  for (const c of checks) {
    const icon = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
  }

  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  if (hasFail) {
    console.log('\nFailed checks found. Fix the issues above.');
  } else if (hasWarn) {
    console.log('\nAll checks OK (some warnings).');
  } else {
    console.log('\nAll checks passed.');
  }
  process.exit(hasFail ? 1 : 0);
}
