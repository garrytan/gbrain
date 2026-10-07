/**
 * Foundations 2 (Lane C) cycle and synthesis attribution on an unmanaged
 * brain: the unmanaged writes of the dream provenance stamp, extract_atoms
 * (completion stamp and stale atom retirement), the drift report, grade_takes
 * auto-resolution, phantom redirect, consolidate, the dream summary page,
 * BrainWriter, saved `think` results, extraction receipts and the expiry of
 * facts whose page was soft-deleted run in maintenanceTransaction. Pages they
 * write or advance name the local maintenance principal; rows they change keep
 * their creator and move their last writer.
 *
 * Protects the cycle writer family in docs/architecture/system-of-record.md.
 * Fails if any of those writers runs outside maintenanceTransaction. Runs on
 * PGLite, and on Postgres (direct and transaction-mode PgBouncer) through
 * test/e2e/write-attribution-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { stampDreamProvenance } from '../src/core/cycle/dream-provenance.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runPhaseDrift } from '../src/core/cycle/drift.ts';
import { runPhaseGradeTakes } from '../src/core/cycle/grade-takes.ts';
import { tryRedirectPhantom } from '../src/core/cycle/phantom-redirect.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { __testing as synthesizeTesting } from '../src/core/cycle/synthesize.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { BrainWriter } from '../src/core/output/writer.ts';
import { persistSynthesis, type ThinkResult } from '../src/core/think/index.ts';
import { writeReceipt } from '../src/core/extract/receipt-writer.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { CREATOR_ACTOR, asCreator, revisionActor, rowActors, unmanagedBrain, type Actor, type UnmanagedBrain } from './helpers/unmanaged-attribution.ts';

const engines: BrainEngine[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-write-attribution-cycle-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };
const VECTOR_TEXT = `[${[1, ...new Array(1535).fill(0)].join(',')}]`;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(scratch, { recursive: true, force: true });
});

const actors = (rows: Array<{ id: number; created: Actor; last: Actor }>) => rows.map(({ created, last }) => ({ created, last }));
async function creatorPage(brain: UnmanagedBrain, slug: string, page: { type?: string; title?: string; compiled_truth?: string; frontmatter?: Record<string, unknown> } = {}) {
  return asCreator(brain.engine, tx => tx.putPage(slug, { type: (page.type ?? 'note') as never, title: page.title ?? slug, compiled_truth: page.compiled_truth ?? 'A page.',
    frontmatter: page.frontmatter ?? {} }, { sourceId: brain.sourceId }));
}
const ctx = (brain: UnmanagedBrain): OperationContext => ({ engine: brain.engine, config: { engine: brain.engine.kind } as never, logger: quiet as never,
  dryRun: false, remote: false, sourceId: brain.sourceId });

describe('cycle and synthesis writers on an unmanaged brain', () => {
  test('the dream provenance stamp advances the page revision under the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await creatorPage(brain, 'wiki/dream-output-example');
      await stampDreamProvenance(engine, [{ slug: 'wiki/dream-output-example', source_id: brain.sourceId }], '2026-09-01');
      expect(await revisionActor(engine, brain.sourceId, 'wiki/dream-output-example')).toEqual(brain.maintenance);
    }
  }, 120_000);

  test('extract_atoms stamps its completed atoms and retires stale atoms under the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const source = 'writings/essay-example';
      await creatorPage(brain, source, { compiled_truth: 'A long essay with extractable claims.' });
      const stale = 'atoms/2026-01-01/retired-example';
      await creatorPage(brain, stale, { type: 'atom', compiled_truth: 'An older claim.', frontmatter: { type: 'atom', source_slug: source, source_hash: 'aaaaaaaaaaaaaaaa' } });
      const chat = async (): Promise<ChatResult> => ({
        text: '[{"title":"Prototypes beat renders","atom_type":"insight","body":"Buyers want tangible prototypes."}]',
        blocks: [{ type: 'text', text: '' }], stopReason: 'end', model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
        usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
      });
      const [stored] = await engine.executeRaw<{ content_hash: string }>('SELECT content_hash FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, source]);

      const result = await runPhaseExtractAtoms(engine, { sourceId: brain.sourceId, _transcripts: [], _chat: chat as never,
        _pages: [{ slug: source, content: 'A long essay with extractable claims.', contentHash: stored.content_hash }] });

      expect(result.details?.atoms_extracted).toBe(1);
      const atoms = await engine.executeRaw<{ slug: string; deleted: boolean }>(`SELECT slug, deleted_at IS NOT NULL AS deleted FROM pages
        WHERE source_id=$1 AND type='atom' ORDER BY slug`, [brain.sourceId]);
      expect(atoms.find(atom => atom.slug === stale)?.deleted).toBe(true);
      for (const atom of atoms) expect(await revisionActor(engine, brain.sourceId, atom.slug)).toEqual(brain.maintenance);
    }
  }, 120_000);

  test('the drift report page names the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const page = await creatorPage(brain, 'people/erin-example', { type: 'person' });
      await asCreator(engine, async tx => {
        await tx.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Careful operator', kind: 'take', holder: 'world', weight: 0.6 }]);
        await tx.executeRaw(`INSERT INTO timeline_entries (page_id, date, source, summary) VALUES ($1, '2030-01-15', 'meeting', 'Changed roles')`, [page.id]);
      });
      await engine.setConfig('dream.drift.enabled', 'true');
      await engine.setConfig('models.drift', 'anthropic:claude-sonnet-4-6');
      const result = await runPhaseDrift(engine, { dryRun: false, cycleDate: '2030-01-20', auditPath: join(scratch, `drift-${brain.sourceId}.jsonl`),
        judge: async () => ({ drifted: true, confidence: 0.9, reasoning: 'moved' }) });
      await engine.setConfig('dream.drift.enabled', 'false');
      expect(result.status).toBe('complete');
      expect(await revisionActor(engine, 'default', 'reports/drift-2030-01-20')).toEqual(brain.maintenance);
    }
  }, 120_000);

  test('grade_takes auto-resolution keeps the take creator and moves its last writer', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const page = await creatorPage(brain, 'people/frank-example', { type: 'person' });
      await asCreator(engine, tx => tx.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Will ship by spring', kind: 'bet', holder: 'world', weight: 0.7, since_date: '2023-01-01' }]));
      const result = await runPhaseGradeTakes(ctx(brain), { autoResolve: true, autoResolveThreshold: 0.95,
        judge: async () => ({ verdict: 'incorrect', confidence: 0.99, reasoning: 'contradicted' }), evidenceRetriever: async () => 'example evidence' });
      expect((result.details as Record<string, unknown>).auto_applied).toBeGreaterThanOrEqual(1);
      expect(actors(await rowActors(engine, 'takes', 'page_id=$1', [page.id]))).toEqual([{ created: CREATOR_ACTOR, last: brain.maintenance }]);
    }
  }, 120_000);

  test('phantom redirect moves the phantom facts, refreshes the canonical body and retires the phantom under the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const brainDir = join(scratch, `${brain.sourceId}-phantom`);
      mkdirSync(join(brainDir, 'people'), { recursive: true });
      const fence = renderFactsTable([{ rowNum: 1, claim: 'Founded the example studio', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true }] as never);
      const phantomBody = `# gina\n\n${fence}\n`;
      await creatorPage(brain, 'people/gina-example', { type: 'person', compiled_truth: '# gina-example\n' });
      const phantom = await creatorPage(brain, 'gina', { type: 'person', compiled_truth: phantomBody });
      writeFileSync(join(brainDir, 'gina.md'), phantomBody);
      writeFileSync(join(brainDir, 'people/gina-example.md'), '# gina-example\n');
      await asCreator(engine, tx => tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
        VALUES ($1, 'gina', 'Founded the example studio', 'fact', 'world', 'test', 1, 'gina')`, [brain.sourceId]));

      const stored = (await engine.getPage('gina', { sourceId: brain.sourceId }))!;
      const result = await withEnv({ GBRAIN_AUDIT_DIR: join(brainDir, '.audit') }, () => tryRedirectPhantom(engine, stored, brain.sourceId, brainDir, false));

      expect(result.outcome).toBe('redirected');
      expect(actors(await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId]))).toEqual([{ created: CREATOR_ACTOR, last: brain.maintenance }]);
      expect(await revisionActor(engine, brain.sourceId, 'people/gina-example')).toEqual(brain.maintenance);
      const [retired] = await engine.executeRaw<{ request: string | null; kind: string | null; id: string | null }>(`SELECT revision_write_request_id::text AS request,
        revision_principal_kind AS kind, revision_principal_id AS id FROM pages WHERE id=$1 AND deleted_at IS NOT NULL`, [phantom.id]);
      expect(retired).toEqual(brain.maintenance);
    }
  }, 120_000);

  test('consolidate stamps the take it writes and the facts it consolidates', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const page = await creatorPage(brain, 'people/hana-example', { type: 'person' });
      const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 4; i++) {
        await asCreator(engine, tx => tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, confidence, embedding, embedded_at, embedding_model, embedded_text_hash)
          VALUES ($1, 'people/hana-example', $2, 'fact', 'test', $3::timestamptz, 0.9, $4::vector, $3::timestamptz, 'openai:text-embedding-3-large', md5($2))`,
        [brain.sourceId, `hana fact ${i}`, new Date(Date.parse(old) + i * 1000).toISOString(), VECTOR_TEXT]));
      }
      const result = await runPhaseConsolidate(engine, { sourceId: brain.sourceId });
      expect(result.details.takes_written).toBe(1);
      expect(actors(await rowActors(engine, 'takes', 'page_id=$1', [page.id]))).toEqual([{ created: brain.maintenance, last: brain.maintenance }]);
      expect(actors(await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId])))
        .toEqual(new Array(4).fill({ created: CREATOR_ACTOR, last: brain.maintenance }));
    }
  }, 120_000);

  test('the dream summary page, BrainWriter pages and timeline, a saved think result and an extraction receipt name the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const brainDir = join(scratch, `${brain.sourceId}-summary`);
      mkdirSync(brainDir, { recursive: true });
      const writeSummaryPage = (synthesizeTesting as unknown as { writeSummaryPage: (engine: BrainEngine, brainDir: string, slug: string, date: string,
        written: string[], children: Array<{ jobId: number; status: string }>, sourceId?: string) => Promise<void> }).writeSummaryPage;
      await writeSummaryPage(engine, brainDir, 'dream-cycle-summaries/2026-09-02', '2026-09-02', [], [], brain.sourceId);
      expect(await revisionActor(engine, brain.sourceId, 'dream-cycle-summaries/2026-09-02')).toEqual(brain.maintenance);

      const writer = new BrainWriter(engine, { strictMode: 'off', sourceId: brain.sourceId });
      const { result: slug } = await writer.transaction(async tx => {
        const created = await tx.createEntity({ desiredSlug: 'people/ivan-example', displayName: 'Ivan', type: 'person', compiledTruth: 'A person.' });
        await tx.appendTimeline(created, { date: '2026-09-02', source: 'test', summary: 'Joined the example team' } as never);
        return created;
      }, { config: {}, logger: { ...quiet, debug() {} }, requestId: 'lane-c', remote: false } as never);
      expect(await revisionActor(engine, brain.sourceId, slug)).toEqual(brain.maintenance);
      expect(actors(await rowActors(engine, 'timeline_entries', 'page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [brain.sourceId, slug])))
        .toEqual([{ created: brain.maintenance, last: brain.maintenance }]);

      const saved = await persistSynthesis(engine, { question: 'What changed for the example team?', answer: 'The team grew.', citations: [], gaps: [],
        pagesGathered: 0, takesGathered: 0, graphHits: 0, modelUsed: 'test:stub', rounds: 1, warnings: [], synthesisOk: true } as unknown as ThinkResult, { sourceId: brain.sourceId });
      expect(await revisionActor(engine, brain.sourceId, saved.slug)).toEqual(brain.maintenance);

      const receipt = await writeReceipt(engine, { kind: 'extract_facts', source_id: brain.sourceId, run_id: `run-${brain.sourceId}`, round: 'trial',
        extracted_at: '2026-09-02T00:00:00.000Z', total_rows: 1, cost_usd: 0 });
      expect(await revisionActor(engine, brain.sourceId, receipt.slug)).toEqual(brain.maintenance);
    }
  }, 120_000);

  test('extract_facts expires the facts of a soft-deleted page, keeping their creator', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const slug = 'people/jo-example';
      const fence = renderFactsTable([{ rowNum: 1, claim: 'Runs the example lab', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }] as never);
      await creatorPage(brain, slug, { type: 'person', compiled_truth: `Profile\n\n${fence}` });
      await asCreator(engine, tx => tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
        VALUES ($1, $2, 'Runs the example lab', 'fact', 'world', 'test', 1, $2)`, [brain.sourceId, slug]));
      await asCreator(engine, tx => tx.softDeletePage(slug, { sourceId: brain.sourceId }));

      const result = await runExtractFacts(engine, { sourceId: brain.sourceId, slugs: [] });

      expect(result.factsExpiredForDeletedPages).toBe(1);
      expect(actors(await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId]))).toEqual([{ created: CREATOR_ACTOR, last: brain.maintenance }]);
    }
  }, 120_000);
});
