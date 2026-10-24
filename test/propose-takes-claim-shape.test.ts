// Protects pending review from non-claims; existing tests cover caching, not shape.
// Removing the filter admits operational noise. Uses the existing extractor seam.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseProposeTakes, EMPTY_EXTRACTION_TOMBSTONE_TEXT } from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

const noise = [
  'Deployment stays red.', 'The dashboard remains green.',
  'Quota remaining: 12 requests.', '12 requests remaining.',
  'Should wire the metrics exporter.', 'Needs console re-verification.',
  'Options: Postgres / SQLite / Redis.',
];
const claims = [
  'The launch will stay red until demand falls below capacity.',
  'Quota exhaustion will delay the launch by two weeks.',
  'We should use Postgres because transactional writes will halve reconciliation errors.',
  'Postgres will outperform SQLite and Redis for this workload.',
  'The market is underestimating retention.',
];

test('only claims reach pending review and all-noise pages are cached', async () => {
  for (const slug of ['notes/mixed', 'notes/noise']) {
    await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: 'Review material.', frontmatter: {}, timeline: '' });
  }
  const ctx: OperationContext = {
    engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false, remote: false, sourceId: 'default',
  };
  let calls = 0;
  const extractor = async ({ pagePath }: { pagePath: string }) => {
    calls++;
    return (pagePath === 'notes/mixed' ? [...noise, ...claims] : noise).map(claim_text => ({
      claim_text, kind: 'take' as const, holder: 'brain', weight: 0.6,
    }));
  };
  const result = await runPhaseProposeTakes(ctx, { extractor });
  const pending = await engine.executeRaw<{ claim_text: string }>(
    "SELECT claim_text FROM take_proposals WHERE status = 'pending' ORDER BY claim_text",
  );
  expect(pending.map(row => row.claim_text)).toEqual([...claims].sort());
  expect(result.details.proposals_inserted).toBe(claims.length);
  expect(result.details.tombstones_written).toBe(1);
  expect(await engine.executeRaw("SELECT claim_text FROM take_proposals WHERE status = 'rejected'"))
    .toEqual([{ claim_text: EMPTY_EXTRACTION_TOMBSTONE_TEXT }]);
  const rerun = await runPhaseProposeTakes(ctx, { extractor });
  expect(rerun.details.cache_hits).toBe(2);
  expect(calls).toBe(2);
  expect(await engine.executeRaw('SELECT id FROM takes')).toEqual([]);
  expect((await engine.getPage('notes/mixed', { sourceId: 'default' }))?.compiled_truth).toBe('Review material.');
});
