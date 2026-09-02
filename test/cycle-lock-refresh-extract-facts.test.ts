/**
 * extract_facts refreshes the cycle lock mid-phase (outside-voice finding
 * OV1). synthesize, extract_atoms, patterns, synthesize_concepts and
 * consolidate already receive `buildYieldDuringPhase(lock, opts.yieldDuringPhase,
 * onStolen)`; extract_facts did not, so a facts run longer than LOCK_TTL_MS
 * (5 min) depended entirely on the background refresher and surfaced as
 * `lock_stolen` on a containerized worker (cycle reports at the 600 s mark).
 *
 * The hook fires every EXTRACT_FACTS_YIELD_EVERY pages of the reconcile
 * loop. A literal 6-minute run is not needed to prove the wiring: the same
 * closure that refreshes the lock also fires the caller's outer hook, so an
 * outer spy that fires during a 60-page reconcile proves the lock refresh
 * path is reached at the same cadence.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runExtractFacts, EXTRACT_FACTS_YIELD_EVERY } from '../src/core/cycle/extract-facts.ts';

const PAGES = 60;

let engine: PGLiteEngine;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);
afterAll(async () => { await engine.disconnect(); }, 30_000);
beforeEach(async () => {
  await resetPgliteState(engine);
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-facts-yield-home-'));
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', NULL)`);
  const values = Array.from({ length: PAGES }, (_, i) =>
    `('people/person-${String(i).padStart(3, '0')}', 'wiki', 'person', 'Person ${i}', 'A page with no facts fence.', '')`).join(',\n');
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ${values}`);
});
afterEach(() => { rmSync(gbrainHome, { recursive: true, force: true }); });

describe('extract_facts yieldDuringPhase', () => {
  test('runExtractFacts fires the hook every EXTRACT_FACTS_YIELD_EVERY pages', async () => {
    let calls = 0;
    const result = await runExtractFacts(engine, { sourceId: 'wiki', yieldDuringPhase: async () => { calls += 1; } });
    expect(result.pagesScanned).toBe(PAGES);
    expect(calls).toBe(Math.floor(PAGES / EXTRACT_FACTS_YIELD_EVERY));
  });

  test('a hook that throws never fails the reconcile', async () => {
    const result = await runExtractFacts(engine, { sourceId: 'wiki', yieldDuringPhase: async () => { throw new Error('refresh hiccup'); } });
    expect(result.pagesScanned).toBe(PAGES);
  });

  test('runCycle threads the hook into the extract_facts phase (the lock-refresh closure fires the outer hook)', async () => {
    let outerCalls = 0;
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, {
        brainDir: null,
        sourceId: 'wiki',
        phases: ['extract_facts'],
        yieldDuringPhase: async () => { outerCalls += 1; },
      }));
    const facts = report.phases.find((p) => p.phase === 'extract_facts');
    expect(facts?.status).not.toBe('fail');
    expect(facts?.status).not.toBe('skipped');
    expect(outerCalls).toBeGreaterThanOrEqual(Math.floor(PAGES / EXTRACT_FACTS_YIELD_EVERY));
  });
});
