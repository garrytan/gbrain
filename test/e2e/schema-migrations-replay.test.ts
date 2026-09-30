/**
 * W3 (refactor wave 1, EO10): replay the split migration registry from
 * several checkpoints on Postgres and land on the E4 engine-init catalog.
 *
 * Each checkpoint runs on a FRESH throwaway database: engine init (bootstrap
 * + SCHEMA_SQL + every migration), rewind the recorded schema_version to the
 * checkpoint, runMigrations again; the end state must equal the master golden
 * catalog/postgres-engine-init-default. Checkpoints and rationale match the
 * PGLite arm (test/schema-migrations-replay.test.ts). Skips without DATABASE_URL.
 */
import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { CATALOG_CONFIGS, expectCatalogGolden, postgresCatalogQuery, withCatalogConfig } from '../helpers/schema-catalog.ts';
import { snapshotCatalog } from '../helpers/schema-diff.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const CHECKPOINTS = [2, 20, 95, LATEST_VERSION - 1] as const;

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function withFreshDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  const name = `gbrain_test_replay_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    try {
      return await fn(withDatabase(DATABASE_URL!, name));
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

describe.skipIf(skip)('schema migrations replay from checkpoints (Postgres, E2E)', () => {
  for (const checkpoint of CHECKPOINTS) {
    test(`replay from v${checkpoint} reaches the engine-init catalog`, async () => {
      await withCatalogConfig(CATALOG_CONFIGS[0], () => withFreshDatabase(async (url) => {
        const engine = new PostgresEngine();
        try {
          await engine.connect({ database_url: url, poolSize: 2 });
          await engine.initSchema();
          await engine.setConfig('version', String(checkpoint));
          const result = await runMigrations(engine);
          expect(result.applied).toBe(MIGRATIONS.filter((m) => m.version > checkpoint).length);
          expect(result.current).toBe(LATEST_VERSION);
          expectCatalogGolden('catalog/postgres-engine-init-default', await snapshotCatalog(postgresCatalogQuery(engine.sql)));
        } finally {
          await engine.disconnect();
        }
      }));
    }, 300_000);
  }
});
