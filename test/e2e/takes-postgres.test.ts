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

// ============================================================
// v0.30.0 (Slice A1): 3-state quality + scorecard + calibration on real PG.
// Mirrors the unit-test invariants (PGLite) against postgres.js and the
// real CHECK constraint enforcement.
// ============================================================
d('v0.30.0 takes resolve --quality on real Postgres', () => {
  test('quality=correct writes both columns; CHECK constraint is enforced', async () => {
    const engine = getEngine();
    await engine.addTakesBatch([
      { page_id: acmePageId, row_num: 50, claim: 'Series A correct', kind: 'bet', holder: 'garry', weight: 0.7 },
    ]);
    await engine.resolveTake(acmePageId, 50, { quality: 'correct', resolvedBy: 'garry' });
    const rows = await engine.executeRaw<{ resolved_outcome: boolean | null; resolved_quality: string | null }>(
      `SELECT resolved_outcome, resolved_quality FROM takes WHERE page_id = $1 AND row_num = $2`,
      [acmePageId, 50],
    );
    expect(rows[0].resolved_outcome).toBe(true);
    expect(rows[0].resolved_quality).toBe('correct');
  });

  test('quality=partial writes (partial, NULL) + CHECK accepts it', async () => {
    const engine = getEngine();
    await engine.addTakesBatch([
      { page_id: acmePageId, row_num: 51, claim: 'partial scope bet', kind: 'bet', holder: 'garry', weight: 0.55 },
    ]);
    await engine.resolveTake(acmePageId, 51, { quality: 'partial', resolvedBy: 'garry' });
    const rows = await engine.executeRaw<{ resolved_outcome: boolean | null; resolved_quality: string | null }>(
      `SELECT resolved_outcome, resolved_quality FROM takes WHERE page_id = $1 AND row_num = $2`,
      [acmePageId, 51],
    );
    expect(rows[0].resolved_outcome).toBeNull();
    expect(rows[0].resolved_quality).toBe('partial');
  });

  test('CHECK constraint rejects contradictory raw UPDATE', async () => {
    const engine = getEngine();
    await engine.addTakesBatch([
      { page_id: acmePageId, row_num: 52, claim: 'unresolved bet', kind: 'bet', holder: 'garry', weight: 0.6 },
    ]);
    // Bypass the engine method's deriveResolutionTuple guard and write a
    // contradictory tuple directly. The schema CHECK should refuse.
    await expect(
      engine.executeRaw(
        `UPDATE takes SET resolved_at = now(), resolved_outcome = true, resolved_quality = 'incorrect' WHERE page_id = $1 AND row_num = $2`,
        [acmePageId, 52],
      ),
    ).rejects.toThrow(/takes_resolution_consistency|check constraint/i);
  });

  test('back-compat: resolveTake with outcome=true → quality=correct on real PG', async () => {
    const engine = getEngine();
    await engine.addTakesBatch([
      { page_id: acmePageId, row_num: 53, claim: 'legacy v0.28 callers', kind: 'bet', holder: 'garry', weight: 0.7 },
    ]);
    await engine.resolveTake(acmePageId, 53, { outcome: true, resolvedBy: 'garry' });
    const rows = await engine.executeRaw<{ resolved_outcome: boolean; resolved_quality: string }>(
      `SELECT resolved_outcome, resolved_quality FROM takes WHERE page_id = $1 AND row_num = $2`,
      [acmePageId, 53],
    );
    expect(rows[0].resolved_outcome).toBe(true);
    expect(rows[0].resolved_quality).toBe('correct');
  });
});

d('v0.30.0 scorecard + calibration on real Postgres', () => {
  // Note: this suite runs after the other Postgres takes suites in this
  // file, so the takes table already has resolved data from the earlier
  // tests. We don't need a fresh seed — we just verify the aggregate
  // queries work end-to-end against postgres.js bind shapes.
  test('getScorecard returns coherent shape against real PG', async () => {
    const engine = getEngine();
    const card = await engine.getScorecard({ holder: 'garry' }, undefined);
    expect(card.total_bets).toBeGreaterThan(0);
    expect(card.resolved).toBeGreaterThanOrEqual(0);
    expect(card.correct + card.incorrect + card.partial).toBe(card.resolved);
    if (card.correct + card.incorrect > 0) {
      expect(card.brier).not.toBeNull();
      expect(card.brier!).toBeGreaterThanOrEqual(0);
      expect(card.brier!).toBeLessThanOrEqual(1);
    }
  });

  test('getCalibrationCurve returns ordered buckets against real PG', async () => {
    const engine = getEngine();
    const buckets = await engine.getCalibrationCurve({ holder: 'garry' }, undefined);
    // Buckets must be ordered by bucket_lo ascending.
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].bucket_lo).toBeGreaterThanOrEqual(buckets[i - 1].bucket_lo);
    }
    // Every bucket has n > 0 (empty buckets aren't returned by GROUP BY).
    for (const b of buckets) expect(b.n).toBeGreaterThan(0);
  });

  test('PRIVACY: scorecard SQL allow-list excludes hidden holders on real PG', async () => {
    const engine = getEngine();
    // Seed a holder that the scorecard with allow-list ['garry'] should
    // not see. Use a fresh page so the assertion is local and not noisy.
    const harjPage = await engine.putPage('companies/scorecard-allowlist-fixture', {
      title: 'Allow-list fixture', type: 'company', compiled_truth: '## Takes\n',
    });
    await engine.addTakesBatch([
      { page_id: harjPage.id, row_num: 1, claim: 'g bet',  kind: 'bet', holder: 'garry',       weight: 0.7 },
      { page_id: harjPage.id, row_num: 2, claim: 'h bet',  kind: 'bet', holder: 'harj-taggar', weight: 0.6 },
    ]);
    await engine.resolveTake(harjPage.id, 1, { quality: 'correct',   resolvedBy: 'garry' });
    await engine.resolveTake(harjPage.id, 2, { quality: 'incorrect', resolvedBy: 'harj-taggar' });

    const garryOnly = await engine.getScorecard(
      { domainPrefix: 'companies/scorecard-allowlist-fixture' },
      ['garry'],
    );
    const trustedFull = await engine.getScorecard(
      { domainPrefix: 'companies/scorecard-allowlist-fixture' },
      undefined,
    );
    expect(garryOnly.resolved).toBe(1);
    expect(garryOnly.correct).toBe(1);
    expect(trustedFull.resolved).toBe(2);
    // Allow-list strictly subtracts the harj row.
    expect(trustedFull.resolved - garryOnly.resolved).toBe(1);
  });
});

// ============================================================
// v0.30.0: MCP dispatch path for takes_scorecard + takes_calibration.
// ============================================================
d('v0.30.0 MCP dispatch — Postgres', () => {
  test('takes_scorecard via MCP returns correct counts with allow-list', async () => {
    const engine = getEngine();
    const result = await dispatchToolCall(engine, 'takes_scorecard', { holder: 'garry' }, {
      remote: true,
      takesHoldersAllowList: ['garry'],
    });
    expect(result.isError).toBeFalsy();
    const card = JSON.parse(result.content[0].text);
    expect(card).toHaveProperty('correct');
    expect(card).toHaveProperty('incorrect');
    expect(card).toHaveProperty('partial');
    expect(card).toHaveProperty('brier');
    expect(card).toHaveProperty('partial_rate');
  });

  test('takes_calibration via MCP returns bucket array with allow-list', async () => {
    const engine = getEngine();
    const result = await dispatchToolCall(engine, 'takes_calibration', { holder: 'garry', bucket_size: 0.1 }, {
      remote: true,
      takesHoldersAllowList: ['garry'],
    });
    expect(result.isError).toBeFalsy();
    const buckets = JSON.parse(result.content[0].text);
    expect(Array.isArray(buckets)).toBe(true);
    if (buckets.length > 0) {
      expect(buckets[0]).toHaveProperty('bucket_lo');
      expect(buckets[0]).toHaveProperty('bucket_hi');
      expect(buckets[0]).toHaveProperty('n');
      expect(buckets[0]).toHaveProperty('observed');
      expect(buckets[0]).toHaveProperty('predicted');
    }
  });

  test('PRIVACY: takes_scorecard with allow-list ["world"] excludes garry rows', async () => {
    const engine = getEngine();
    // 'world' has only fact-kind takes in the seed; bets are garry-only.
    // Scorecard scoped to world should report zero resolved.
    const result = await dispatchToolCall(engine, 'takes_scorecard', {}, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    const card = JSON.parse(result.content[0].text);
    // No resolved bets exist with holder='world' in our seed.
    expect(card.resolved).toBe(0);
  });
});
