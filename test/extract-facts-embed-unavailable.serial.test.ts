/**
 * #2821 — extract_facts must WARN when the embedding gateway is unavailable.
 *
 * The batch-embed step inside runExtractFacts is fail-open by design (facts
 * still insert with NULL embeddings when no embedding provider is
 * configured), but pre-fix only the embed() FAILURE path warned — the
 * isAvailable('embedding') === false path inserted NULL-embedding rows in
 * complete silence, so consolidate's cosine clustering and find_trajectory's
 * drift_score degraded with a clean green 'ok' in the cycle report. The
 * unavailable branch must land in result.warnings AND the cycle wrapper must
 * fold it into a 'warn' phase status, same as the #3044 embed-failure class.
 *
 * Serial: uses mock.module on the gateway (isAvailable → false, embed →
 * throws if ever called), which leaks across files (isolation guard R2).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';

let embedCalls = 0;
mock.module('../src/core/ai/gateway.ts', () => ({
  isAvailable: () => false,
  embed: async () => {
    embedCalls++;
    throw new Error('embed() must not be called when the gateway is unavailable');
  },
}));

const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { runExtractFacts } = await import('../src/core/cycle/extract-facts.ts');
const { runCycle } = await import('../src/core/cycle.ts');

let engine: InstanceType<typeof PGLiteEngine>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM pages');
});

const FENCED_BODY = `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded a widget company | fact | 1.0 | world | high | 2017-01-01 |  | notes |  |
<!--- gbrain:facts:end -->
`;

async function seedFencedPage(): Promise<void> {
  await engine.putPage('people/alice-example', {
    title: 'alice-example',
    type: 'person',
    compiled_truth: FENCED_BODY,
    frontmatter: {},
    timeline: '',
  });
}

describe('extract_facts embedding gateway unavailable (#2821)', () => {
  test('runExtractFacts still inserts (fail-open) but pushes a NULL-embedding warning', async () => {
    await seedFencedPage();

    const r = await runExtractFacts(engine, { slugs: ['people/alice-example'] });

    expect(r.factsInserted).toBe(1); // fail-open: facts land without embeddings
    expect(embedCalls).toBe(0); // unavailable gateway is never called
    expect(r.warnings.some(w => w.includes('embedding gateway unavailable'))).toBe(true);
    expect(r.warnings.some(w => w.includes('NULL embedding'))).toBe(true);
    expect(r.warnings.some(w => w.includes('people/alice-example'))).toBe(true);
  });

  test('cycle wrapper folds the unavailable warning into a warn phase status', async () => {
    await seedFencedPage();
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-embed-unavail-home-'));
    try {
      await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
        const report = await runCycle(engine, {
          brainDir: null,
          phases: ['extract_facts'],
        });
        const phase = report.phases.find(p => p.phase === 'extract_facts');
        expect(phase).toBeDefined();
        expect(phase!.status).toBe('warn');
        expect(phase!.summary).toContain('warning(s)');
        const warnings = (phase!.details as { warnings?: string[] }).warnings ?? [];
        expect(warnings.some(w => w.includes('embedding gateway unavailable'))).toBe(true);
      });
    } finally {
      rmSync(gbrainHome, { recursive: true, force: true });
    }
  });
});
