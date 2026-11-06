/**
 * GBRA-283 Wave B1 back-compat: a brain built by an earlier release (the pinned PGLite upgrade fixture, see
 * test/pglite-upgrade-replay.test.ts) boots the same way through the CLI's connect path and through openEngine, and
 * openEngine changes nothing an existing brain records: data, schema version, catalog and embedding identity.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { openEngine } from '../src/core/engine-open.ts';
import { readStoredEmbeddingIdentity } from '../src/core/stored-embedding-identity.ts';
import { pgliteCatalogQuery } from './helpers/schema-catalog.ts';
import { diffCatalogSnapshots, snapshotCatalog } from './helpers/schema-diff.ts';
import { UPGRADE_FIXTURE_BRAIN_DIR, UPGRADE_FIXTURE_MANIFEST, UPGRADE_FIXTURE_TARBALL, fixtureDataStats, type UpgradeFixtureManifest } from './helpers/pglite-upgrade-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const scratch = mkdtempSync(join(tmpdir(), 'gbrain-engine-open-upgrade-'));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
const manifest = JSON.parse(readFileSync(UPGRADE_FIXTURE_MANIFEST, 'utf8')) as UpgradeFixtureManifest;

function extract(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const tar = Bun.spawnSync(['tar', '-xzf', UPGRADE_FIXTURE_TARBALL, '-C', dir], { stderr: 'pipe' });
  if (tar.exitCode !== 0) throw new Error(`extracting ${UPGRADE_FIXTURE_TARBALL} failed: ${tar.stderr.toString()}`);
  return join(dir, UPGRADE_FIXTURE_BRAIN_DIR);
}
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory())
    .map(entry => relative(root, join(entry.parentPath, entry.name))).sort();
}
async function boot(engine: PGLiteEngine) {
  await engine.initSchema();
  return {
    version: Number(await engine.getConfig('version')),
    catalog: await snapshotCatalog(pgliteCatalogQuery(engine)),
    data: await fixtureDataStats(engine),
    embedding: await readStoredEmbeddingIdentity(engine),
  };
}

describe('a brain built by an earlier release', () => {
  let cli: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: extract('cli') });
    try { cli = await boot(engine); } finally { await engine.disconnect(); }
  }, 240_000);

  test('boots through openEngine exactly as through the CLI connect path, and records nothing under HOME or GBRAIN_HOME', async () => {
    const home = join(scratch, 'canary-home'), gbrainHome = join(scratch, 'canary-gbrain-home');
    mkdirSync(home, { recursive: true }); mkdirSync(gbrainHome, { recursive: true });
    await withEnv({ HOME: home, GBRAIN_HOME: gbrainHome }, async () => {
      const engine = await openEngine({ embedded_core: true, engine: 'pglite', database: { path: extract('embedded') }, host: { id: randomUUID() } }) as PGLiteEngine;
      try {
        const embedded = await boot(engine);
        expect(embedded.version).toBe(cli.version);
        expect(diffCatalogSnapshots(cli.catalog, embedded.catalog)).toEqual([]);
        expect(embedded.data).toEqual(manifest.data);
        expect(cli.data).toEqual(manifest.data);
        expect(embedded.embedding).toEqual({ model: manifest.embedding_model, dimensions: manifest.embedding_dimensions });
        expect(cli.embedding).toEqual(embedded.embedding);
      } finally {
        await engine.disconnect();
      }
    });
    expect(filesUnder(home)).toEqual([]);
    expect(filesUnder(gbrainHome)).toEqual([]);
  }, 240_000);

  test('openEngine with the recorded embedding identity opens it; another identity refuses and changes nothing', async () => {
    const path = extract('identity');
    const same = await openEngine({ embedded_core: true, engine: 'pglite', database: { path }, host: { id: randomUUID() },
      embedding: { model: manifest.embedding_model, dimensions: manifest.embedding_dimensions } }) as PGLiteEngine;
    try { expect((await boot(same)).data).toEqual(manifest.data); } finally { await same.disconnect(); }
    const other = await openEngine({ embedded_core: true, engine: 'pglite', database: { path }, host: { id: randomUUID() },
      embedding: { model: 'voyage:voyage-4-lite', dimensions: 512 } }) as PGLiteEngine;
    try {
      const refusal = await other.initSchema().then(() => null, (error: unknown) => (error as { code?: string }).code);
      expect(refusal).toBe('engine_embedding_mismatch');
      expect(await readStoredEmbeddingIdentity(other)).toEqual({ model: manifest.embedding_model, dimensions: manifest.embedding_dimensions });
      expect(await fixtureDataStats(other)).toEqual(manifest.data);
    } finally {
      await other.disconnect();
    }
  }, 240_000);
});
