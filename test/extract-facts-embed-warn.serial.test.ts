/**
 * #3044 — extract_facts batch-embed failure must surface, not swallow.
 *
 * The batch-embed step inside runExtractFacts is fail-open by design (facts
 * still insert with NULL embeddings), but the failure must land in
 * result.warnings AND the cycle wrapper (runPhaseExtractFacts in cycle.ts)
 * must fold those warnings into a 'warn' phase status with a warning count.
 * Pre-#1928 the phase read as a clean 'ok', which is exactly how a
 * billing/auth/rate-limit embed failure hid inside a green cycle report.
 *
 * Serial: uses mock.module on the gateway (isAvailable → true, embed →
 * throws), which leaks across files (isolation guard R2).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';

mock.module('../src/core/ai/gateway.ts', () => ({
  isAvailable: () => true,
  embed: async () => {
    throw new Error('HTTP 429: rate limited by embedding provider');
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

describe('extract_facts batch-embed failure (#3044)', () => {
  test('runExtractFacts pushes the failure into warnings and still inserts facts (fail-open)', async () => {
    await seedFencedPage();

    const r = await runExtractFacts(engine, { slugs: ['people/alice-example'] });

    expect(r.factsInserted).toBe(1); // fail-open: facts land without embeddings
    expect(r.warnings.some(w => w.includes('extract_facts batch embed failed'))).toBe(true);
    expect(r.warnings.some(w => w.includes('429'))).toBe(true);
  });

  test('cycle wrapper folds the embed warning into a warn phase status + warning count', async () => {
    await seedFencedPage();
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-embed-warn-home-'));
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
        expect(warnings.some(w => w.includes('extract_facts batch embed failed'))).toBe(true);
      });
    } finally {
      rmSync(gbrainHome, { recursive: true, force: true });
    }
  });
});
