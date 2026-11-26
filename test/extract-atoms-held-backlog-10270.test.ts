/**
 * #10270: a page whose re-extraction is held (`generation_held`, reason `shrunk`) at its current content stayed in the
 * extract_atoms backlog count and discovery, while the phase skipped it as already held for that input (`heldForInput`).
 * Every batch extracted nothing, the recount did not move, and `dream --drain` stopped `no_progress` (exit 1) every night.
 *
 * Protects: a page held for its current input and the current generations policy leaves the count and discovery, so a
 * drain whose only remainder is held pages finishes `drained` with no model call; the hold itself stays recorded for
 * doctor's `generation_held` and its release; a hold under an older policy (which the phase recomputes) is still counted.
 * Seams: the gateway chat transport (no provider call); PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'notes/launch-plan';
const body = (topic: string) => `The team decided to review ${topic} against clear exit criteria before each launch. `.repeat(20);

let atomsPerCall = 3;
let calls = 0;

describe('extract_atoms backlog and a held generation (#10270)', () => {
  const engines: Array<{ backend: string; engine: BrainEngine; close: () => Promise<void> }> = [];

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    __setChatTransportForTests(async opts => {
      calls++;
      const text = JSON.stringify(Array.from({ length: atomsPerCall }, (_, i) => (
        { title: `Launch criterion ${calls}-${i}`, atom_type: 'insight', body: `Review launch criterion ${i} before shipping.` })));
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model!, providerId: 'anthropic' };
    });
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        engines.push({ backend, engine, close: () => engine.disconnect() });
      } else {
        const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engines.push({ backend, engine: isolated.engine, close: isolated.close });
      }
    }
  }, 120_000);
  afterAll(async () => {
    __setChatTransportForTests(null);
    resetGateway();
    for (const { engine, close } of engines) { await disposePersistenceConsumer(engine); await close(); }
  });

  test('a page held shrunk at its current input leaves the backlog, and the drain finishes clean', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-held-backlog' }, async () => {
      for (const { backend, engine } of engines) {
        const sourceId = `held-${backend}`;
        await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
        await engine.putPage(SLUG, { type: 'note', title: 'Launch plan', compiled_truth: body('the plan'), timeline: '' }, { sourceId });
        atomsPerCall = 3;
        expect((await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [] })).details.atoms_extracted, backend).toBe(3);
        expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);

        await engine.putPage(SLUG, { type: 'note', title: 'Launch plan', compiled_truth: body('the revised plan'), timeline: '' }, { sourceId });
        atomsPerCall = 1;
        await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [] });
        const held = await engine.executeRaw<{ held_reason: string }>(
          `SELECT held_reason FROM derived_generations WHERE source_id=$1 AND kind='atom' AND owner_key=$2 AND state='held'`, [sourceId, `source_slug:${SLUG}`]);
        expect(held.map(r => r.held_reason), backend).toEqual(['shrunk']);

        const before = calls;
        const drained = await runExtractAtomsDrainForSource(engine, { sourceId, windowSeconds: 60, maxBatches: 3 });
        expect(drained.stopped, backend).toBe('drained');
        expect(drained.remaining, backend).toBe(0);
        expect(calls, backend).toBe(before);
        expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);
        expect((await discoverExtractablePages(engine, sourceId)).map(p => p.slug), backend).not.toContain(SLUG);
        expect((await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM derived_generations WHERE source_id=$1 AND kind='atom' AND state='held'`, [sourceId]))[0]!.n, backend).toBe(1);

        await engine.setConfig('generations.shrink_floor', '0.05');
        expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(1);
        expect(await countExtractAtomsBacklog(engine), backend).toBeGreaterThanOrEqual(1);
        await engine.setConfig('generations.shrink_floor', '0.5');
      }
    });
  }, 180_000);
});
