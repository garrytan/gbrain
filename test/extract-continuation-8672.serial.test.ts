/** #8672: handler admission seam; real queue persistence, scripted sweep outcomes.
 * Serial because mock.module replaces the command for this process. Real sweep
 * and dependency recovery are covered by links-attendance-blocked.test.ts.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import type { StaleExtractionCounts } from '../src/core/extraction-lag.ts';

let result: { pagesProcessed: number; staleRemaining: number; mentions?: { pages: number }; counts?: StaleExtractionCounts };
let options: Record<string, unknown>;
mock.module('../src/commands/extract.ts', () => ({
  STALE_TIME_BUDGET_MS: 1800000,
  extractStaleFromDB: async (_engine: unknown, opts: Record<string, unknown>) => {
    options = opts;
    return { linksCreated: 0, timelineCreated: 0, ...result };
  },
}));
const { makeExtractHandler } = await import('../src/core/minions/handlers/extract.ts');
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); mock.restore(); });

const complete: StaleExtractionCounts = { actionable: 0, attendance_blocked: 4, held: 2, mention_due: null, complete: true };
let parent = 867200;
async function run(outcome: typeof result, data: Record<string, unknown> = {}) {
  result = outcome;
  const id = ++parent;
  const input = { stale: true, sourceId: 'default', ...data };
  const returned = await makeExtractHandler(engine)({ id, data: input } as unknown as MinionJobContext);
  expect(options).toMatchObject({ sourceIdFilter: 'default', counts: true });
  const children = await engine.executeRaw<{ data: Record<string, unknown>; timeout_ms: number }>(
    "SELECT data, timeout_ms FROM minion_jobs WHERE name='extract' AND data->>'continuation_of'=$1", [String(id)]);
  return { returned, children };
}

test('progress with only blocked or held remainder does not enqueue an empty child', async () => {
  const r = await run({ pagesProcessed: 2, staleRemaining: 6, counts: complete });
  expect(r.children).toHaveLength(0);
  expect(r.returned).toMatchObject({ counts: complete, staleRemaining: 6 });
});
test('a productive bounded sweep still continues actionable work with the original scope and timeout', async () => {
  const r = await run({ pagesProcessed: 2, staleRemaining: 7, counts: { ...complete, actionable: 1, complete: false } });
  expect(r.children).toHaveLength(1);
  expect(r.children[0]).toMatchObject({ data: { stale: true, sourceId: 'default', continuation_of: parent }, timeout_ms: 2100000 });
});
test('enabled mention work continues even after link work drains', async () => {
  const r = await run({ pagesProcessed: 0, mentions: { pages: 1 }, staleRemaining: 3,
    counts: { ...complete, mention_due: 3, complete: false } });
  expect(r.children).toHaveLength(1);
});
test('no-progress and dry-run guards still prevent continuation', async () => {
  const pending = { ...complete, actionable: 1, complete: false };
  expect((await run({ pagesProcessed: 0, staleRemaining: 1, counts: pending })).children).toHaveLength(0);
  expect((await run({ pagesProcessed: 1, staleRemaining: 1, counts: pending }, { dryRun: true })).children).toHaveLength(0);
});
test('missing eligibility is not treated as known completion', async () => {
  expect((await run({ pagesProcessed: 1, staleRemaining: 1 })).children).toHaveLength(1);
});
