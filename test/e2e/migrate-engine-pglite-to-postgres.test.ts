/**
 * D2 — whole-brain `runMigrateEngine` journey: real PGLite brain → real Postgres.
 *
 * Exercises the production engine-transfer path end to end against the live
 * DATABASE_URL: multi-source pages (including a same-slug collision across
 * sources), jsonb frontmatter, chunks with real embedding vectors, a facts
 * chain with a superseded row, tags / timeline / raw data / links, and DB-plane
 * config rows — then asserts the Postgres side row-for-row, that the file-plane
 * config flipped to postgres, and that the resume manifest was cleared.
 *
 * Failure arm runs FIRST (before the config flips) as a spawned child process,
 * because `runMigrateEngine` reaches `process.exit(1)`-adjacent paths and a
 * target-connect failure throws out of the CLI: the child must die, not the
 * test runner. It asserts non-zero exit, config NOT flipped, PGLite intact.
 *
 * Environment notes (why the env juggling below exists):
 *  - `loadConfig()` infers `engine: 'postgres'` whenever a DATABASE_URL-style
 *    env var is exported, which would trip runMigrateEngine's "Already using
 *    postgres engine" `process.exit(1)`. helpers.ts captures DATABASE_URL at
 *    module load, so this file deletes it from process.env for the duration
 *    (restored in afterAll) and passes the target URL explicitly via --url.
 *  - The live Postgres schema sizes content_chunks.embedding at vector(1536)
 *    while an unconfigured gateway defaults PGLite to 1280d. The gateway is
 *    configured at 1536 (and the fixture config.json pins it) so the seeded
 *    vectors land on the target without a dims mismatch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runMigrateEngine } from '../../src/commands/migrate-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';

const describePg = hasDatabase() ? describe : describe.skip;

// Captured at module load, before beforeAll deletes it from process.env.
const DB_URL = process.env.DATABASE_URL ?? '';
const REPO_ROOT = resolve(import.meta.dir, '../..');
const EMBED_DIMS = 1536;

/** Deterministic 1536-d vector; v[0] = seed/8 is float4-exact for the
 * round-trip spot check on the Postgres side. */
function vec(seed: number): Float32Array {
  const v = new Float32Array(EMBED_DIMS);
  for (let i = 0; i < EMBED_DIMS; i++) v[i] = ((seed * 31 + i) % 97) / 97;
  v[0] = seed / 8;
  return v;
}

interface FixtureCounts {
  pages: number;
  chunks: number;
  chunks_embedded: number;
  facts: number;
  sources: number;
  tags: number;
  timeline_entries: number;
  raw_data: number;
  links: number;
}

async function tableCounts(engine: BrainEngine): Promise<FixtureCounts> {
  const one = async (sql: string): Promise<number> => {
    const rows = await engine.executeRaw<{ n: number | string }>(sql);
    return Number(rows[0]?.n ?? -1);
  };
  return {
    pages: await one('SELECT count(*)::int AS n FROM pages'),
    chunks: await one('SELECT count(*)::int AS n FROM content_chunks'),
    chunks_embedded: await one('SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL'),
    facts: await one('SELECT count(*)::int AS n FROM facts'),
    sources: await one('SELECT count(*)::int AS n FROM sources'),
    tags: await one('SELECT count(*)::int AS n FROM tags'),
    timeline_entries: await one('SELECT count(*)::int AS n FROM timeline_entries'),
    raw_data: await one('SELECT count(*)::int AS n FROM raw_data'),
    links: await one('SELECT count(*)::int AS n FROM links'),
  };
}

describePg('migrate-engine whole-brain PGLite to Postgres (D2)', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'gbrain-d2-'));
  const gbrainDir = join(tmpBase, '.gbrain');
  const configFile = join(gbrainDir, 'config.json');
  const manifestFile = join(gbrainDir, 'migrate-manifest.json');
  const pgliteDir = join(gbrainDir, 'brain.pglite');

  const origEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    GBRAIN_DATABASE_URL: process.env.GBRAIN_DATABASE_URL,
    GBRAIN_HOME: process.env.GBRAIN_HOME,
  };

  let source: PGLiteEngine | null = null;
  let seeded: FixtureCounts;
  let factId1 = 0; // superseded by factId2
  let factId2 = 0;
  let factMaxId = 0;

  beforeAll(async () => {
    if (!DB_URL) throw new Error('DATABASE_URL must be set for this e2e file');

    // Postgres clean slate FIRST (helpers captured DATABASE_URL at import).
    await setupDB();

    // Pin embedding sizing to the live Postgres schema (vector(1536)) so the
    // fresh PGLite brain sizes its columns identically.
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: EMBED_DIMS, env: {} });

    // Isolated gbrain home with a real pglite file config — the SOURCE brain.
    mkdirSync(gbrainDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify({
      engine: 'pglite',
      database_path: pgliteDir,
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: EMBED_DIMS,
    }, null, 2));
    process.env.GBRAIN_HOME = tmpBase;
    // See header: an exported DATABASE_URL makes loadConfig() infer postgres,
    // which would hit runMigrateEngine's "Already using postgres" exit(1).
    delete process.env.DATABASE_URL;
    delete process.env.GBRAIN_DATABASE_URL;

    // ---- Seed the PGLite source brain ----
    source = new PGLiteEngine();
    await source.connect({ engine: 'pglite', database_path: pgliteDir });
    await source.initSchema();

    await source.executeRaw(`INSERT INTO sources (id, name, config)
      VALUES ('alpha', 'Source Alpha', '{"federated":true,"note":"a"}'::jsonb),
             ('beta',  'Source Beta',  '{}'::jsonb)`);

    // alpha: person page with jsonb frontmatter, 2 embedded chunks, tag,
    // timeline entry, raw data, and an outgoing link.
    await source.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: 'Alice founded acme-example.',
      frontmatter: { tags: ['founder'], score: 2, nested: { deep: true } },
    }, { sourceId: 'alpha' });
    await source.putPage('companies/acme-example', {
      type: 'company',
      title: 'Acme Example',
      compiled_truth: 'Acme makes widgets.',
    }, { sourceId: 'alpha' });
    await source.putPage('notes/plain', {
      type: 'note',
      title: 'Plain note',
      compiled_truth: 'No chunks here.',
    }, { sourceId: 'alpha' });
    // beta: same slug as the alpha person page — multi-source collision.
    await source.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice (beta view)',
      compiled_truth: 'Beta-source view of Alice.',
      frontmatter: { origin: 'beta' },
    }, { sourceId: 'beta' });
    await source.putPage('notes/beta-only', {
      type: 'note',
      title: 'Beta only',
      compiled_truth: 'Beta note with an unembedded chunk.',
    }, { sourceId: 'beta' });
    await source.putPage('index', {
      type: 'note',
      title: 'Index',
      compiled_truth: 'Default-source landing page.',
    }, { sourceId: 'default' });

    await source.upsertChunks('people/alice-example', [
      { chunk_index: 0, chunk_text: 'Alice founded acme-example.', chunk_source: 'compiled_truth', embedding: vec(1), model: 'test-model', token_count: 6 },
      { chunk_index: 1, chunk_text: 'She prefers espresso.', chunk_source: 'compiled_truth', embedding: vec(2), model: 'test-model', token_count: 4 },
    ], { sourceId: 'alpha' });
    await source.upsertChunks('companies/acme-example', [
      { chunk_index: 0, chunk_text: 'Acme makes widgets.', chunk_source: 'compiled_truth', embedding: vec(3), model: 'test-model', token_count: 4 },
    ], { sourceId: 'alpha' });
    await source.upsertChunks('people/alice-example', [
      { chunk_index: 0, chunk_text: 'Beta-source view of Alice.', chunk_source: 'compiled_truth', embedding: vec(4), model: 'test-model', token_count: 5 },
    ], { sourceId: 'beta' });
    await source.upsertChunks('notes/beta-only', [
      { chunk_index: 0, chunk_text: 'Beta note with an unembedded chunk.', chunk_source: 'compiled_truth' },
    ], { sourceId: 'beta' });

    await source.addTag('people/alice-example', 'person', { sourceId: 'alpha' });
    await source.addTimelineEntry('people/alice-example', {
      date: '2026-01-15', source: 'meeting', summary: 'Kickoff', detail: 'Discussed roadmap',
    }, { sourceId: 'alpha' });
    await source.putRawData('people/alice-example', 'crm', { stage: 'seed' }, { sourceId: 'alpha' });
    await source.addLink('people/alice-example', 'companies/acme-example', 'founder of', 'manual',
      undefined, undefined, undefined, { fromSourceId: 'alpha', toSourceId: 'alpha' });

    // Facts chain: f1 superseded by f2, plus a standalone f3 on another source.
    const f1 = await source.insertFact(
      { fact: 'User prefers dark roast coffee', source: 'cli:test-session', kind: 'preference' },
      { source_id: 'default' },
    );
    const f2 = await source.insertFact(
      { fact: 'User prefers light roast coffee', source: 'cli:test-session', kind: 'preference' },
      { source_id: 'default', supersedeId: f1.id },
    );
    expect(f2.status).toBe('superseded');
    const f3 = await source.insertFact(
      { fact: 'Acme raised a seed round', source: 'cli:test-session', entity_slug: 'companies/acme-example' },
      { source_id: 'alpha' },
    );
    factId1 = f1.id;
    factId2 = f2.id;
    factMaxId = Math.max(f1.id, f2.id, f3.id);

    // DB-plane config rows that MUST follow the data to the target.
    await source.setConfig('sync.repo_path', '/tmp/example-repo');
    await source.setConfig('search.mode', 'balanced');

    seeded = await tableCounts(source);
    expect(seeded.pages).toBe(6);
    expect(seeded.chunks).toBe(5);
    expect(seeded.chunks_embedded).toBe(4);
    expect(seeded.facts).toBe(3);
    expect(seeded.sources).toBe(3); // default + alpha + beta
    expect(seeded.links).toBe(1);

    // Release the PGLite file lock so the failure-arm child can open the brain.
    await source.disconnect();
    source = null;
  }, 150_000);

  afterAll(async () => {
    if (source) await source.disconnect().catch(() => {});
    await teardownDB();
    resetGateway();
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test('failure arm (child process): invalid target URL exits non-zero, config stays pglite, no manifest', async () => {
    const badUrl = 'postgresql://postgres@localhost:5432/gbrain_d2_no_such_db';
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    delete childEnv.DATABASE_URL; // see header — would flip loadConfig to postgres
    delete childEnv.GBRAIN_DATABASE_URL;
    childEnv.GBRAIN_HOME = tmpBase;

    const proc = Bun.spawn({
      cmd: [process.execPath, 'src/cli.ts', 'migrate', '--to', 'supabase', '--url', badUrl],
      cwd: REPO_ROOT,
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode === 0) {
      console.error(`child unexpectedly succeeded\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    expect(exitCode).not.toBe(0);

    // The file-plane config did NOT flip.
    const cfg = JSON.parse(readFileSync(configFile, 'utf-8'));
    expect(cfg.engine).toBe('pglite');
    expect(cfg.database_url).toBeUndefined();
    // No resume manifest was left behind (failure happened before any copy).
    expect(existsSync(manifestFile)).toBe(false);
  }, 120_000);

  test('happy arm: runMigrateEngine copies the whole brain, flips config, clears the manifest', async () => {
    // Reconnect the source and prove the failed arm left the PGLite brain intact.
    source = new PGLiteEngine();
    await source.connect({ engine: 'pglite', database_path: pgliteDir });
    expect(await tableCounts(source)).toEqual(seeded);

    // Real argv contract: `gbrain migrate --to supabase --url <url>`.
    await runMigrateEngine(source, ['--to', 'supabase', '--url', DB_URL]);
    await source.disconnect();
    source = null;

    // Per-table row counts on the POSTGRES side match the seeded PGLite counts.
    const target = getEngine();
    expect(await tableCounts(target)).toEqual(seeded);

    // Local config flipped to the postgres engine, preserving non-engine keys.
    const cfg = JSON.parse(readFileSync(configFile, 'utf-8'));
    expect(cfg.engine).toBe('postgres');
    expect(cfg.database_url).toBe(DB_URL);
    expect(cfg.database_path).toBeUndefined();
    expect(cfg.embedding_dimensions).toBe(EMBED_DIMS); // pre-existing file keys preserved

    // Migration manifest cleared on a clean run.
    expect(existsSync(manifestFile)).toBe(false);
  }, 150_000);

  test('jsonb survives as objects (never double-encoded strings)', async () => {
    const target = getEngine();

    const fm = await target.executeRaw<{ t: string; deep: string }>(`
      SELECT jsonb_typeof(frontmatter) AS t, frontmatter->'nested'->>'deep' AS deep
        FROM pages WHERE slug = 'people/alice-example' AND source_id = 'alpha'`);
    expect(fm[0]?.t).toBe('object');
    expect(fm[0]?.deep).toBe('true');

    const betaFm = await target.executeRaw<{ t: string; origin: string }>(`
      SELECT jsonb_typeof(frontmatter) AS t, frontmatter->>'origin' AS origin
        FROM pages WHERE slug = 'people/alice-example' AND source_id = 'beta'`);
    expect(betaFm[0]?.t).toBe('object');
    expect(betaFm[0]?.origin).toBe('beta');

    const srcCfg = await target.executeRaw<{ t: string; federated: string }>(`
      SELECT jsonb_typeof(config) AS t, config->>'federated' AS federated
        FROM sources WHERE id = 'alpha'`);
    expect(srcCfg[0]?.t).toBe('object');
    expect(srcCfg[0]?.federated).toBe('true');
  });

  test('embedding vectors survive with the right dims and values', async () => {
    const target = getEngine();

    const dims = await target.executeRaw<{ d: number; n: number | string }>(`
      SELECT vector_dims(embedding)::int AS d, count(*)::int AS n
        FROM content_chunks WHERE embedding IS NOT NULL GROUP BY 1`);
    expect(dims).toHaveLength(1);
    expect(Number(dims[0].d)).toBe(EMBED_DIMS);
    expect(Number(dims[0].n)).toBe(seeded.chunks_embedded);

    // Float4-exact first component of the alpha person page's chunk 0 (seed 1 → 0.125).
    const spot = await target.executeRaw<{ e: string }>(`
      SELECT c.embedding::text AS e
        FROM content_chunks c JOIN pages p ON p.id = c.page_id
       WHERE p.slug = 'people/alice-example' AND p.source_id = 'alpha' AND c.chunk_index = 0`);
    expect(spot[0]?.e.startsWith('[0.125,')).toBe(true);

    // The deliberately unembedded chunk stayed NULL.
    const nulls = await target.executeRaw<{ n: number | string }>(`
      SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NULL`);
    expect(Number(nulls[0].n)).toBe(seeded.chunks - seeded.chunks_embedded);
  });

  test('facts chain survives verbatim and the id sequence does not collide', async () => {
    const target = getEngine();

    const rows = await target.executeRaw<{
      id: number | string; fact: string; source_id: string;
      superseded_by: number | string | null; expired: boolean;
    }>(`SELECT id, fact, source_id, superseded_by, (expired_at IS NOT NULL) AS expired
          FROM facts ORDER BY id`);
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map(r => [Number(r.id), r]));

    const old = byId.get(factId1)!;
    expect(old.fact).toBe('User prefers dark roast coffee');
    expect(Number(old.superseded_by)).toBe(factId2);
    expect(old.expired).toBe(true);

    const current = byId.get(factId2)!;
    expect(current.fact).toBe('User prefers light roast coffee');
    expect(current.superseded_by).toBeNull();
    expect(current.expired).toBe(false);

    const acme = rows.find(r => r.fact === 'Acme raised a seed round');
    expect(acme?.source_id).toBe('alpha');

    // BIGSERIAL was bumped past MAX(id): a fresh insert must not collide.
    const fresh = await target.insertFact(
      { fact: 'Post-migration fact lands cleanly', source: 'cli:test-session' },
      { source_id: 'default' },
    );
    expect(fresh.status).toBe('inserted');
    expect(fresh.id).toBeGreaterThan(factMaxId);
  });

  test('DB-plane config rows migrated; engine-local keys did not', async () => {
    const target = getEngine();
    const get = async (key: string): Promise<string | null> => {
      const rows = await target.executeRaw<{ value: string }>(
        'SELECT value FROM config WHERE key = $1', [key]);
      return rows[0]?.value ?? null;
    };
    expect(await get('sync.repo_path')).toBe('/tmp/example-repo');
    expect(await get('search.mode')).toBe('balanced');
    // Denylisted engine-identity row was NOT overwritten with the source's.
    expect(await get('engine')).not.toBe('pglite');
  });
});
