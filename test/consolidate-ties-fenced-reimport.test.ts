/**
 * G5 lane C (#6023 follow-up): `gbrain repair consolidate-ties` on a fenced
 * fact is a projection repair. The pre-#6023 consolidation writeback closed a
 * tied fact in the database only (`UPDATE facts SET valid_until ...` in the
 * managed preparer and the unmanaged writer, never a fence edit), so the
 * canonical file's fence row never carried the close. The database-only
 * restore therefore makes the row equal to what a re-import of the file
 * projects, and the restored fact stays restored after the page is
 * re-imported from its committed file. The control shows the file is the
 * parent: re-importing the same file without the repair also reopens the
 * fact. Managed brain with a durable Git repo; synthetic data only. Postgres
 * runs through test/e2e/consolidate-ties-fenced-reimport-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { performSync } from '../src/commands/sync.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { consolidateTiesRepair } from '../src/core/repair/consolidate-ties.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const slug = 'companies/probe-example';
const ORIGINAL = 'The deposit amount was initially reported as $100,000.';
const CORRECTION = 'Correction: the deposit amount is $82,000, replacing the initially reported $100,000.';
const typed = (rowNum: number, claim: string, value: number, confidence: number): ParsedFact => ({
  rowNum, claim, kind: 'fact', confidence, visibility: 'world', notability: 'medium', validFrom: '2026-01-01', source: 'synthetic fixture', active: true,
  claimMetric: 'deposit_amount', claimValue: value, claimUnit: 'USD', claimPeriod: '2026-01-01',
});
const content = (prose: string) => `---\ntype: company\ntitle: Probe Example\n---\n\n# Probe Example\n\n${prose}\n\n## Facts\n\n`
  + `${renderFactsTable([typed(1, ORIGINAL, 100000, 1), typed(2, CORRECTION, 82000, 0.9)])}\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const file = (root: string) => join(root, `${slug}.md`);

const factState = async (engine: BrainEngine, id: number) => (await engine.executeRaw<Record<string, unknown>>(
  `SELECT id, fact, row_num, source_markdown_slug, entity_slug, valid_from::text AS valid_from, valid_until::text AS valid_until,
          expired_at::text AS expired_at, consolidated_into, claim_metric, claim_value, claim_unit, claim_period
     FROM facts WHERE source_id='default' AND id=$1`, [id]))[0]!;

/** The page with its two tied typed rows, published and committed; a take both facts were consolidated into; the old database-only close. */
async function seedClosedTie(engine: BrainEngine, ctx: OperationContext, root: string): Promise<{ original: number; correction: number }> {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: content('Body.') } });
  await settleManagedGitEffects(engine);
  const rows = await engine.executeRaw<{ id: number; fact: string; row_num: number; source_markdown_slug: string }>(
    "SELECT id, fact, row_num, source_markdown_slug FROM facts WHERE source_id='default' AND entity_slug=$1 AND expired_at IS NULL ORDER BY row_num", [slug]);
  expect(rows.map(r => [r.fact, Number(r.row_num), r.source_markdown_slug])).toEqual([[ORIGINAL, 1, slug], [CORRECTION, 2, slug]]);
  await operationsByName.takes_add.handler(ctx, { slug, claim: ORIGINAL, kind: 'fact', holder: 'world', weight: 0.95, source: 'synthetic fixture', request_id: randomUUID() });
  await settleManagedGitEffects(engine);
  const [take] = await engine.executeRaw<{ id: number }>("SELECT t.id FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id='default' AND p.slug=$1", [slug]);
  const [original, correction] = rows.map(r => Number(r.id));
  // The pre-#6023 writeback, as prepared-maintenance.ts and consolidate.ts writeValidUntilChain ran it: database rows only, no fence edit.
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.executeRaw('UPDATE facts SET consolidated_at=now(), consolidated_into=$1 WHERE id = ANY($2::bigint[])', [take!.id, [original, correction]]);
    await tx.executeRaw('UPDATE facts SET valid_until=valid_from WHERE id=$1', [original]);
  }, TEST_WRITE_ATTRIBUTION));
  // The canonical file never carried the close: its row 1 is active with an empty valid_until cell.
  const cell = parseFactsFence(readFileSync(file(root), 'utf8')).facts.find(f => f.rowNum === 1)!;
  expect(cell).toMatchObject({ claim: ORIGINAL, active: true });
  expect(cell.validUntil).toBeUndefined();
  return { original: original!, correction: correction! };
}

/** Re-import the page from its committed file: a prose edit committed through Git, then the owner's sync. */
async function reimport(engine: BrainEngine, root: string, prose: string): Promise<void> {
  writeFileSync(file(root), readFileSync(file(root), 'utf8').replace('Body.', prose));
  git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'hand edit');
  const result = await performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
  expect(['synced', 'first_sync']).toContain(result.status);
  const [page] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  expect(page!.compiled_truth).toContain(prose);
}

beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
afterAll(() => resetGateway());

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`consolidate-ties restore of a fenced fact is a projection repair (${backend})`, () => {
    test('the restored row equals a re-import of the file and stays restored after the page is re-imported', () => managedBrain(async ({ engine, ctx, root }) => {
      const { original, correction } = await seedClosedTie(engine, ctx, root);
      const scope = await resolveRepairScope(engine);
      const preview = await runRepair(ctx, consolidateTiesRepair, scope, { apply: false, explicit: true });
      expect(preview.listing!.map(l => l.item)).toEqual([`default:${original}`]);
      const applied = await runRepair(ctx, consolidateTiesRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash });
      expect(applied.applied).toBe(1);
      const restored = await factState(engine, original);
      expect(restored).toMatchObject({ valid_until: null, expired_at: null, row_num: 1, source_markdown_slug: slug });
      expect(restored.consolidated_into).not.toBeNull();
      const partner = await factState(engine, correction);

      await reimport(engine, root, 'Edited once.');
      expect(await factState(engine, original)).toEqual(restored);
      expect(await factState(engine, correction)).toEqual(partner);
      const cell = parseFactsFence(readFileSync(file(root), 'utf8')).facts.find(f => f.rowNum === 1)!;
      expect(cell).toMatchObject({ claim: ORIGINAL, active: true });
      expect(cell.validUntil).toBeUndefined();
      expect((await runRepair(ctx, consolidateTiesRepair, scope, { apply: false, explicit: true })).affected).toBe(0);
    }, { setup, databaseUrl }), 180_000);

    test('control: the file is the parent, so re-importing it without the repair already reopens the fact', () => managedBrain(async ({ engine, ctx, root }) => {
      const { original } = await seedClosedTie(engine, ctx, root);
      expect((await factState(engine, original)).valid_until).not.toBeNull();
      await reimport(engine, root, 'Edited without the repair.');
      expect(await factState(engine, original)).toMatchObject({ valid_until: null, expired_at: null, row_num: 1, source_markdown_slug: slug });
    }, { setup, databaseUrl }), 180_000);
  });
}
