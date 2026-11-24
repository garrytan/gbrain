/**
 * BrainEngine parity — the whole takes re-extract write (cycle/extract-takes.ts), start to end.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `extractTakesFromDb` and `extractTakesFromFs` read a page's takes fence, prune the stored takes that left
 *    it, keep (and contest) the ones more trusted than the page's restatement, and upsert the rest, with the same result,
 *    the same stored takes and the same owner proposals on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers one of the reconcile reads differently deletes a take the fence still states,
 *    overwrites an operator-curated take with a page restatement, or upserts into a quarantined page; the Rust engine has
 *    no SQL, so every read and write on the path has to be a typed member.
 *  - Why existing coverage misses it: the reads ran through `executeRaw` inside cycle/extract-takes.ts and
 *    trust/fence-guard.ts, which the parity cases cannot call (D18); test/extract-takes*.test.ts run PGLite only.
 *  - Rust: the write publishes a take-fence generation (generations/publish.ts `publishFenceGeneration`) and records
 *    each upserted take's taint edge (trust/taint.ts `recordTaintEdges`, the `recordDerivationEdges` member), both
 *    served by the store, so both cases are equal on the Rust arm.
 *  - Seam: `withWriteTrustSettings` stamps the operator-curated take (the transaction-local `gbrain.write_trust_tier`
 *    every arm sets with `applyTransactionSettings`). The FS path reads a markdown checkout in a temp directory.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { extractTakesFromDb, extractTakesFromFs } from '../../src/core/cycle/extract-takes.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'people/takes-example';
const HEADER = '| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|';
const fence = (rows: string[]) => `# Takes Example\n\nSome prose.\n\n## Takes\n\n${TAKES_FENCE_BEGIN}\n${HEADER}\n${rows.join('\n')}\n${TAKES_FENCE_END}\n`;

const FIRST = fence([
  '| 1 | CEO of Acme Example | fact | world | 1.0 | 2017-01 | public filing |',
  '| 2 | Strong technical founder | take | garry | 0.85 | 2026-04-29 | OH 2026-04-29 |',
  '| 3 | Will reach $50B | bet | garry | 0.7 | 2026-04-29 | OH 2026-04-29 |',
]);
// Row 1 unchanged, row 2 restated with a new claim, row 3 gone, row 4 new; row 5 (operator curated) restated with a new
// claim and row 6 (operator curated) gone, both held.
const SECOND = fence([
  '| 1 | CEO of Acme Example | fact | world | 1.0 | 2017-01 | public filing |',
  '| 2 | Strong product founder | take | garry | 0.8 | 2026-05-01 | OH 2026-05-01 |',
  '| 4 | Will raise a Series A | bet | garry | 0.6 | 2026-05-01 | OH 2026-05-01 |',
  '| 5 | Will hire a CFO next year | bet | garry | 0.4 | 2026-05-01 | OH 2026-05-01 |',
]);

/** Fixture: run `fn` with the write trust settings `names` set to `values` for one transaction. */
async function withWriteTrustSettings<T>(engine: BrainEngine, names: string[], values: string[], fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(names, values);
    return fn(tx);
  });
}

/** The page's active takes and their stored tier, by row number; ids never compare across arms. */
async function storedTakes(engine: BrainEngine, pageId: number) {
  const takes = (await engine.listActiveTakesForPages([pageId])).get(pageId) ?? [];
  const tiers = new Map((await engine.readRowTrustRows({ table: 'takes', ids: takes.map(t => Number(t.id)) })).map(r => [Number(r.id), r.trust_tier]));
  return takes.map(t => ({ row_num: t.row_num, claim: t.claim, kind: t.kind, holder: t.holder, weight: Number(Number(t.weight).toFixed(4)),
    since_date: t.since_date, source: t.source, tier: tiers.get(Number(t.id)) ?? null })).sort((a, b) => a.row_num - b.row_num);
}

/** The owner's open proposals on takes, with the claim of the take each targets in place of its id. */
async function takeProposals(engine: BrainEngine, claimOf: Map<number, string>) {
  return (await engine.listTrustProposals({ status: 'pending' })).filter(p => p.target_table === 'takes')
    .map(p => ({ action: p.action, target: claimOf.get(Number(p.target_id)) ?? `other:${p.target_id}`, proposer: p.proposer,
      change: (p.before_state as { change?: string }).change ?? null }))
    .sort((a, b) => a.target.localeCompare(b.target));
}


const summary = (r: Awaited<ReturnType<typeof extractTakesFromDb>>) => ({ scanned: r.pagesScanned, withTakes: r.pagesWithTakes, upserted: r.takesUpserted,
  warnings: r.warnings, failed: r.failedFiles, gate: r.writeGate ?? null });

describe('engine parity: the takes re-extract write', () => {
  parityTest('extractTakesFromDb projects a page fence, prunes and replaces the rows that left it, and keeps a more trusted take with a contest', {
    methods: ['putPage', 'listAllPageRefs', 'getPage', 'addTakesBatch', 'listActiveTakesForPages', 'readRowTrustRows', 'listTrustProposals'],
  }, async (engine) => {
    const page = await engine.putPage(SLUG, { type: 'person', title: 'Takes Example', compiled_truth: FIRST, timeline: '' });
    const first = summary(await extractTakesFromDb(engine, {}));
    const afterFirst = await storedTakes(engine, page.id);
    expect(afterFirst.map(t => t.claim)).toEqual(['CEO of Acme Example', 'Strong technical founder', 'Will reach $50B']);

    // An operator curates rows 5 and 6: the page's restatement (tier unknown) may neither replace nor delete them.
    await withWriteTrustSettings(engine, ['gbrain.write_trust_tier'], ['operator_curated'], tx => tx.addTakesBatch([
      { page_id: page.id, row_num: 5, claim: 'Will hire a CFO this year', kind: 'bet', holder: 'garry', weight: 0.5, since_date: '2026-04-29', source: 'operator' },
      { page_id: page.id, row_num: 6, claim: 'Will open a second office', kind: 'bet', holder: 'garry', weight: 0.5, since_date: '2026-04-29', source: 'operator' },
    ]));
    const claimOf = new Map((await engine.listActiveTakesForPages([page.id])).get(page.id)!.map(t => [Number(t.id), t.claim]));

    await engine.putPage(SLUG, { type: 'person', title: 'Takes Example', compiled_truth: SECOND, timeline: '' });
    const second = summary(await extractTakesFromDb(engine, { rebuild: true }));
    const afterSecond = await storedTakes(engine, page.id);
    expect(afterSecond.map(t => [t.row_num, t.claim, t.tier])).toEqual([
      [1, 'CEO of Acme Example', 'unknown'], [2, 'Strong product founder', 'unknown'], [4, 'Will raise a Series A', 'unknown'],
      [5, 'Will hire a CFO this year', 'operator_curated'], [6, 'Will open a second office', 'operator_curated']]);
    const proposals = await takeProposals(engine, claimOf);
    expect(proposals).toEqual([
      { action: 'forget', target: 'Will hire a CFO this year', proposer: 'takes_reextract', change: 'replaced' },
      { action: 'forget', target: 'Will open a second office', proposer: 'takes_reextract', change: 'removed' },
    ]);

    // A second identical run changes nothing and files no second proposal.
    const third = summary(await extractTakesFromDb(engine, { rebuild: true }));
    expect(await storedTakes(engine, page.id)).toEqual(afterSecond);
    expect(await takeProposals(engine, claimOf)).toEqual(proposals);
    return { first, afterFirst, second, afterSecond, proposals, third };
  });

  parityTest('extractTakesFromFs projects the checkout\'s fences onto their pages, skips a page not in the brain and a quarantined page', {
    methods: ['putPage', 'listActiveTakesForPages', 'readRowTrustRows'],
  }, async (engine) => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-parity-extract-takes-'));
    try {
      mkdirSync(join(repo, 'people'), { recursive: true });
      writeFileSync(join(repo, `${SLUG}.md`), FIRST);
      writeFileSync(join(repo, 'people/not-imported-example.md'), FIRST);
      writeFileSync(join(repo, 'people/quarantined-example.md'), FIRST);
      const page = await engine.putPage(SLUG, { type: 'person', title: 'Takes Example', compiled_truth: 'Imported.', timeline: '' });
      const quarantined = await engine.putPage('people/quarantined-example', { type: 'person', title: 'Quarantined', compiled_truth: 'Held.', timeline: '',
        frontmatter: { quarantine: { reason: 'parity fixture' } } });
      const first = summary(await extractTakesFromFs(engine, { repoPath: repo }));
      writeFileSync(join(repo, `${SLUG}.md`), SECOND);
      const second = summary(await extractTakesFromFs(engine, { repoPath: repo, rebuild: true }));
      return { first, second, takes: await storedTakes(engine, page.id), quarantined: await storedTakes(engine, quarantined.id) };
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
