/**
 * #5728: the v0.28.0 takes backfill on a managed brain.
 *
 * Protects: on a managed brain the migration's backfill phase completes, projects
 * each page's takes fence into `takes` in every source (pruning rows that left
 * the fence), keeps resolutions that live only in the database, and leaves rows
 * the canonical publication already wrote exactly as they were.
 * Fails when: the backfill writes `takes` outside the persistence coordinator or
 * under the wrong source (the guard trigger refuses it and the orchestrator
 * chain wedges), or when it overwrites the canonical `superseded_by` or a
 * database-only resolution.
 * Existing coverage: extract-takes.test.ts runs on unmanaged brains only.
 * Seams: none; `managedBrain` and the migration's exported `__testing` phases.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { __testing } from '../src/commands/migrations/v0_28_0.ts';
import type { OrchestratorOpts } from '../src/commands/migrations/types.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { renderTakesFence, type ParsedTake } from '../src/core/takes-fence.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'people/alice-example';
const FENCE_TAKES: ParsedTake[] = [
  { rowNum: 1, claim: 'Acme example raised a seed round', kind: 'fact', holder: 'world', weight: 1, sinceDate: '2026-01', source: 'press note', active: true },
  { rowNum: 2, claim: 'Widget co ships in Q3', kind: 'bet', holder: 'people/alice-example', weight: 0.6, sinceDate: '2026-02', source: 'superseded by #3', active: false },
  { rowNum: 3, claim: 'Widget co ships in Q4', kind: 'bet', holder: 'people/alice-example', weight: 0.7, sinceDate: '2026-03', source: 'call notes', active: true },
  { rowNum: 4, claim: 'Acme example hires a CFO', kind: 'bet', holder: 'people/alice-example', weight: 0.5, sinceDate: '2026-01', source: 'call notes', active: true,
    resolvedAt: '2026-06-01', resolvedQuality: 'correct', resolvedEvidence: 'launch post', resolvedBy: 'people/alice-example' },
];
const OTHER_SOURCE = 'notes-example';
const OTHER_SLUG = 'people/carol-example';
const OTHER_BODY = `# Carol Example\n\n## Takes\n\n${renderTakesFence([{ rowNum: 1, claim: 'Widget co opens a second office',
  kind: 'bet', holder: 'people/carol-example', weight: 0.4, sinceDate: '2026-04', source: 'call notes', active: true }])}\n`;
const OPTS: OrchestratorOpts = { yes: true, dryRun: false, noAutopilotInstall: true };
const BODY = `# Alice Example\n\nSome prose.\n\n## Takes\n\n${renderTakesFence(FENCE_TAKES)}\n`;

async function takeRows(engine: BrainEngine, slug = SLUG, sourceId = 'default') {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT t.row_num, t.claim, t.kind, t.holder, t.weight, t.since_date, t.source, t.active, t.superseded_by,
            t.resolved_at, t.resolved_quality, t.resolved_outcome, t.resolved_source, t.resolved_by
       FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 AND p.source_id = $2 ORDER BY t.row_num`, [slug, sourceId]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: legacy pages in every source get their fenced takes projected, stale rows pruned, database-only resolutions kept`, async () => {
    await managedBrain(async ({ engine }) => {
      const phase = await __testing.phaseBBackfill(engine, OPTS);
      expect(phase).toMatchObject({ name: 'backfill', status: 'complete' });
      expect(phase.detail).toBe('extract-takes scanned 3 pages; 2 had fenced takes; upserted 5 rows');
      const rows = await takeRows(engine);
      expect(rows.map(r => r.row_num)).toEqual([1, 2, 3, 4]);
      expect(rows[1]).toMatchObject({ active: false, superseded_by: 3 });
      expect(rows[2]).toMatchObject({ resolved_quality: 'correct', resolved_source: 'grader note', resolved_by: 'people/alice-example' });
      expect((await takeRows(engine, OTHER_SLUG, OTHER_SOURCE)).map(r => r.row_num)).toEqual([1]);
    }, { databaseUrl, setup: async ({ engine }) => {
      // Imported before activation: the legacy import does not project a fence.
      // The index still holds a row that has since left the fence (9) and a take
      // graded only in the database (3). A page without a fence gets no
      // coordinated write, and a page in a second source writes under its own.
      const page = await engine.putPage(SLUG, { title: 'Alice Example', type: 'person', compiled_truth: BODY });
      await engine.putPage('people/bob-example', { title: 'Bob Example', type: 'person', compiled_truth: '# Bob Example\n\nNo takes here.\n' });
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, 'Notes example')`, [OTHER_SOURCE]);
      await engine.putPage(OTHER_SLUG, { title: 'Carol Example', type: 'person', compiled_truth: OTHER_BODY }, { sourceId: OTHER_SOURCE });
      await engine.addTakesBatch([
        { page_id: page.id, row_num: 3, claim: 'Widget co ships in Q4', kind: 'bet', holder: 'people/alice-example',
          weight: 0.7, since_date: '2026-03', source: 'call notes', active: true, superseded_by: null },
        { page_id: page.id, row_num: 9, claim: 'Removed from the fence', kind: 'take',
          holder: 'world', weight: 0.5, source: 'old', active: true, superseded_by: null },
      ]);
      await engine.resolveTake(page.id, 3, { quality: 'correct', source: 'grader note', resolvedBy: 'people/alice-example' });
    } });
  }, 120_000);

  test(`${backend}: rows the canonical publication already projected stay unchanged`, async () => {
    await managedBrain(async ({ ctx, engine }) => {
      const receipt = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(),
        content: `---\ntype: person\ntitle: Alice Example\n---\n\n${BODY}` } }) as { state: string };
      expect(receipt.state).toBe('committed');
      const projected = await takeRows(engine);
      expect(projected.map(r => r.row_num)).toEqual([1, 2, 3, 4]);
      expect(projected[1]).toMatchObject({ superseded_by: 3 });

      const phase = await __testing.phaseBBackfill(engine, OPTS);
      expect(phase).toMatchObject({ name: 'backfill', status: 'complete' });
      expect(await takeRows(engine)).toEqual(projected);
    }, { databaseUrl });
  }, 120_000);
}
