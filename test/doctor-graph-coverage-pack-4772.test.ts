/**
 * #4772 — doctor's graph_coverage and orphan_ratio gates count the entity
 * types the active schema pack declares, per source, and say so when the pack
 * cannot load.
 *
 * Protects: a brain whose entities are custom pack types (no `person` /
 * `company` pages) gets a real coverage reading instead of "No entity pages —
 * not applicable"; a pack that fails to load turns graph_coverage into a warn
 * that names the pack problem instead of a silent legacy-list reading;
 * `orphan_ratio --source` counts that source's own pack types.
 * Fails when: either check goes back to the hardcoded four-name list.
 * Why new: `doctor-graph-coverage-*.test.ts` seed `person` pages only, which
 * every policy agrees on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../src/core/types.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { PACKS, SRC_X, SRC_Y, putTyped, seedPerSourcePacks, writeEntityTypePacks } from './helpers/entity-types-pack-fixture.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-4772-doctor-'));
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

const find = (checks: Awaited<ReturnType<typeof buildChecks>>, name: string) => {
  const check = checks.find((c) => c.name === name);
  expect(check, `${name} check must be present`).toBeDefined();
  return check!;
};

describe('#4772 doctor entity gates follow the active pack', () => {
  test('graph_coverage grades a brain whose entities are custom pack types', async () => {
    await env(async () => {
      await engine.setConfig('schema_pack', PACKS.research);
      for (let i = 0; i < MIN_ENTITY_PAGES_FOR_COVERAGE; i++) await putTyped(engine, `researchers/r-${i}-example`, 'researcher');
      await putTyped(engine, 'notes/plain', 'note');
      const graph = find(await buildChecks(engine, [], null), 'graph_coverage');
      expect(graph.message).not.toContain('not applicable');
      expect(graph.status, 'five unlinked entities: a real coverage warn').toBe('warn');
      expect(graph.message).toContain(`${MIN_ENTITY_PAGES_FOR_COVERAGE} entity pages`);
    });
  });

  test('graph_coverage warns, naming the pack, when the active pack cannot load', async () => {
    await env(async () => {
      await engine.setConfig('schema_pack', PACKS.corrupt);
      for (let i = 0; i < MIN_ENTITY_PAGES_FOR_COVERAGE; i++) await putTyped(engine, `people/p-${i}-example`, 'person');
      const graph = find(await buildChecks(engine, [], null), 'graph_coverage');
      expect(graph.status).toBe('warn');
      expect(graph.message).toContain('schema pack');
      expect(graph.message, 'never a legacy-list coverage reading').not.toContain('connected coverage');
      expect(graph.message).not.toContain('No entity pages');
    });
  });

  test('orphan_ratio --source counts the entity types of that source\'s own pack', async () => {
    await env(async () => {
      await seedPerSourcePacks(engine);
      const x = find(await buildChecks(engine, ['--source', SRC_X], null), 'orphan_ratio');
      expect(x.message, 'two widgets are entities under X\'s pack').toContain('(2 entity pages <100)');
      const y = find(await buildChecks(engine, ['--source', SRC_Y], null), 'orphan_ratio');
      expect(y.message, 'one gadget is an entity under Y\'s pack').toContain('(1 entity pages <100)');
    });
  });
});
