/**
 * #5886 follow-up: `gbrain repair take-supersession` rebuilds
 * `takes.superseded_by` for chains written before the pointer moved onto the
 * old fence row.
 *
 * Protects: a broken chain (struck rows without a pointer, new rows citing
 * themselves) is relinked only from evidence — a committed takes_supersede
 * receipt, a stored superseded_by, or a self-pointer row with exactly one
 * possible predecessor — through a revision-bound put_page whose projection
 * stores superseded_by; a page with two possible predecessors is reported
 * with the manual edit and never changed; the preview writes nothing; a
 * second apply changes nothing; a page whose fence is already right but whose
 * stored pointers were cleared is reprojected.
 * Fails when: the kind is missing, when it guesses a link the evidence does
 * not force, when it rewrites an ambiguous page, or when a rerun rewrites
 * a repaired page again.
 * Why existing coverage misses it: test/takes-supersede-pointer.test.ts covers
 * new supersessions only; nothing repairs chains already stored.
 * Seams: none; real PGLite (and Postgres through the e2e registration), the
 * shared `managedBrain`, and the same repair runner `gbrain repair` uses.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { claimWorktree, managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { analyzeSupersession } from '../src/core/repair/take-supersession.ts';
import { parseTakesFence, renderTakesFence, type ParsedTake } from '../src/core/takes-fence.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const take = (rowNum: number, claim: string, active: boolean, source?: string): ParsedTake =>
  ({ rowNum, claim, kind: 'bet', holder: 'world', weight: 0.6, active, ...(source !== undefined ? { source } : {}) });

const page = (title: string, takes: ParsedTake[]) =>
  `---\ntype: note\ntitle: ${title}\n---\n# ${title}\n\nProse.\n\n## Takes\n\n${renderTakesFence(takes)}\n`;

/** 1 -> 2 -> 3 written by the old supersedeRow: struck rows cite nothing, each new row cites itself. */
const CHAIN = [
  take(1, 'Widget co ships in Q3', false, 'call notes'),
  take(2, 'Widget co ships in Q4', false, 'superseded by #2'),
  take(3, 'Widget co ships in Q1', true, 'superseded by #3'),
  take(4, 'Acme example hires a CFO', true, 'board memo'),
];
/** Two struck rows and two self-pointer rows: either pairing is possible. */
const AMBIGUOUS = [
  take(1, 'Acme example raises a seed round', false, 'press'),
  take(2, 'Acme example hires a COO', false),
  take(3, 'Acme example raises a Series A', true, 'superseded by #3'),
  take(4, 'Acme example hires a CTO', true, 'superseded by #4'),
];

const submit = (ctx: OperationContext, operation: string, params: Record<string, unknown>) =>
  submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } }) as Promise<Record<string, unknown>>;

async function takeRows(engine: BrainEngine, sourceId: string, slug: string) {
  return engine.executeRaw<{ row_num: number; active: boolean; source: string | null; superseded_by: number | null }>(
    `SELECT t.row_num, t.active, t.source, t.superseded_by FROM takes t JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 ORDER BY t.row_num`, [sourceId, slug]);
}

async function fenceOf(engine: BrainEngine, sourceId: string, slug: string) {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  return parseTakesFence(snapshot.page.compiled_truth).takes.map(t => [t.rowNum, t.active, t.source ?? '']);
}

async function repair(engine: BrainEngine, apply: boolean) {
  const runner = await repairRunner(engine, { apply, logger: { info() {}, warn() {}, error() {} } });
  return runner.run('take-supersession', await resolveRepairScope(engine));
}

describe('analyzeSupersession', () => {
  test('a chain of self-pointer rows resolves hop by hop; the pointer lands after the old row\'s own provenance', () => {
    const result = analyzeSupersession(CHAIN, { journal: [], database: [] });
    expect(result.ambiguous).toEqual([]);
    expect(result.links).toEqual([
      { old_row: 1, new_row: 2, evidence: 'fence_structure' },
      { old_row: 2, new_row: 3, evidence: 'fence_structure' },
    ]);
    expect(result.takes.map(t => [t.rowNum, t.source ?? ''])).toEqual([
      [1, 'call notes; superseded by #2'], [2, 'superseded by #3'], [3, ''], [4, 'board memo']]);
  });

  test('two possible predecessors are ambiguous and change nothing; one piece of evidence resolves the rest', () => {
    const open = analyzeSupersession(AMBIGUOUS, { journal: [], database: [] });
    expect(open).toMatchObject({ links: [], self_pointers: [], fence_changed: false,
      ambiguous: [{ new_row: 3, candidates: [1, 2] }, { new_row: 4, candidates: [1, 2] }] });
    expect(open.takes).toBe(AMBIGUOUS);

    const stored = analyzeSupersession(AMBIGUOUS, { journal: [], database: [[1, 3]] });
    expect(stored.ambiguous).toEqual([]);
    expect(stored.links).toEqual([{ old_row: 1, new_row: 3, evidence: 'database' }, { old_row: 2, new_row: 4, evidence: 'fence_structure' }]);
  });

  test('conflicting evidence is ambiguous; a pointer already in the fence wins over stale evidence', () => {
    expect(analyzeSupersession(AMBIGUOUS, { journal: [[1, 3], [1, 4]], database: [] }).ambiguous)
      .toEqual([{ new_row: 3, candidates: [1] }, { new_row: 4, candidates: [1] }]);
    const fenced = [take(1, 'A', false, 'superseded by #2'), take(2, 'B', true)];
    expect(analyzeSupersession(fenced, { journal: [[1, 2]], database: [[1, 2]] })).toMatchObject({ links: [], ambiguous: [], fence_changed: false });
  });

  test('a struck row citing another row, or a dangling pointer, is never rewritten', () => {
    const takes = [take(1, 'A', false, 'superseded by #9'), take(2, 'B', true, 'superseded by #2')];
    const result = analyzeSupersession(takes, { journal: [], database: [] });
    expect(result.links).toEqual([]);
    expect(result.takes.map(t => t.source ?? '')).toEqual(['superseded by #9', '']);
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: managed: a broken chain is relinked, an ambiguous page is reported untouched, preview writes nothing and a second apply is a no-op`, async () => {
    await managedBrain(async ({ engine, ctx, root }) => {
      expect(await managedPersistenceEnabled(engine)).toBe(true);
      await submit(ctx, 'put_page', { slug: 'notes/chain', content: page('Chain', CHAIN) });
      await submit(ctx, 'put_page', { slug: 'notes/ambiguous', content: page('Ambiguous', AMBIGUOUS) });
      // A real supersession whose fence an old binary then rewrote into the old shape: only the journal knows the link.
      await submit(ctx, 'put_page', { slug: 'notes/journal', content: page('Journal', [take(1, 'Widget co hires', true, 'memo'), take(2, 'Widget co raises', true, 'deck')]) });
      expect(await submit(ctx, 'takes_supersede', { slug: 'notes/journal', row_num: 2, claim: 'Widget co raises more' })).toMatchObject({ state: 'committed', old_row: 2, new_row: 3 });
      await submit(ctx, 'put_page', { slug: 'notes/journal', content: page('Journal', [take(1, 'Widget co hires', false, 'memo'),
        take(2, 'Widget co raises', false, 'deck'), take(3, 'Widget co raises more', true, 'superseded by #3')]),
      expected_revision: (await engine.readPageSnapshot('notes/journal', { sourceId: 'default' }))!.revision });

      expect((await takeRows(engine, 'default', 'notes/chain')).map(r => r.superseded_by)).toEqual([null, 2, null, null]);
      expect((await takeRows(engine, 'default', 'notes/journal')).map(r => r.superseded_by)).toEqual([null, null, null]);

      const revisions = async () => Promise.all(['notes/chain', 'notes/ambiguous', 'notes/journal'].map(async slug =>
        (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision));
      const requests = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0].n;
      const before = { revisions: await revisions(), requests: await requests(), chain: await takeRows(engine, 'default', 'notes/chain') };

      const preview = await repair(engine, false);
      expect(preview).toMatchObject({ mode: 'dry_run', affected: 2, residuals: { links: 3, ambiguous_pages: 1, ambiguous_rows: 2, unparsed_pages: 0 } });
      expect(preview.sample).toEqual(['default:notes/chain', 'default:notes/journal']);
      const details = preview.details as { pages: Array<{ slug: string; action: string }>; ambiguous: Array<{ source_id: string; slug: string; rows: unknown; fix: string }> };
      expect(details.pages.map(p => [p.slug, p.action])).toEqual([
        ['notes/chain', 'link #1->#2 (fence_structure); link #2->#3 (fence_structure); drop self-pointer on #2, #3'],
        ['notes/journal', 'link #2->#3 (journal); drop self-pointer on #3'],
      ]);
      expect(details.ambiguous).toEqual([{ source_id: 'default', slug: 'notes/ambiguous',
        rows: [{ new_row: 3, candidates: [1, 2] }, { new_row: 4, candidates: [1, 2] }], fix: expect.stringContaining('gbrain get --source default -- notes/ambiguous') }]);
      expect(await revisions()).toEqual(before.revisions);
      expect(await requests()).toBe(before.requests);
      expect(await takeRows(engine, 'default', 'notes/chain')).toEqual(before.chain);

      const applied = await repair(engine, true);
      expect(applied).toMatchObject({ mode: 'apply', applied: 2, skipped: 0, complete: true, outcomes: { repaired: 2 } });
      expect((await takeRows(engine, 'default', 'notes/chain')).map(r => [r.row_num, r.active, r.source ?? '', r.superseded_by])).toEqual([
        [1, false, 'call notes; superseded by #2', 2],
        [2, false, 'superseded by #3', 3],
        [3, true, '', null],
        [4, true, 'board memo', null],
      ]);
      expect((await takeRows(engine, 'default', 'notes/journal')).map(r => [r.row_num, r.superseded_by])).toEqual([[1, null], [2, 3], [3, null]]);
      expect(await fenceOf(engine, 'default', 'notes/ambiguous')).toEqual(AMBIGUOUS.map(t => [t.rowNum, t.active, t.source ?? '']));
      const file = readFileSync(join(root, 'notes/chain.md'), 'utf8');
      expect(parseTakesFence(file).takes.map(t => t.source ?? '')).toEqual(['call notes; superseded by #2', 'superseded by #3', '', 'board memo']);

      const afterApply = { revisions: await revisions(), requests: await requests() };
      const second = await repair(engine, true);
      expect(second).toMatchObject({ affected: 0, applied: 0, residuals: { links: 0, ambiguous_pages: 1 } });
      expect(await revisions()).toEqual(afterApply.revisions);
      expect(await requests()).toBe(afterApply.requests);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a page whose fence is right but whose stored pointers were cleared is reprojected, managed and unmanaged`, async () => {
    const fence = [take(1, 'Widget co ships in Q3', false, 'call notes; superseded by #2'), take(2, 'Widget co ships in Q4', true, 'call notes')];
    const clearPointers = (write: (fn: (tx: BrainEngine) => Promise<unknown>) => Promise<unknown>) =>
      write(tx => tx.executeRaw(`UPDATE takes SET superseded_by = NULL WHERE page_id = (SELECT id FROM pages WHERE source_id = 'default' AND slug = 'notes/reproject')`));
    const check = async (engine: BrainEngine) => {
      const revision = (await engine.readPageSnapshot('notes/reproject', { sourceId: 'default' }))!.revision;
      expect((await takeRows(engine, 'default', 'notes/reproject')).map(r => r.superseded_by)).toEqual([null, null]);
      const applied = await repair(engine, true);
      expect(applied).toMatchObject({ applied: 1, outcomes: { reprojected: 1 } });
      expect((await takeRows(engine, 'default', 'notes/reproject')).map(r => r.superseded_by)).toEqual([2, null]);
      expect((await engine.readPageSnapshot('notes/reproject', { sourceId: 'default' }))!.revision).toBe(revision);
      expect(await repair(engine, true)).toMatchObject({ affected: 0, applied: 0 });
    };

    await managedBrain(async ({ engine, ctx }) => {
      await submit(ctx, 'put_page', { slug: 'notes/reproject', content: page('Reproject', fence) });
      await clearPointers(fn => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION)));
      await check(engine);
    }, { databaseUrl });

    const home = mkdtempSync(join(tmpdir(), 'gbrain-take-supersession-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          const root = join(home, 'brain'); mkdirSync(root);
          await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
          await claimWorktree(engine, 'default', root);
          const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false,
            dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
          await submit(ctx, 'put_page', { slug: 'notes/reproject', content: page('Reproject', fence) });
          expect(await managedPersistenceEnabled(engine)).toBe(false);
          await clearPointers(fn => maintenanceTransaction(engine, fn));
          await check(engine);
        } finally { await disposePersistenceConsumer(engine); await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);

  test(`${backend}: #8020: a page that quotes the takes marker in code is repaired, not skipped as unparsed`, async () => {
    await managedBrain(async ({ engine, ctx }) => {
      const quoted = page('Quoted', CHAIN).replace('Prose.', 'Writers quote the opener as `<!--- gbrain:takes:begin -->` when they explain the format.');
      await submit(ctx, 'put_page', { slug: 'notes/quoted', content: quoted });
      expect(parseTakesFence((await engine.readPageSnapshot('notes/quoted', { sourceId: 'default' }))!.page.compiled_truth).takes).toHaveLength(4);
      const preview = await repair(engine, false);
      expect(preview).toMatchObject({ mode: 'dry_run', affected: 1, residuals: { links: 2, unparsed_pages: 0 } });
      expect(await repair(engine, true)).toMatchObject({ applied: 1, outcomes: { repaired: 1 } });
      expect((await takeRows(engine, 'default', 'notes/quoted')).map(r => r.superseded_by)).toEqual([2, 3, null, null]);
      expect((await engine.readPageSnapshot('notes/quoted', { sourceId: 'default' }))!.page.compiled_truth).toContain('`<!--- gbrain:takes:begin -->`');
    }, { databaseUrl });
  }, 120_000);
}
