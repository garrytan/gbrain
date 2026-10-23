/**
 * #7388: the multi_source_drift existence probe on a source with more files than Postgres allows bind parameters.
 *
 * 1. Protects: batchProbeExistence answers for every walked slug, at default and at the intended source, however many
 *    slugs a source has; doctor's multi_source_drift no longer reports "not verified" on a source with 65,534+ files.
 * 2. Fails when: the probe binds one parameter per slug again (MAX_PARAMETERS_EXCEEDED past 65,533 slugs), or drops a slug.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { batchProbeExistence } from '../src/core/multi-source-drift.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const OVER_THE_CAP = 65_600;

async function probeOverTheCap(engine: BrainEngine) {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING");
  await engine.putPage('notes/misrouted', { type: 'note', title: 'Misrouted', compiled_truth: 'x', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('notes/at-home', { type: 'note', title: 'At home', compiled_truth: 'x', timeline: '', frontmatter: {} }, { sourceId: 'source-a' });
  const slugs = Array.from({ length: OVER_THE_CAP }, (_, i) => `notes/file-${i}`).concat(['notes/misrouted', 'notes/at-home']);
  const map = await batchProbeExistence(engine, slugs, 'source-a');
  expect(map.size).toBe(slugs.length);
  expect([...map.get('notes/misrouted')!]).toEqual(['default']);
  expect([...map.get('notes/at-home')!]).toEqual(['source-a']);
  expect(map.get('notes/file-65599')!.size).toBe(0);
}

for (const kind of testBackends()) {
  describe(`multi_source_drift probe past the bind-parameter cap (#7388; ${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('every slug answers, the misroute and the page at home included', async () => {
      await probeOverTheCap(engine);
    }, 120_000);
  });
}
