#!/usr/bin/env bun
/**
 * Build the pinned PGLite upgrade-replay fixture (refactor wave 1 EO3 / T-G2).
 *
 * Creates a file-backed PGLite brain with the code at HEAD (cold
 * `initSchema()` under the unit-test embedding shape, OpenAI/1536), writes a
 * small generic corpus (pages, chunks with deterministic stub embeddings,
 * links, tags, timeline, a fact and a take), then tars the data dir to
 * test/fixtures/goldens/pglite-upgrade-replay/brain.tar.gz next to a
 * MANIFEST.json (gbrain version, schema_version, PGLite version, build
 * command, row counts, data fingerprint).
 *
 * The fixture is a W0 golden: build it on master, commit it, and never
 * rebuild it inside a refactor commit — test/pglite-upgrade-replay.test.ts
 * opens it with the branch to prove existing brains survive the upgrade boot.
 *
 * Usage: bun scripts/build-pglite-upgrade-fixture.ts
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../test/helpers/legacy-embedding-config.ts';
import {
  UPGRADE_FIXTURE_BRAIN_DIR,
  UPGRADE_FIXTURE_DIR,
  UPGRADE_FIXTURE_MANIFEST,
  UPGRADE_FIXTURE_TARBALL,
  type UpgradeFixtureManifest,
  fixtureDataStats,
} from '../test/helpers/pglite-upgrade-fixture.ts';

const REPO = join(import.meta.dir, '..');
const BUILD_COMMAND = 'bun scripts/build-pglite-upgrade-fixture.ts';
/** Keep the committed binary small; fail loudly instead of committing a blob. */
const MAX_TARBALL_BYTES = 8 * 1024 * 1024;

function stubEmbedding(seed: number, dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = (((seed * 31 + i * 17) % 97) - 48) / 97;
  return v;
}

async function writeCorpus(engine: PGLiteEngine, dims: number): Promise<void> {
  const pages = [
    { slug: 'people/alice-example', type: 'person', title: 'Alice Example', body: 'Alice Example is an engineer at Acme Example who writes about storage engines.' },
    { slug: 'companies/acme-example', type: 'company', title: 'Acme Example', body: 'Acme Example builds developer tools. Alice Example leads the storage team.' },
    { slug: 'concepts/example-note', type: 'concept', title: 'Example Note', body: 'A generic note about schema migrations and upgrade safety.' },
  ] as const;
  let seed = 1;
  for (const p of pages) {
    await engine.putPage(p.slug, { type: p.type, title: p.title, compiled_truth: p.body, timeline: '' });
    await engine.upsertChunks(p.slug, [
      { chunk_index: 0, chunk_text: p.body, chunk_source: 'compiled_truth', embedding: stubEmbedding(seed++, dims), token_count: 16 },
      { chunk_index: 1, chunk_text: `${p.title} (second chunk)`, chunk_source: 'compiled_truth', embedding: stubEmbedding(seed++, dims), token_count: 4 },
    ]);
    await engine.addTag(p.slug, 'example');
  }
  await engine.addTag('people/alice-example', 'engineer');
  await engine.addLink('people/alice-example', 'companies/acme-example', 'works at', 'works_at'); // gbrain-allow-direct-insert: fixture corpus for a pinned test brain, not user data
  await engine.addLink('companies/acme-example', 'people/alice-example', 'team lead', 'mentions'); // gbrain-allow-direct-insert: fixture corpus for a pinned test brain, not user data
  await engine.addTimelineEntry('people/alice-example', { date: '2024-01-15', summary: 'Joined Acme Example', source: 'fixture' }); // gbrain-allow-direct-insert: fixture corpus for a pinned test brain, not user data
  await engine.addTimelineEntry('companies/acme-example', { date: '2023-06-01', summary: 'Founded', source: 'fixture' }); // gbrain-allow-direct-insert: fixture corpus for a pinned test brain, not user data
  await engine.insertFact( // gbrain-allow-direct-insert: fixture corpus for a pinned test brain, not user data
    {
      fact: 'Alice Example prefers boring technology.',
      kind: 'preference',
      entity_slug: 'people/alice-example',
      source: 'fixture',
      embedding: stubEmbedding(99, dims),
      embedding_model: LEGACY_EMBEDDING_CONFIG.embedding_model,
      valid_from: new Date('2024-02-01T00:00:00Z'),
    },
    { source_id: 'default' },
  );
  const alice = await engine.getPage('people/alice-example');
  if (!alice) throw new Error('fixture page missing after putPage');
  await engine.addTakesBatch([
    { page_id: alice.id, row_num: 1, claim: 'Upgrade boots must be idempotent.', kind: 'take', holder: 'people/alice-example', weight: 0.8, since_date: '2024-03-01' },
  ]);
}

/**
 * Size control: a fresh brain's first 16 MB WAL segment holds the whole schema
 * build (~2.4 MB compressed). Switch to a new segment and checkpoint so the
 * old one is no longer needed for crash recovery, and return the segment that
 * holds the redo point.
 */
async function retireWalHistory(engine: PGLiteEngine): Promise<string> {
  await engine.db.query('SELECT pg_switch_wal()');
  await engine.db.query('CHECKPOINT');
  const { rows } = await engine.db.query<{ redo_wal_file: string }>('SELECT redo_wal_file FROM pg_control_checkpoint()');
  return rows[0]!.redo_wal_file;
}

/** After a clean shutdown only the redo segment is referenced; recycled segments are not. */
function dropUnreferencedWalSegments(dataDir: string, keep: string): void {
  const walDir = join(dataDir, 'pg_wal');
  for (const name of readdirSync(walDir)) {
    if (/^[0-9A-F]{24}$/.test(name) && name !== keep) rmSync(join(walDir, name));
  }
}

export async function buildUpgradeFixture(): Promise<UpgradeFixtureManifest> {
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-fixture-'));
  const saved = { home: process.env.GBRAIN_HOME, snapshot: process.env.GBRAIN_PGLITE_SNAPSHOT, tz: process.env.TZ };
  const dataDir = join(scratch, UPGRADE_FIXTURE_BRAIN_DIR);
  const engine = new PGLiteEngine();
  try {
    process.env.GBRAIN_HOME = join(scratch, 'home');
    process.env.TZ = 'UTC';
    delete process.env.GBRAIN_PGLITE_SNAPSHOT;
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    await engine.connect({ database_path: dataDir });
    await engine.initSchema();
    await writeCorpus(engine, LEGACY_EMBEDDING_CONFIG.embedding_dimensions);
    const schemaVersion = Number(await engine.getConfig('version'));
    const data = await fixtureDataStats(engine);
    const keepWal = await retireWalHistory(engine);
    await engine.disconnect();
    dropUnreferencedWalSegments(dataDir, keepWal);

    const manifest: UpgradeFixtureManifest = {
      gbrain_version: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version,
      schema_version: schemaVersion,
      latest_migration_version: LATEST_VERSION,
      pglite_version: JSON.parse(readFileSync(join(REPO, 'node_modules/@electric-sql/pglite/package.json'), 'utf8')).version,
      embedding_model: LEGACY_EMBEDDING_CONFIG.embedding_model,
      embedding_dimensions: LEGACY_EMBEDDING_CONFIG.embedding_dimensions,
      build_command: BUILD_COMMAND,
      data,
    };

    mkdirSync(UPGRADE_FIXTURE_DIR, { recursive: true });
    const tmpTar = `${UPGRADE_FIXTURE_TARBALL}.tmp`;
    const tar = Bun.spawnSync(['tar', '-czf', tmpTar, '-C', scratch, UPGRADE_FIXTURE_BRAIN_DIR], { stderr: 'pipe' });
    if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
    const size = statSync(tmpTar).size;
    if (size > MAX_TARBALL_BYTES) {
      rmSync(tmpTar, { force: true });
      throw new Error(`fixture tarball is ${size} bytes (cap ${MAX_TARBALL_BYTES}); refusing to publish`);
    }
    Bun.spawnSync(['mv', tmpTar, UPGRADE_FIXTURE_TARBALL]);
    writeFileSync(UPGRADE_FIXTURE_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`[build-pglite-upgrade-fixture] wrote ${UPGRADE_FIXTURE_TARBALL} (${size} bytes), schema_version=${schemaVersion}`);
    return manifest;
  } finally {
    try { await engine.disconnect(); }
    finally {
      for (const [key, value] of [['GBRAIN_HOME', saved.home], ['GBRAIN_PGLITE_SNAPSHOT', saved.snapshot], ['TZ', saved.tz]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  try { await buildUpgradeFixture(); process.exit(0); }
  catch (err) {
    console.error(`[build-pglite-upgrade-fixture] ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}
