/**
 * Page-vector rebuilds read the seal's effective timeline (CSO finding on
 * wave 13 PR4): a fact withdrawn in the database ledger stays in the raw
 * timeline column, and the seal indexes the snapshot with the withdrawal
 * overlay. `reindex-search-vector` (backfillPageVectors) and the
 * fts_cjk_boundary migration must not put the withdrawn term back.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { backfillPageVectors } from '../src/core/search-vector-backfill.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SLUG = 'notes/withdrawal-example';
const CLAIM = 'withdrawncanary example fact';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function withdrawnPage(title: string): Promise<void> {
  const fence = renderFactsTable([{ rowNum: 1, claim: CLAIM, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }]);
  await engine.putPage(SLUG, { type: 'note', title, compiled_truth: 'Safe prose.', timeline: fence, frontmatter: {} });
  const fact = await engine.insertFact({ fact: CLAIM, source: 'withdrawal-fixture', visibility: 'world' }, { source_id: 'default' });
  await recordFactWithdrawal(engine, fact.id, 'default', true, { semanticReview: false });
  await rebuildPendingPageProjections(engine, 100);
}
const state = async () => (await engine.executeRaw<{ v: string; raw: string; sealed: boolean }>(
  `SELECT search_vector::text AS v, timeline AS raw, text_projection_revision = knowledge_revision AS sealed FROM pages WHERE slug = $1`, [SLUG]))[0]!;

describe('page-vector rebuilds keep database withdrawals out', () => {
  test('backfillPageVectors indexes the withdrawal overlay, not the raw timeline', async () => {
    await withdrawnPage('Withdrawal example');
    const before = await state();
    expect(before.raw).toContain(CLAIM);
    expect(before.v).not.toContain('withdrawncanari');
    await backfillPageVectors(engine, { lang: 'english', checkpoint: 'withdrawal-test' });
    const after = await state();
    expect(after.v).not.toContain('withdrawncanari');
    expect(after.sealed).toBe(true);
    expect((await engine.searchTitles('withdrawncanary')).map(r => r.slug)).toEqual([]);
  });

  test('the fts_cjk_boundary migration rebuild does the same for a CJK-titled page', async () => {
    await withdrawnPage('升级PostgreSQL17指南');
    await MIGRATIONS.find(m => m.name === 'fts_cjk_boundary')!.handler!(engine);
    const after = await state();
    expect(after.v).toContain("'postgresql17'");
    expect(after.v).not.toContain('withdrawncanari');
    expect((await engine.searchTitles('withdrawncanary')).map(r => r.slug)).toEqual([]);
  });
});
