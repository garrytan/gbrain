/**
 * Refactor wave 1 EO3 / T-G2 — PGLite upgrade replay.
 *
 * Protects: every existing PGLite user's first boot after an upgrade. An
 * existing brain replays the (W2: regenerated) schema blob plus the
 * forward-reference bootstrap on every `initSchema()`; a forward reference
 * the old template lacked, a non-idempotent ALTER, or a changed
 * `CREATE OR REPLACE FUNCTION` body would wedge or silently mutate real
 * brains. E4 compares fresh installs only; this opens a brain BUILT BY MASTER.
 *
 * Fixture: test/fixtures/goldens/pglite-upgrade-replay/brain.tar.gz, a
 * file-backed PGLite data dir built by `bun scripts/build-pglite-upgrade-fixture.ts`
 * on master with a small generic corpus; MANIFEST.json records versions, row
 * counts and a data fingerprint. Never rebuild it in a refactor commit.
 *
 * Asserts, on the extracted brain (file-backed, so the GBRAIN_PGLITE_SNAPSHOT
 * fast path can never apply):
 *   - before boot the catalog equals the E4 fresh-install golden of the
 *     fixture's schema version (pglite-upgrade-replay/catalog-before-boot, a
 *     copy of catalog/pglite-engine-init-default at pin time), ordinals
 *     included (T-G13);
 *   - the upgrade boot succeeds and its catalog is pinned as its own golden
 *     (pglite-upgrade-replay/catalog-after-boot). MASTER FINDING: it is NOT
 *     byte-identical to a fresh install. `initSchema()` replays the schema
 *     blob's `CREATE OR REPLACE FUNCTION` bodies on every boot, and on a fresh
 *     install later migrations had re-created three trigger functions from
 *     differently indented template literals, so an existing brain's
 *     `prosrc` differs from a fresh brain's in whitespace only. The test pins
 *     that exact function list and proves the bodies are whitespace-equivalent;
 *     every other catalog object must match the live fresh install;
 *   - corpus row counts and fingerprint match the manifest at every phase;
 *   - the repeat boot after a restart is a no-op: no migrations applied,
 *     schema version and catalog unchanged, OIDs of tables, indexes,
 *     sequences, views, constraints and functions unchanged. The blob's
 *     `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` pairs recreate triggers on
 *     every boot on master; that recreated-trigger list is pinned as a golden
 *     (pglite-upgrade-replay/repeat-boot-recreated-objects) so the generated
 *     blob cannot start dropping and recreating anything else.
 *
 * Regenerate the two goldens deliberately:
 *   GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/pglite-upgrade-replay.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { GOLDENS_DIR, defineNormalizer, expectGolden } from './helpers/golden.ts';
import {
  CATALOG_CONFIGS,
  capturePgliteFreshInstall,
  describeCatalogGoldenDrift,
  expectCatalogGolden,
  pgliteCatalogQuery,
  pgliteFunctionBodies,
  withCatalogConfig,
} from './helpers/schema-catalog.ts';
import { type CatalogSnapshot, diffCatalogSnapshots, formatCatalogDiffForFailure, snapshotCatalog } from './helpers/schema-diff.ts';
import {
  UPGRADE_FIXTURE_BRAIN_DIR,
  UPGRADE_FIXTURE_MANIFEST,
  UPGRADE_FIXTURE_TARBALL,
  type FixtureDataStats,
  type UpgradeFixtureManifest,
  fixtureDataStats,
} from './helpers/pglite-upgrade-fixture.ts';

/**
 * The E4 fresh-install catalog at the fixture's own schema version, copied from
 * `catalog/pglite-engine-init-default` when the fixture was pinned. That golden
 * moves with every schema migration; the pinned brain does not.
 */
const FRESH_GOLDEN = 'pglite-upgrade-replay/catalog-before-boot';
/**
 * Master finding (see header): functions whose body text on an upgraded brain
 * differs from a fresh install by whitespace only.
 */
const WHITESPACE_ONLY_FUNCTION_DRIFT = [
  'bump_page_generation_clock_fn()',
  'bump_page_generation_fn()',
  'update_page_search_vector()',
];
/** The OID-churn list is already sorted identity keys; nothing volatile to scrub. */
const recreatedObjectsNormalizer = defineNormalizer<string[]>('oid-churn-keys-v1', (keys) => [...keys].sort());
const collapseWhitespace = (s: string) => s.replace(/\s+/g, ' ').trim();

/** OIDs of objects a no-op boot must not drop and recreate, keyed by identity. */
const STABLE_OID_SQL = `
  SELECT 'rel:' || c.relkind::text || ':' || c.relname::text AS key, c.oid::bigint::text AS oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'i', 'S', 'v', 'm')
  UNION ALL
  SELECT 'con:' || COALESCE(t.relname::text, '') || '.' || con.conname::text, con.oid::bigint::text
    FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
    LEFT JOIN pg_class t ON t.oid = con.conrelid
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'fn:' || p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.oid::bigint::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'trg:' || t.relname::text || '.' || tg.tgname::text, tg.oid::bigint::text
    FROM pg_trigger tg JOIN pg_class t ON t.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND NOT tg.tgisinternal
  ORDER BY 1`;

interface Phase {
  catalog: CatalogSnapshot;
  functionBodies: Map<string, string>;
  data: FixtureDataStats;
  version: number;
  oids: Map<string, string>;
  stderr: string;
}

let engine: PGLiteEngine;
let workDir: string;
let manifest: UpgradeFixtureManifest;
let snapshotLoaded: boolean;
const phases: Partial<Record<'beforeBoot' | 'firstBoot' | 'repeatBoot', Phase>> = {};

async function capturePhase(stderr: string): Promise<Phase> {
  const { rows } = await engine.db.query<{ key: string; oid: string }>(STABLE_OID_SQL);
  return {
    catalog: await snapshotCatalog(pgliteCatalogQuery(engine)),
    functionBodies: await pgliteFunctionBodies(engine),
    data: await fixtureDataStats(engine),
    version: Number(await engine.getConfig('version')),
    oids: new Map(rows.map((r) => [r.key, r.oid])),
    stderr,
  };
}

/** Run fn while collecting what it writes to stderr (initSchema reports applied migrations there). */
async function collectingStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (original as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

function requirePhase(name: keyof typeof phases): Phase {
  const phase = phases[name];
  if (!phase) throw new Error(`phase ${name} did not complete (see beforeAll failure)`);
  return phase;
}

function assertSameCatalog(label: string, expected: CatalogSnapshot, actual: CatalogSnapshot): void {
  const diff = diffCatalogSnapshots(expected, actual, { compareOrdinals: true });
  if (diff.length > 0) throw new Error(`${label}:\n${formatCatalogDiffForFailure(diff)}`);
  expect(diff).toEqual([]);
}

beforeAll(async () => {
  manifest = JSON.parse(readFileSync(UPGRADE_FIXTURE_MANIFEST, 'utf8'));
  workDir = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-replay-'));
  const tar = Bun.spawnSync(['tar', '-xzf', UPGRADE_FIXTURE_TARBALL, '-C', workDir], { stderr: 'pipe' });
  if (tar.exitCode !== 0) throw new Error(`extracting ${UPGRADE_FIXTURE_TARBALL} failed: ${tar.stderr.toString()}`);
  engine = new PGLiteEngine();
  await engine.connect({ database_path: join(workDir, UPGRADE_FIXTURE_BRAIN_DIR) });
  snapshotLoaded = (engine as unknown as { _snapshotLoaded: boolean })._snapshotLoaded;
  phases.beforeBoot = await capturePhase('');
  const firstStderr = await collectingStderr(() => engine.initSchema());
  phases.firstBoot = await capturePhase(firstStderr);
  await engine.reconnect();
  const repeatStderr = await collectingStderr(() => engine.initSchema());
  phases.repeatBoot = await capturePhase(repeatStderr);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('PGLite upgrade replay (EO3)', () => {
  test('fixture manifest describes a brain built by this schema generation', () => {
    expect(manifest.embedding_dimensions).toBe(CATALOG_CONFIGS[0].embeddingDimensions);
    expect(manifest.embedding_model).toBe(CATALOG_CONFIGS[0].embeddingModel);
    expect(manifest.schema_version).toBeLessThanOrEqual(LATEST_VERSION);
    expect(snapshotLoaded).toBe(false);
  });

  test('before boot, the pinned brain matches the E4 fresh-install golden', () => {
    expect(existsSync(join(GOLDENS_DIR, 'pglite-upgrade-replay/catalog-before-boot.json'))).toBe(true);
    expect(requirePhase('beforeBoot').version).toBe(manifest.schema_version);
    // The fresh-install golden of the schema generation that built the fixture
    // (a copy of catalog/pglite-engine-init-default at that version); the live
    // fresh-install golden moves with every later schema change.
    expect(describeCatalogGoldenDrift('pglite-upgrade-replay/catalog-before-boot', requirePhase('beforeBoot').catalog)).toBe('');
  });

  test('upgrade boot succeeds; its catalog is pinned and differs from a fresh install only by function whitespace', async () => {
    const first = requirePhase('firstBoot');
    expect(first.version).toBe(LATEST_VERSION);
    expectCatalogGolden('pglite-upgrade-replay/catalog-after-boot', first.catalog);

    const fresh = await withCatalogConfig(CATALOG_CONFIGS[0], capturePgliteFreshInstall);
    const diff = diffCatalogSnapshots(fresh.catalog, first.catalog, { compareOrdinals: true });
    const unexplained = diff.filter((d) => !(d.section === 'functions' && d.kind === 'changed'));
    if (unexplained.length > 0) throw new Error(`upgraded brain differs from a fresh install:\n${formatCatalogDiffForFailure(unexplained)}`);
    expect(diff.map((d) => d.key)).toEqual(WHITESPACE_ONLY_FUNCTION_DRIFT);
    for (const d of diff) {
      const { bodySha256: _a, ...freshRest } = d.expected as Record<string, unknown>;
      const { bodySha256: _b, ...upgradedRest } = d.actual as Record<string, unknown>;
      expect(upgradedRest).toEqual(freshRest);
      expect(collapseWhitespace(first.functionBodies.get(d.key)!)).toBe(collapseWhitespace(fresh.functionBodies.get(d.key)!));
    }
  }, 60_000);

  test('corpus rows survive every boot unchanged', () => {
    for (const name of ['beforeBoot', 'firstBoot', 'repeatBoot'] as const) {
      expect({ phase: name, ...requirePhase(name).data }).toEqual({ phase: name, ...manifest.data });
    }
  });

  test('repeat boot after restart is a no-op', () => {
    const first = requirePhase('firstBoot');
    const repeat = requirePhase('repeatBoot');
    expect(repeat.stderr).not.toContain('migration(s) applied');
    expect(repeat.version).toBe(first.version);
    assertSameCatalog('repeat boot changed the catalog', first.catalog, repeat.catalog);
    expect([...repeat.functionBodies]).toEqual([...first.functionBodies]);
    const added = [...repeat.oids.keys()].filter((key) => !first.oids.has(key));
    const recreated = [...first.oids].filter(([key, oid]) => repeat.oids.get(key) !== oid).map(([key]) => key);
    expect(added).toEqual([]);
    expect(recreated.filter((key) => !key.startsWith('trg:'))).toEqual([]);
    expect(first.oids.size).toBeGreaterThan(300);
    expectGolden('pglite-upgrade-replay/repeat-boot-recreated-objects', recreated, recreatedObjectsNormalizer);
  });
});
