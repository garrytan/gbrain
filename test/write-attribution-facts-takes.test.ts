/**
 * Foundations 2 (Lane C) attribution for the legacy facts and takes helpers on
 * an unmanaged brain: `writeSingleFact`'s DB-only and fence paths (with their
 * supersession bookkeeping), the facts backstop's DB-only fallbacks, the
 * unmanaged `decide` proposal accept and undo, and the takes file helpers'
 * DB mirror (add, append, update, supersede, resolve and its self-heal) write
 * inside maintenanceTransaction. Rows they create name the local maintenance
 * principal; rows they change keep their creator and move their last writer;
 * the page revisions their body mirrors advance name the maintenance principal.
 *
 * Protects the legacy facts and takes writer family in
 * docs/architecture/system-of-record.md. Fails if write-single.ts,
 * fence-write.ts, forget.ts, backstop.ts, proposal-supersede.ts or
 * takes-write.ts writes outside maintenanceTransaction. Runs on PGLite, and on
 * Postgres (direct and transaction-mode PgBouncer) through
 * test/e2e/write-attribution-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { applyProposalAction } from '../src/core/facts/proposal-supersede.ts';
import { insertProposal } from '../src/core/ai/decide/proposals-store.ts';
import { addTakeToPage, appendTakesToPageMdFirst, resolveTakeOnPage, supersedeTakeOnPage, updateTakeOnPage } from '../src/core/takes-write.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough, _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { CREATOR_ACTOR, asCreator, revisionActor, rowActors, unmanagedBrain, type Actor, type UnmanagedBrain } from './helpers/unmanaged-attribution.ts';

const engines: BrainEngine[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-write-attribution-facts-takes-'));
let closePostgres: (() => Promise<void>) | undefined;
const VECTOR = [1, ...new Array(1535).fill(0)];
const FIXED_EMBEDDING = (async (opts: { values: string[] }) => ({ embeddings: opts.values.map(() => VECTOR) })) as never;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(scratch, { recursive: true, force: true });
});

async function withFixedEmbeddings(fn: () => Promise<void>) {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-attribution' } });
  __setEmbedTransportForTests(FIXED_EMBEDDING);
  try { await fn(); }
  finally { __setEmbedTransportForTests(null); configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} }); }
}
const actors = (rows: Array<{ id: number; created: Actor; last: Actor }>) => Object.fromEntries(rows.map(row => [row.id, { created: row.created, last: row.last }]));
const both = (actor: Actor) => ({ created: actor, last: actor });
const VECTOR_TEXT = `[${VECTOR.join(',')}]`;
async function creatorFact(brain: UnmanagedBrain, fact: string, extra: { entity?: string; rowNum?: number; page?: string } = {}): Promise<number> {
  const [row] = await asCreator(brain.engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts
      (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug, embedding, embedding_model, embedded_text_hash)
    VALUES ($1, $2, $3, 'fact', 'private', 'test', $4, $5, $6::vector, 'openai:text-embedding-3-small', md5($3)) RETURNING id::int AS id`,
  [brain.sourceId, extra.entity ?? null, fact, extra.rowNum ?? null, extra.page ?? null, VECTOR_TEXT]));
  return row.id;
}
async function sourceRoot(brain: UnmanagedBrain): Promise<string> {
  const root = join(scratch, brain.sourceId);
  mkdirSync(join(root, 'people'), { recursive: true });
  await brain.engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [brain.sourceId, root]);
  _resetWriteThroughCacheForTest();
  return root;
}

describe('legacy facts helpers on an unmanaged brain', () => {
  test('writeSingleFact DB-only supersession: the new fact is maintenance-created and the old fact keeps its creator', () => withFixedEmbeddings(async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      // #5504: an entity the resolver can only slugify stores entity_slug NULL, so the page must exist for the
      // supersession candidate (keyed on the entity) to be found; the write itself stays DB-only (no local root).
      await importFromContent(engine, 'people/alice-example', '---\ntype: person\ntitle: Alice\n---\nA person.\n', { sourceId: brain.sourceId, sourcePath: 'people/alice-example.md', noEmbed: true });
      const old = await creatorFact(brain, 'Prefers morning meetings', { entity: 'people/alice-example' });

      const written = await writeSingleFact(engine, brain.sourceId, { fact: 'Prefers afternoon meetings', provenance: 'test', entity: 'people/alice-example' });

      expect(written.status).toBe('superseded');
      expect(actors(await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId])))
        .toEqual({ [old]: { created: CREATOR_ACTOR, last: brain.maintenance }, [written.id]: both(brain.maintenance) });
    }
  }), 120_000);

  test('writeSingleFact fence path: the fenced fact, its supersession strike and the page body mirror name the maintenance principal', () => withFixedEmbeddings(async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await sourceRoot(brain);
      const slug = 'people/bob-example';
      await importFromContent(engine, slug, '---\ntype: person\ntitle: Bob\n---\nA person.\n', { sourceId: brain.sourceId, sourcePath: `${slug}.md`, noEmbed: true });
      await writePageThrough(engine, slug, { sourceId: brain.sourceId });

      const first = await writeSingleFact(engine, brain.sourceId, { fact: 'Works from the harbor office', provenance: 'test', entity: slug });
      await engine.executeRaw('UPDATE pages SET revision_principal_kind=NULL, revision_principal_id=NULL WHERE source_id=$1 AND slug=$2', [brain.sourceId, slug]);
      const second = await writeSingleFact(engine, brain.sourceId, { fact: 'Works from the river office', provenance: 'test', entity: slug });

      expect([first.status, second.status]).toEqual(['inserted', 'superseded']);
      const [stored] = await engine.executeRaw<{ superseded_by: number | null; expired: boolean }>(
        'SELECT superseded_by::int AS superseded_by, expired_at IS NOT NULL AS expired FROM facts WHERE id=$1', [first.id]);
      expect(stored).toEqual({ superseded_by: second.id, expired: true });
      expect(actors(await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId])))
        .toEqual({ [first.id]: both(brain.maintenance), [second.id]: both(brain.maintenance) });
      expect(await revisionActor(engine, brain.sourceId, slug)).toEqual(brain.maintenance);
    }
  }), 120_000);

  test('the facts backstop stamps its DB-only fallbacks (unparented and stub-guarded facts)', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await sourceRoot(brain);
      resetGateway();
      __setChatTransportForTests(async (): Promise<ChatResult> => ({
        text: JSON.stringify({ facts: [
          { fact: 'The launch moved to spring', kind: 'fact', entity: null, confidence: 1.0, notability: 'medium' },
          { fact: 'Leads the example project', kind: 'fact', entity: 'people/zed-example', confidence: 1.0, notability: 'medium' },
        ] }),
        blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      }));
      try {
        const result = await runFactsBackstop(
          { slug: 'meetings/example-sync', type: 'meeting', compiled_truth: 'An example planning meeting about the launch and the project. '.repeat(3), frontmatter: {} },
          { engine, sourceId: brain.sourceId, sessionId: null, source: 'mcp:put_page', mode: 'inline' });
        if (result.mode !== 'inline') throw new Error('expected an inline backstop run');
        expect(result.fact_ids).toHaveLength(2);
        expect(actors(await rowActors(engine, 'facts', 'id=ANY($1::bigint[])', [result.fact_ids])))
          .toEqual(Object.fromEntries(result.fact_ids.map(id => [id, both(brain.maintenance)])));
      } finally {
        __setChatTransportForTests(null);
        __resetFactsQueueForTests();
        configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      }
    }
  }, 120_000);

  test('an unmanaged decide proposal accept and undo keep the old fact creator and move its last writer and page revision', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const slug = 'people/carol-example';
      const fence = renderFactsTable([
        { rowNum: 1, claim: 'Lives in the north district', kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium', active: true },
        { rowNum: 2, claim: 'Lives in the south district', kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium', active: true },
      ] as never);
      await asCreator(engine, tx => tx.putPage(slug, { type: 'person', title: 'Carol', compiled_truth: `Profile\n\n${fence}` }, { sourceId: brain.sourceId }));
      const old = await creatorFact(brain, 'Lives in the north district', { entity: slug, rowNum: 1, page: slug });
      const replacement = await creatorFact(brain, 'Lives in the south district', { entity: slug, rowNum: 2, page: slug });
      const id = (await insertProposal(engine, { source_id: brain.sourceId, sweep_id: `sweep-${brain.sourceId}`, pair_index: 0,
        new_fact_id: replacement, old_fact_id: old, direction: 'new_supersedes_old', p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: null } as never))!;

      expect(await applyProposalAction(engine, id, 'accept')).toMatchObject({ status: 'accepted' });
      expect(actors(await rowActors(engine, 'facts', 'id=$1', [old]))).toEqual({ [old]: { created: CREATOR_ACTOR, last: brain.maintenance } });
      expect(await revisionActor(engine, brain.sourceId, slug)).toEqual(brain.maintenance);

      await engine.executeRaw('UPDATE pages SET revision_principal_kind=NULL, revision_principal_id=NULL WHERE source_id=$1 AND slug=$2', [brain.sourceId, slug]);
      expect(await applyProposalAction(engine, id, 'undo')).toMatchObject({ status: 'undone' });
      expect(actors(await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId])))
        .toEqual({ [old]: { created: CREATOR_ACTOR, last: brain.maintenance }, [replacement]: both(CREATOR_ACTOR) });
      expect(await revisionActor(engine, brain.sourceId, slug)).toEqual(brain.maintenance);
    }
  }, 120_000);
});

describe('legacy takes file helpers on an unmanaged brain', () => {
  test('add, append, update, supersede and resolve mirror their rows under the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const root = await sourceRoot(brain);
      const slug = 'people/dana-example';
      const takes = renderTakesFence([{ rowNum: 1, claim: 'Ships carefully', kind: 'take', holder: 'world', weight: 0.6, active: true }] as never);
      const page = await asCreator(engine, tx => tx.putPage(slug, { type: 'person', title: 'Dana', compiled_truth: `Profile\n\n${takes}` }, { sourceId: brain.sourceId }));
      writeFileSync(join(root, `${slug}.md`), `---\ntype: person\ntitle: Dana\n---\nProfile\n\n${takes}\n`);
      await engine.executeRaw('DELETE FROM takes WHERE page_id=$1', [page.id]);
      await asCreator(engine, tx => tx.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Ships carefully', kind: 'take', holder: 'world', weight: 0.6, active: true, superseded_by: null }]));
      const target = { engine, slug, sourceId: brain.sourceId, brainDir: root };
      const byRow = async () => Object.fromEntries((await engine.executeRaw<{ row_num: number; created: Actor; last: Actor }>(`SELECT row_num::int AS row_num,
          jsonb_build_object('request',write_request_id::text,'kind',write_principal_kind,'id',write_principal_id) AS created,
          jsonb_build_object('request',last_write_request_id::text,'kind',last_write_principal_kind,'id',last_write_principal_id) AS last
        FROM takes WHERE page_id=$1 ORDER BY row_num`, [page.id])).map(row => [row.row_num, { created: row.created, last: row.last }]));

      expect((await updateTakeOnPage(target, 1, { weight: 0.7 })).mirror.mirror_warning).toBeUndefined();
      expect(await byRow()).toEqual({ 1: { created: CREATOR_ACTOR, last: brain.maintenance } });

      const superseded = await supersedeTakeOnPage(target, 1, { claim: 'Ships carefully and fast' });
      const added = await addTakeToPage(target, { claim: 'Prefers small teams', kind: 'take', holder: 'world' });
      const appended = await appendTakesToPageMdFirst(target, [{ claim: 'Writes long memos', kind: 'take', holder: 'world' }]);
      const resolved = await resolveTakeOnPage(target, superseded.newRow, { quality: 'correct', resolvedBy: 'example-reviewer' });
      for (const mirror of [superseded.mirror, added.mirror, appended.mirror, resolved.mirror]) expect(mirror.mirror_warning).toBeUndefined();
      expect(await byRow()).toEqual({ 1: { created: CREATOR_ACTOR, last: brain.maintenance }, [superseded.newRow]: both(brain.maintenance),
        [added.rowNum]: both(brain.maintenance), [appended.rowNums[0]]: both(brain.maintenance) });

      await engine.executeRaw('DELETE FROM takes WHERE page_id=$1 AND row_num=$2', [page.id, added.rowNum]);
      const healed = await resolveTakeOnPage(target, added.rowNum, { quality: 'incorrect', resolvedBy: 'example-reviewer' });
      expect(healed.mirror.mirror_warning).toBeUndefined();
      expect((await byRow())[added.rowNum]).toEqual(both(brain.maintenance));
    }
  }, 120_000);
});
