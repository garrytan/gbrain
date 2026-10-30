/**
 * GBRA-190 (G4, git is the parent): dream consolidation closes a fenced fact in
 * the page's facts fence, and the database row derives from the fence cell.
 * The consolidation writeback used to close the chain with
 * `UPDATE facts SET valid_until ...` only (the managed preparer in
 * prepared-maintenance.ts), so the canonical file's fence row stayed open and
 * the next re-import of the page reopened the fact: extract-facts takes an
 * active row's valid_until from its fence cell. Now the close is written into
 * the fence row of the published page, and a re-import keeps it. An unfenced
 * fact (no fence row) is still closed in the database, as before.
 *
 * The setup comes from G5's (GBRA-60) reproduction,
 * test/consolidate-ties-fenced-reimport.test.ts on capy/gbra60-g5-lanec-tests,
 * whose control asserted the reopen. Managed brain with a durable Git repo;
 * synthetic data only. The Postgres arm runs through test/postgres-unit-arms.txt.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { performSync } from '../src/commands/sync.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const slug = 'companies/probe-example';
const VECTOR = '[' + [1, ...Array(1535).fill(0)].join(',') + ']';
const SERIES = [
  { claim: 'The deposit amount is $100,000.', value: 100000, from: '2026-01-01', confidence: 1 },
  { claim: 'The deposit amount is $82,000.', value: 82000, from: '2026-02-01', confidence: 0.9 },
  { claim: 'The deposit amount is $90,000.', value: 90000, from: '2026-03-01', confidence: 0.8 },
];
const UNFENCED = { claim: 'The deposit amount was first quoted as $120,000.', value: 120000, from: '2025-12-01T00:00:00Z' };
const typed = (rowNum: number, s: typeof SERIES[number]): ParsedFact => ({
  rowNum, claim: s.claim, kind: 'fact', confidence: s.confidence, visibility: 'world', notability: 'medium', validFrom: s.from, source: 'synthetic fixture', active: true,
  claimMetric: 'deposit_amount', claimValue: s.value, claimUnit: 'USD', claimPeriod: '2026-01-01',
});
const content = (prose: string) => `---\ntype: company\ntitle: Probe Example\n---\n\n# Probe Example\n\n${prose}\n\n## Facts\n\n`
  + `${renderFactsTable(SERIES.map((s, i) => typed(i + 1, s)))}\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const file = (root: string) => join(root, `${slug}.md`);
const cells = (root: string) => new Map(parseFactsFence(readFileSync(file(root), 'utf8')).facts.map(f => [f.rowNum, f]));

const factRows = async (engine: BrainEngine) => (await engine.executeRaw<{ id: number; fact: string; row_num: number | null; valid_until: string | null;
  expired_at: string | null; consolidated_into: number | null }>(
  `SELECT id, fact, row_num, valid_until::text AS valid_until, expired_at::text AS expired_at, consolidated_into
     FROM facts WHERE source_id='default' AND entity_slug=$1 ORDER BY id`, [slug]))
  .map(r => ({ ...r, id: Number(r.id), row_num: r.row_num === null ? null : Number(r.row_num), consolidated_into: r.consolidated_into === null ? null : Number(r.consolidated_into) }));
const byClaim = async (engine: BrainEngine, claim: string) => (await factRows(engine)).find(r => r.fact === claim && r.expired_at === null)!;
const at = (value: string | null) => (value === null ? null : Date.parse(value));

/**
 * The page with its three typed fence rows, published and committed; embeddings for clustering; one unfenced fact of
 * the same metric, older than the series. The embeddings and the unfenced row are fixture data written with the
 * brain's managed mode off, as the #6023 managed test seeds its facts.
 */
async function seed(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: content('Body.') } });
  await settleManagedGitEffects(engine);
  expect((await factRows(engine)).map(r => [r.fact, r.row_num])).toEqual(SERIES.map((s, i) => [s.claim, i + 1]));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    await engine.executeRaw(`UPDATE facts SET embedding=$2::vector, embedded_at=now(), embedding_model='openai:text-embedding-3-large', embedded_text_hash=md5(fact)
      WHERE source_id='default' AND entity_slug=$1`, [slug, VECTOR]);
    await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,valid_from,confidence,embedding,embedded_at,embedding_model,
        embedded_text_hash,claim_metric,claim_unit,claim_period,claim_value)
      VALUES('default',$1,$2,'fact','synthetic fixture','world',$3::timestamptz,0.7,$4::vector,now(),'openai:text-embedding-3-large',md5($2),
        'deposit_amount','USD','2026-01-01',$5)`, [slug, UNFENCED.claim, UNFENCED.from, VECTOR, UNFENCED.value]);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
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

  describe(`consolidation closes a fenced fact in its fence (${backend})`, () => {
    test('the close lands in the fence cell, the row derives from it, and a re-import keeps the fact closed', () => managedBrain(async ({ engine, ctx, root }) => {
      await seed(engine, ctx);
      const result = await runPhaseConsolidate(engine, { sourceId: 'default', minOldestAgeMs: 0 });
      expect(result.details).toMatchObject({ facts_consolidated: 4, takes_written: 1, buckets_failed: 0 });
      await settleManagedGitEffects(engine);

      const closed = await factRows(engine);
      expect(at((await byClaim(engine, SERIES[0].claim)).valid_until)).toBe(Date.parse(SERIES[1].from));
      expect(at((await byClaim(engine, SERIES[1].claim)).valid_until)).toBe(Date.parse(SERIES[2].from));
      expect((await byClaim(engine, SERIES[2].claim)).valid_until).toBeNull();
      // The unfenced fact has no fence row: it is closed in the database, as before.
      expect(at((await byClaim(engine, UNFENCED.claim)).valid_until)).toBe(Date.parse(SERIES[0].from));
      expect(closed.every(r => r.consolidated_into !== null)).toBe(true);
      expect(git(root, 'status', '--porcelain', '--', `${slug}.md`).trim()).toBe('');

      // The file is the parent: re-importing it keeps every close.
      await reimport(engine, root, 'Edited once.');
      expect(await factRows(engine)).toEqual(closed);
      const fence = cells(root);
      expect(fence.get(1)).toMatchObject({ claim: SERIES[0].claim, active: true, validUntil: SERIES[1].from });
      expect(fence.get(2)).toMatchObject({ claim: SERIES[1].claim, active: true, validUntil: SERIES[2].from });
      expect(fence.get(3)).toMatchObject({ claim: SERIES[2].claim, active: true });
      expect(fence.get(3)!.validUntil).toBeUndefined();
      expect(fence.has(4)).toBe(false);
    }, { setup, databaseUrl }), 180_000);

    test('a fenced fact whose fence is on another page stays open in its file and in the database', () => managedBrain(async ({ engine, ctx, root }) => {
      await seed(engine, ctx);
      const other = 'companies/other-example';
      const moved: ParsedFact = { ...typed(1, { claim: 'The deposit amount was set at $95,000.', value: 95000, from: '2025-11-01', confidence: 0.6 }) };
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: other, request_id: randomUUID(),
        content: `---\ntype: company\ntitle: Other Example\n---\n\n# Other Example\n\n## Facts\n\n${renderFactsTable([moved])}\n` } });
      await settleManagedGitEffects(engine);
      const otherFile = readFileSync(join(root, `${other}.md`), 'utf8');
      // The fact now names this entity while its fence row stays on the other page (as a rename alias or twin merge leaves it).
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try {
        await engine.executeRaw(`UPDATE facts SET entity_slug=$1, embedding=$3::vector, embedded_at=now(), embedding_model='openai:text-embedding-3-large',
          embedded_text_hash=md5(fact) WHERE source_id='default' AND source_markdown_slug=$2`, [slug, other, VECTOR]);
      } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }

      const result = await runPhaseConsolidate(engine, { sourceId: 'default', minOldestAgeMs: 0 });
      expect(result.details).toMatchObject({ facts_consolidated: 5, takes_written: 1, buckets_failed: 0 });
      await settleManagedGitEffects(engine);
      const kept = await byClaim(engine, moved.claim);
      expect(kept).toMatchObject({ row_num: 1, valid_until: null });
      expect(kept.consolidated_into).not.toBeNull();
      expect(readFileSync(join(root, `${other}.md`), 'utf8')).toBe(otherFile);
      expect(at((await byClaim(engine, UNFENCED.claim)).valid_until)).toBe(Date.parse(SERIES[0].from));
      expect(cells(root).get(1)!.validUntil).toBe(SERIES[1].from);
    }, { setup, databaseUrl }), 180_000);
  });
}
