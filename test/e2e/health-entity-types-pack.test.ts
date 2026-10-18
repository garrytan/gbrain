/**
 * #4772 on real Postgres (and PgBouncer in the backend matrix): the Postgres
 * engine's `HealthDeps.entityTypes` delegate resolves the active pack per
 * requested source and the shared health SQL binds the resolved type lists.
 * Same scenarios as the PGLite suite (`test/health-entity-types-pack.test.ts`):
 * custom pack, reclassified legacy name, per-source packs, missing and corrupt
 * packs, one broken source override.
 *
 * DATABASE_URL gated.
 */
import { afterAll, beforeEach, describe, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { _resetPackCacheForTests } from '../../src/core/schema-pack/registry.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import {
  PACKS,
  expectCustomPackCounted,
  expectDegradedNotLegacy,
  expectOneSourceUnavailable,
  expectPerSourceResolution,
  expectReclassifiedLegacyNameExcluded,
  seedCustomEntityPages,
  seedOneSourceUnavailable,
  seedPerSourcePacks,
  seedReclassifiedLegacyName,
  seedUnavailablePack,
  writeEntityTypePacks,
} from '../helpers/entity-types-pack-fixture.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-4772-health-pg-'));
const env = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, fn);

describe.skipIf(!hasDatabase())('#4772 getHealth entity types come from the active pack (Postgres)', () => {
  let engine: PostgresEngine;

  beforeEach(async () => {
    engine = await setupDB();
    writeEntityTypePacks(home);
    _resetPackCacheForTests();
  }, 120_000);

  afterAll(async () => {
    await teardownDB();
    rmSync(home, { recursive: true, force: true });
  });

  test('a custom pack with three entity-primitive pages counts three entities', async () => {
    await env(async () => {
      await seedCustomEntityPages(engine);
      await expectCustomPackCounted(engine);
    });
  });

  test('a legacy name the pack declares under another primitive is not an entity', async () => {
    await env(async () => {
      await seedReclassifiedLegacyName(engine);
      await expectReclassifiedLegacyNameExcluded(engine);
    });
  });

  test('the same type name with different primitives in two sources resolves per source', async () => {
    await env(async () => {
      await seedPerSourcePacks(engine);
      await expectPerSourceResolution(engine);
    });
  });

  test('a missing pack degrades the entity metrics instead of counting legacy names', async () => {
    await env(async () => {
      await seedUnavailablePack(engine, PACKS.missing);
      await expectDegradedNotLegacy(engine);
    });
  });

  test('a corrupt pack degrades the entity metrics instead of counting legacy names', async () => {
    await env(async () => {
      await seedUnavailablePack(engine, PACKS.corrupt);
      await expectDegradedNotLegacy(engine);
    });
  });

  test('one source whose override cannot load degrades only the readings that include it', async () => {
    await env(async () => {
      await seedOneSourceUnavailable(engine);
      await expectOneSourceUnavailable(engine);
    });
  });
});
