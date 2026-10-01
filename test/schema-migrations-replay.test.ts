/**
 * W3 (refactor wave 1, EO10): replay the split migration registry from
 * several checkpoints on PGLite and land on the E4 fresh-install catalog.
 *
 * Protects: apply order and content of src/core/schema-migrations/ after the
 * split. A fresh brain (bootstrap + schema blob + every migration) has its
 * recorded schema_version rewound to a checkpoint, then runMigrations applies
 * every later version again; the end state must equal the master golden
 * catalog/pglite-engine-init-default, ordinals included.
 * Checkpoints: v2 (the whole chain), v20 (before v21 introduced pages.source_id,
 * the first forward-referenced column the bootstrap probes), v95 (before the
 * handler-heavy v96-v105 run), LATEST-1.
 * Apply-from-empty is the engine-init golden in test/schema-catalog-golden.test.ts.
 * Postgres counterpart: test/e2e/schema-migrations-replay.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { LATEST_VERSION, MIGRATIONS } from '../src/core/migrate.ts';
import { CATALOG_CONFIGS, capturePgliteReplayCatalog, expectCatalogGolden, withCatalogConfig } from './helpers/schema-catalog.ts';

const REPLAY_CHECKPOINTS = [2, 20, 95, LATEST_VERSION - 1] as const;

describe('schema migrations replay from checkpoints (PGLite)', () => {
  for (const checkpoint of REPLAY_CHECKPOINTS) {
    test(`replay from v${checkpoint} reaches the fresh-install catalog`, async () => {
      const { catalog, applied, current } = await withCatalogConfig(CATALOG_CONFIGS[0], () => capturePgliteReplayCatalog(checkpoint));
      expect(applied).toBe(MIGRATIONS.filter((m) => m.version > checkpoint).length);
      expect(current).toBe(LATEST_VERSION);
      expectCatalogGolden('catalog/pglite-engine-init-default', catalog);
    }, 180_000);
  }
});
