/**
 * #6803 (4): a checkout-less per-source cycle (a connector source: phases
 * extract, extract_facts, recompute_emotional_weight, no sync) reconciled
 * facts for EVERY slug in the brain on every cycle. With no sync phase the
 * phase got `slugs: undefined`, the full-walk mode, and the full walk read
 * `engine.getAllSlugs()` unscoped, so a connector source on a 290K-page brain
 * walked every other source's pages until the autopilot-cycle job died with
 * `aborted: timeout`. A connector cycle now reconciles only its own source,
 * through the bounded reconcile watermark drain.
 *
 * Real handler and cycle on every configured engine. The fixture
 * toggles the brain-wide persistence switch and process env.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { makeAutopilotCycleHandler } from '../src/core/minions/handlers/autopilot-cycle.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, googleConfig } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
const { engines, env, source } = fixture;
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

const OTHER_PAGES = 40;

async function seed(engine: BrainEngine): Promise<{ connector: string; other: string }> {
  const connector = (await source(engine, googleConfig)).id;
  const other = (await source(engine, {})).id;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.putPage('emails/example', { title: 'Synthetic exchange', type: 'email', compiled_truth: 'A synthetic note.' }, { sourceId: connector });
  for (let i = 0; i < OTHER_PAGES; i++) {
    await engine.putPage(`notes/n-${i}`, { title: `Note ${i}`, type: 'note', compiled_truth: `Body ${i}.` }, { sourceId: other });
  }
  return { connector, other };
}

describe('#6803 connector cycle extract_facts scope', () => {
  test('a connector cycle reconciles only its own source, through the bounded drain', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { connector } = await seed(engine);
      const out = await makeAutopilotCycleHandler(engine)({ id: 1, data: { source_id: connector } } as never) as {
        report: { brain_dir: string | null; phases: Array<{ phase: string; status: string; details: Record<string, unknown> }> };
      };
      expect(out.report.brain_dir).toBeNull();
      const facts = out.report.phases.find(p => p.phase === 'extract_facts');
      expect(facts).toBeDefined();
      expect(Number(facts!.details.pagesScanned)).toBeLessThanOrEqual(1);
      const weight = out.report.phases.find(p => p.phase === 'recompute_emotional_weight');
      expect(weight?.details).toMatchObject({ mode: 'incremental', pages_recomputed: 1 });
      // The next cycle starts from this cycle's stamp: nothing in the source changed since.
      const again = await makeAutopilotCycleHandler(engine)({ id: 2, data: { source_id: connector } } as never) as typeof out;
      expect(again.report.phases.find(p => p.phase === 'recompute_emotional_weight')?.details).toMatchObject({ mode: 'incremental', pages_recomputed: 0 });
      // A page that changed while a cycle ran (after it listed its pages, before its stamp) is picked up by the next one.
      const [stamps] = await engine.executeRaw<{ window_at: string; stamp: string }>(
        "SELECT config->>'last_source_cycle_window_at' AS window_at, config->>'last_source_cycle_at' AS stamp FROM sources WHERE id=$1", [connector]);
      expect(Date.parse(stamps.window_at)).toBeLessThan(Date.parse(stamps.stamp));
      await engine.executeRaw("UPDATE pages SET updated_at=$2::timestamptz + interval '1 millisecond' WHERE source_id=$1 AND slug='emails/example'", [connector, stamps.window_at]);
      expect((await engine.executeRaw<{ before: boolean }>("SELECT updated_at < $2::timestamptz AS before FROM pages WHERE source_id=$1 AND slug='emails/example'", [connector, stamps.stamp]))[0].before).toBe(true);
      const third = await makeAutopilotCycleHandler(engine)({ id: 3, data: { source_id: connector } } as never) as typeof out;
      expect(third.report.phases.find(p => p.phase === 'recompute_emotional_weight')?.details).toMatchObject({ mode: 'incremental', pages_recomputed: 1 });
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }), 180_000);

  test('with managed persistence (no watermark drain) the cycle still reconciles the source\'s changed pages', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { connector } = await seed(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const out = await makeAutopilotCycleHandler(engine)({ id: 4, data: { source_id: connector } } as never) as {
        report: { phases: Array<{ phase: string; status: string; details: Record<string, unknown> }> };
      };
      expect(Number(out.report.phases.find(p => p.phase === 'extract_facts')!.details.pagesScanned)).toBe(1);
      await disposePersistenceConsumer(engine);
    }
  }), 180_000);

  test('a full walk for one source never visits another source\'s slugs', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { connector } = await seed(engine);
      const result = await runExtractFacts(engine, { sourceId: connector, drain: {} });
      expect(result.pagesScanned).toBe(1);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }), 180_000);
});
