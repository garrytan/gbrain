/**
 * #4772 — getHealth's entity counters follow the active schema pack.
 *
 * Protects: `entity_page_count`, `link_coverage`, `timeline_coverage` and
 * `most_connected` count the pages whose type the active pack declares with
 * `primitive: entity` (plus the legacy names a pack leaves undeclared), per
 * requested source, and report `entity_types_status: 'pack_unavailable'` with
 * an empty filter when a pack in scope cannot load.
 * Fails when: the predicate goes back to the hardcoded
 * `('entity','person','company')` list (custom types count 0, a reclassified
 * legacy name still counts, a broken pack silently reads as legacy names), or
 * when per-source packs are unioned by name.
 * Why new: `test/engine-sql-health-equality.test.ts` pins the counters
 * against the pre-F4a implementation on gbrain-base only; nothing exercised a
 * custom or per-source pack through getHealth. PGLite arm; the Postgres twin
 * is `test/e2e/health-entity-types-pack.test.ts` (the other HealthDeps delegate).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
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
} from './helpers/entity-types-pack-fixture.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-4772-health-'));
const env = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, fn);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  writeEntityTypePacks(home);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
});

describe('#4772 getHealth entity types come from the active pack (PGLite)', () => {
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

  test('gbrain-base: person and company pages still count, so the default brain is unchanged', async () => {
    await env(async () => {
      await engine.putPage('people/ann-example', { title: 'Ann', type: 'person', compiled_truth: '# Ann\n' });
      await engine.putPage('companies/acme-example', { title: 'Acme', type: 'company', compiled_truth: '# Acme\n' });
      await engine.putPage('notes/n', { title: 'n', type: 'note', compiled_truth: '# n\n' });
      const health = await engine.getHealth();
      expect(health.entity_page_count).toBe(2);
      expect(health.entity_types_status).toBe('resolved');
    });
  });
});
