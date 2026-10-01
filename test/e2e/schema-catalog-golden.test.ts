/**
 * Refactor wave 1 E4 / EO12 / T-G13 — Postgres catalog goldens (E2E).
 *
 * Pins the full Postgres schema end state captured on master (columns incl.
 * ordinal position, defaults, indexes, constraints incl. CHECK text,
 * triggers, function signature + body hash, views, policies, grants, RLS
 * flags, sequences, extensions) so W2/W3 must reproduce it byte for byte.
 *
 * Init paths, each on a FRESH throwaway database per capture (so configs and
 * runs never bleed into each other):
 *   - engine init: `PostgresEngine.connect` + `initSchema()` (bootstrap +
 *     policy-applied SCHEMA_SQL + all migrations), at the three
 *     CATALOG_CONFIGS (default, 4096 dims, portuguese FTS).
 *   - `db.initSchema()` (src/core/db.ts): forward-reference bootstrap + RAW
 *     SCHEMA_SQL, no migration chain. It applies neither the embedding-dims
 *     rewrite nor the FTS/index policies, so its end state is
 *     config-independent on master: one golden, plus an assertion that the
 *     other two configs produce the identical catalog.
 *   - optional PgBouncer arm (GBRAIN_PGBOUNCER_URL + GBRAIN_PGBOUNCER_DIRECT_URL):
 *     engine init through the transaction-mode pooler reaches the same
 *     catalog as direct Postgres.
 * T-G13: the cross-engine PG <-> PGLite column comparison stays name-based
 * (the existing diffSnapshots contract); ordinals are pinned per engine by
 * the goldens only.
 *
 * Every golden capture runs twice (`expectNormalizerStable`), proving the
 * `schema-catalog-lines-v1` normalizer; the connecting role is placeholdered.
 * Server-version caveat: pg_get_*def text is rendered by the server, so the
 * goldens assume the CI image (pgvector/pgvector:pg16); extension VERSIONS
 * are deliberately not captured (the pg16 tag floats pgvector minors).
 *
 * Regenerate deliberately:
 *   GBRAIN_TEST_UPDATE_GOLDENS=1 DATABASE_URL=... bun test test/e2e/schema-catalog-golden.test.ts
 */

import { describe, test, expect } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { expectNormalizerStable } from '../helpers/golden.ts';
import {
  CATALOG_CONFIGS,
  type CatalogConfig,
  capturePgliteEngineCatalog,
  catalogGoldenNormalizer,
  expectCatalogGolden,
  postgresCatalogQuery,
  withCatalogConfig,
} from '../helpers/schema-catalog.ts';
import {
  type CatalogSnapshot,
  type SchemaSnapshot,
  diffCatalogSnapshots,
  diffSnapshots,
  formatCatalogDiffForFailure,
  formatDiffForFailure,
  isCleanDiff,
  snapshotCatalog,
} from '../helpers/schema-diff.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const POOLED_URL = process.env.GBRAIN_PGBOUNCER_URL;
const POOLED_DIRECT_URL = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const skipPooled = !POOLED_URL || !POOLED_DIRECT_URL;

if (skip) console.log('Skipping E2E schema catalog goldens (DATABASE_URL not set)');

const CAPTURE_TIMEOUT = 240_000;
/** Same allowlist as test/e2e/schema-drift.test.ts (Postgres-only by design). */
const PG_ONLY_TABLES = ['file_migration_ledger'];

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Create a throwaway database on `adminUrl`'s server, run fn, drop it. */
async function withFreshDatabase<T>(adminUrl: string, fn: (name: string) => Promise<T>): Promise<T> {
  assertSafeE2eDatabaseUrl(adminUrl);
  const name = `gbrain_test_catalog_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    try {
      return await fn(name);
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function captureEngineInit(adminUrl = DATABASE_URL!, connectUrl = DATABASE_URL!): Promise<CatalogSnapshot> {
  return withFreshDatabase(adminUrl, async (name) => {
    const engine = new PostgresEngine();
    try {
      await engine.connect({ database_url: withDatabase(connectUrl, name), poolSize: 2 });
      await engine.initSchema();
      return await snapshotCatalog(postgresCatalogQuery(engine.sql));
    } finally {
      await engine.disconnect();
    }
  });
}

async function captureDbInitSchema(): Promise<CatalogSnapshot> {
  return withFreshDatabase(DATABASE_URL!, async (name) => {
    await db.connect({ database_url: withDatabase(DATABASE_URL!, name) });
    try {
      await db.initSchema();
      return await snapshotCatalog(postgresCatalogQuery(db.getConnection()));
    } finally {
      await db.disconnect();
    }
  });
}

async function captureStable(config: CatalogConfig, capture: () => Promise<CatalogSnapshot>): Promise<CatalogSnapshot> {
  return withCatalogConfig(config, () => expectNormalizerStable(capture, catalogGoldenNormalizer));
}

function assertSameCatalog(label: string, expected: CatalogSnapshot, actual: CatalogSnapshot): void {
  const diff = diffCatalogSnapshots(expected, actual, { compareOrdinals: true });
  if (diff.length > 0) throw new Error(`${label}:\n${formatCatalogDiffForFailure(diff)}`);
  expect(diff).toEqual([]);
}

/** Column view of a catalog in the shape the existing name-based drift gate diffs. */
function toSchemaSnapshot(snap: CatalogSnapshot): SchemaSnapshot {
  const out: SchemaSnapshot = new Map();
  for (const t of [...snap.tables, ...snap.viewColumns.map((v) => ({ name: v.view, columns: v.columns }))]) {
    out.set(t.name, new Map(t.columns.map((c) => [c.name, {
      dataType: c.dataType, udtName: c.udtName, isNullable: c.isNullable, columnDefault: c.columnDefault,
    }])));
  }
  return out;
}

const captured = new Map<string, CatalogSnapshot>();
function requireCaptured(key: string): CatalogSnapshot {
  const snap = captured.get(key);
  if (!snap) throw new Error(`capture ${key} did not run (an earlier test in this file failed)`);
  return snap;
}

describe.skipIf(skip)('Postgres catalog goldens (E4, E2E)', () => {
  for (const config of CATALOG_CONFIGS) {
    test(`engine init, ${config.name}`, async () => {
      const snap = await captureStable(config, () => captureEngineInit());
      captured.set(`engine:${config.name}`, snap);
      expectCatalogGolden(`catalog/postgres-engine-init-${config.name}`, snap);
    }, CAPTURE_TIMEOUT);
  }

  test('db.initSchema() (raw SCHEMA_SQL, no migrations), default config', async () => {
    const snap = await captureStable(CATALOG_CONFIGS[0], captureDbInitSchema);
    captured.set('db:default', snap);
    expectCatalogGolden('catalog/postgres-db-initschema', snap);
  }, CAPTURE_TIMEOUT);

  test('db.initSchema() ignores embedding dims and FTS language (config-independent on master)', async () => {
    const baseline = requireCaptured('db:default');
    for (const config of CATALOG_CONFIGS.slice(1)) {
      const snap = await withCatalogConfig(config, captureDbInitSchema);
      assertSameCatalog(`db.initSchema() under ${config.name} differs from default`, baseline, snap);
    }
  }, CAPTURE_TIMEOUT);

  test('high-dims engine init skips the chunk and halfvec HNSW indexes', () => {
    const dflt = new Set(requireCaptured('engine:default').indexes.map((i) => i.name));
    const high = new Set(requireCaptured('engine:high-dims').indexes.map((i) => i.name));
    for (const name of ['idx_chunks_embedding', 'idx_facts_embedding_hnsw', 'idx_query_cache_embedding_hnsw']) {
      expect(dflt.has(name)).toBe(true);
      expect(high.has(name)).toBe(false);
    }
  });

  test('non-default FTS language changes trigger bodies and the title index', () => {
    const diff = diffCatalogSnapshots(requireCaptured('engine:default'), requireCaptured('engine:fts-portuguese'));
    expect(diff.length).toBeGreaterThan(0);
    const titleIndexes = diff.filter(d => d.section === 'indexes');
    expect(titleIndexes.map(d => d.key).sort()).toEqual(['idx_pages_title_fts_english', 'idx_pages_title_fts_portuguese']);
    expect([...new Set(diff.filter(d => d.section !== 'indexes').map(d => d.section))]).toEqual(['functions']);
  });

  test('T-G13: PG <-> PGLite column parity stays name-based (existing drift contract)', async () => {
    const pglite = await withCatalogConfig(CATALOG_CONFIGS[0], capturePgliteEngineCatalog);
    const diff = diffSnapshots(toSchemaSnapshot(requireCaptured('engine:default')), toSchemaSnapshot(pglite), {
      allowlistPgOnlyTables: PG_ONLY_TABLES,
    });
    if (!isCleanDiff(diff)) throw new Error(`PG <-> PGLite column drift:\n${formatDiffForFailure(diff)}`);
    expect(isCleanDiff(diff)).toBe(true);
  }, CAPTURE_TIMEOUT);

  test.skipIf(skipPooled)('engine init through transaction-mode PgBouncer reaches the direct-Postgres catalog', async () => {
    const pooled = await withCatalogConfig(CATALOG_CONFIGS[0], () => captureEngineInit(POOLED_DIRECT_URL!, POOLED_URL!));
    assertSameCatalog('PgBouncer engine init differs from direct Postgres', requireCaptured('engine:default'), pooled);
  }, CAPTURE_TIMEOUT);
});
