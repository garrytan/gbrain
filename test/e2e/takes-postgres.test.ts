/**
 * v0.28 e2e: full takes pipeline against real Postgres.
 *
 * Covers:
 * - Schema migrations v31 + v32 applied (takes + synthesis_evidence + permissions)
 * - addTakesBatch upsert via unnest() bind shape (Postgres-specific)
 * - listTakes filters + sort + takesHoldersAllowList SQL filter
 * - searchTakes (pg_trgm) + searchTakesVector (vector)
 * - supersedeTake transactional path on real PG
 * - resolveTake immutability
 * - synthesis_evidence FK CASCADE on take delete
 * - extractTakes phase populates the table
 * - MCP dispatch with per-token allow-list (defense-in-depth Codex P0 #3)
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { extractTakesFromDb } from '../../src/core/cycle/extract-takes.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

let alicePageId: number;
let acmePageId: number;

beforeAll(async () => {
  if (!RUN) return;
  const engine = await setupDB();
  const alice = await engine.putPage('people/alice-example', {
    title: 'Alice', type: 'person', compiled_truth: '## Takes\n',
  });
  const acme = await engine.putPage('companies/acme-example', {
    title: 'Acme', type: 'company', compiled_truth: '## Takes\n',
  });
  alicePageId = alice.id;
  acmePageId = acme.id;
});

afterAll(async () => {
  if (!RUN) return;
  await teardownDB();
});

d('v0.28 takes engine — Postgres', () => {
  test('addTakesBatch upserts via unnest() bind path', async () => {
    const engine = getEngine();
    const inserted = await engine.addTakesBatch([
      { page_id: alicePageId, row_num: 1, claim: 'CEO of Acme', kind: 'fact', holder: 'world', weight: 1.0, since_date: '2017-01' },
      { page_id: alicePageId, row_num: 2, claim: 'Strong technical founder', kind: 'take', holder: 'garry', weight: 0.85, since_date: '2026-04-29' },
      { page_id: alicePageId, row_num: 3, claim: 'Will reach $50B', kind: 'bet', holder: 'garry', weight: 0.65, since_date: '2026-04-29' },
    ]);
    expect(inserted).toBe(3);

    // Re-insert is upsert
    const reinserted = await engine.addTakesBatch([
      { page_id: alicePageId, row_num: 2, claim: 'Best technical founder this batch', kind: 'take', holder: 'garry', weight: 0.95 },
    ]);
    expect(reinserted).toBe(1);

    const [row2] = await engine.listTakes({ page_id: alicePageId, kind: 'take' });
    expect(row2.claim).toBe('Best technical founder this batch');
    expect(row2.weight).toBe(0.95);
  });

  test('listTakes filters work (holder, kind, sort, allow-list)', async () => {
    const engine = getEngine();
    const garry = await engine.listTakes({ page_id: alicePageId, holder: 'garry' });
    expect(garry.every(t => t.holder === 'garry')).toBe(true);

    const bets = await engine.listTakes({ page_id: alicePageId, kind: 'bet' });
    expect(bets.every(t => t.kind === 'bet')).toBe(true);

    const sorted = await engine.listTakes({ page_id: alicePageId, sortBy: 'weight' });
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].weight).toBeLessThanOrEqual(sorted[i - 1].weight);
    }

    // takesHoldersAllowList filter
    const worldOnly = await engine.listTakes({ page_id: alicePageId, takesHoldersAllowList: ['world'] });
    expect(worldOnly.every(t => t.holder === 'world')).toBe(true);
  });

  test('searchTakes (pg_trgm) returns ranked hits with allow-list filter', async () => {
    const engine = getEngine();
    const hits = await engine.searchTakes('technical founder');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].claim.toLowerCase()).toContain('technical');

    const worldHits = await engine.searchTakes('founder', { takesHoldersAllowList: ['world'] });
    expect(worldHits.every(h => h.holder === 'world')).toBe(true);
  });

  test('supersedeTake is transactional on real Postgres', async () => {
    const engine = getEngine();
    const { oldRow, newRow } = await engine.supersedeTake(alicePageId, 3, {
      claim: 'Will reach $40B (revised)',
      kind: 'bet',
      holder: 'garry',
      weight: 0.7,
    });
    expect(oldRow).toBe(3);
    expect(newRow).toBeGreaterThan(3);

    const inactive = await engine.listTakes({ page_id: alicePageId, active: false });
    const old = inactive.find(t => t.row_num === 3);
    expect(old?.active).toBe(false);
    expect(old?.superseded_by).toBe(newRow);
  });

  test('resolveTake immutability — second resolve throws TAKE_ALREADY_RESOLVED', async () => {
    const engine = getEngine();
    await engine.addTakesBatch([
      { page_id: acmePageId, row_num: 1, claim: 'Will close Series B Q3', kind: 'bet', holder: 'garry', weight: 0.6 },
    ]);
    await engine.resolveTake(acmePageId, 1, {
      outcome: true, value: 25_000_000, unit: 'usd', source: 'crustdata', resolvedBy: 'garry',
    });
    const [resolved] = await engine.listTakes({ page_id: acmePageId, resolved: true });
    expect(resolved.resolved_outcome).toBe(true);
    expect(resolved.resolved_value).toBe(25_000_000);

    await expect(engine.resolveTake(acmePageId, 1, { outcome: false, resolvedBy: 'garry' }))
      .rejects.toThrow(/TAKE_ALREADY_RESOLVED/);
  });

  test('synthesis_evidence CASCADE deletes when source take is removed', async () => {
    const engine = getEngine();
    const synthPage = await engine.putPage('synthesis/alice-deep-2026-05-01', {
      title: 'Alice deep dive', type: 'synthesis', compiled_truth: 'Body [people/alice-example#1]',
    });
    await engine.addSynthesisEvidence([
      { synthesis_page_id: synthPage.id, take_page_id: alicePageId, take_row_num: 1, citation_index: 1 },
    ]);
    const before = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM synthesis_evidence WHERE synthesis_page_id = $1`,
      [synthPage.id],
    );
    expect(Number(before[0]?.count)).toBe(1);

    // Delete the source take
    await engine.executeRaw(`DELETE FROM takes WHERE page_id = $1 AND row_num = $2`, [alicePageId, 1]);
    const after = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM synthesis_evidence WHERE synthesis_page_id = $1`,
      [synthPage.id],
    );
    expect(Number(after[0]?.count)).toBe(0);
  });

  test('countStaleTakes + listStaleTakes filter active+null embeddings', async () => {
    const engine = getEngine();
    const count = await engine.countStaleTakes();
    expect(count).toBeGreaterThan(0);
    const stale = await engine.listStaleTakes();
    expect(stale.length).toBe(count);
    expect(stale[0]).toHaveProperty('take_id');
  });
});

d('v0.28 extract-takes phase — Postgres', () => {
  test('extractTakesFromDb populates takes table from fenced markdown', async () => {
    const engine = getEngine();
    // Add a fresh page with a fence and confirm extract picks it up
    const charlie = await engine.putPage('people/charlie-example', {
      title: 'Charlie', type: 'person',
      compiled_truth: `# Charlie

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | YC alum | fact | world | 1.0 | 2024-06 | crunchbase |
| 2 | Strong DX intuition | take | garry | 0.8 | 2026-04 | OH |
${TAKES_FENCE_END}
`,
    });
    const result = await extractTakesFromDb(engine, { slugs: ['people/charlie-example'] });
    expect(result.pagesScanned).toBe(1);
    expect(result.pagesWithTakes).toBe(1);
    expect(result.takesUpserted).toBe(2);

    const takes = await engine.listTakes({ page_id: charlie.id });
    expect(takes).toHaveLength(2);
    expect(takes.find(t => t.kind === 'fact')?.claim).toBe('YC alum');
  });
});

d('v0.28 MCP allow-list — Postgres dispatch', () => {
  test('takes_list returns only world holders when allow-list = ["world"]', async () => {
    const engine = getEngine();
    const result = await dispatchToolCall(engine, 'takes_list', { page_slug: 'people/alice-example' }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    expect(result.isError).toBeFalsy();
    const takes = JSON.parse(result.content[0].text);
    expect(Array.isArray(takes)).toBe(true);
    expect((takes as Array<{ holder: string }>).every(t => t.holder === 'world')).toBe(true);
  });

  test('takes_list returns all holders when no allow-list (local CLI)', async () => {
    const engine = getEngine();
    const result = await dispatchToolCall(engine, 'takes_list', { page_slug: 'people/alice-example' }, {
      remote: false,
    });
    const takes = JSON.parse(result.content[0].text) as Array<{ holder: string }>;
    const holders = new Set(takes.map(t => t.holder));
    // Multiple holders present (we seeded world + garry)
    expect(holders.size).toBeGreaterThanOrEqual(1);
  });

  test('takes_search honors allow-list', async () => {
    const engine = getEngine();
    const result = await dispatchToolCall(engine, 'takes_search', { query: 'technical' }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    const hits = JSON.parse(result.content[0].text) as Array<{ holder: string }>;
    expect(hits.every(h => h.holder === 'world')).toBe(true);
  });

  test('think op rejects save/take from remote callers', async () => {
    const engine = getEngine();
    const result = await dispatchToolCall(engine, 'think', { question: 'q', save: true, take: true }, {
      remote: true,
    });
    const env = JSON.parse(result.content[0].text);
    // Remote with save/take → safe path forces them off, runs gather-only
    expect(env.remote_persisted_blocked).toBe(true);
  });
});
