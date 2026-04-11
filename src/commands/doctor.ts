import type { BrainEngine } from '../core/engine.ts';
import * as db from '../core/db.ts';
import { LATEST_VERSION } from '../core/migrate.ts';

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

  // 6. Embedding config match
  try {
    const { getProvider } = await import('../core/embedding/index.ts');
    const provider = getProvider();
    let dbModel = await engine.getConfig('embedding_model');
    const dbDims = await engine.getConfig('embedding_dimensions');
    const currentModel = `${provider.name}:${provider.model}`;
    const currentDims = String(provider.dimensions);

    // Normalize legacy format: 'text-embedding-3-large' → 'openai:text-embedding-3-large'
    if (dbModel && !dbModel.includes(':')) dbModel = `openai:${dbModel}`;

    const modelMatch = dbModel === currentModel;
    const dimsMatch = dbDims === currentDims;

    if (modelMatch && dimsMatch) {
      checks.push({ name: 'embedding_config', status: 'ok', message: `${currentModel} @ ${currentDims}d` });
    } else {
      const parts: string[] = [];
      if (!modelMatch) parts.push(`model: ${dbModel} → ${currentModel}`);
      if (!dimsMatch) parts.push(`dimensions: ${dbDims} → ${currentDims}`);
      checks.push({
        name: 'embedding_config',
        status: 'warn',
        message: `Mismatch: ${parts.join(', ')}. Run gbrain init to migrate, then gbrain embed --all`,
      });
    }
  } catch {
    checks.push({ name: 'embedding_config', status: 'warn', message: 'Could not check embedding config' });
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
