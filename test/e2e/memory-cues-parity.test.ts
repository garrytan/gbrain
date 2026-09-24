import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { cueEvidence, cueProviders, cueVector, enrollCues, seedCuePage, startCueBuild } from '../helpers/memory-cues.ts';
import { cueSignature, getMemoryCueStatus, loadMemoryCueSettings, memoryCueColumn, recallMemoryCues, revalidateMemoryCueCandidates, runMemoryCueBuild,
  resumeMemoryCueBuild, submitMemoryCueBuild } from '../../src/core/memory-cues/index.ts';
import { scheduleMemoryCuePage } from '../../src/core/memory-cues/scheduling.ts';
import { cueVectorExpression, cueSnapshotSql, cueIndexExists, provisionCueIndex } from '../../src/core/memory-cues/storage.ts';
import { reserveCueAttempt, settleCueAttempt } from '../../src/core/memory-cues/budget.ts';
import type { CueBuildRow } from '../../src/core/memory-cues/builds.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { MAX_CUE_WINDOW_BYTES } from '../../src/core/memory-cues/windows.ts';

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`memory cue lifecycle on ${kind}`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const e = new PGLiteEngine(); await e.connect({}); await e.initSchema(); engine = e; close = () => e.disconnect(); }
    });
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM memory_cue_builds');
      await engine.executeRaw('DELETE FROM minion_jobs');
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw("DELETE FROM config WHERE key LIKE 'memory.cues.%' OR key IN ('embedding_columns','search_embedding_column','chat_model')");
      await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
      await engine.setConfig('embedding_dimensions', '1536');
      await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'");
      await seedCuePage(engine);
      await enrollCues(engine);
    });
    const recall = async (opts = {}) => recallMemoryCues(engine, cueVector((await memoryCueColumn(engine)).dimensions), { embeddingColumn: await memoryCueColumn(engine), ...opts });
    const build = async () => { const receipt = await startCueBuild(engine); expect((await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: cueProviders })).status).toBe('complete'); return receipt; };

    test('real indexed vector plan, canonical evidence, and read-only status', async () => {
      await build();
      const hits = await recall();
      expect(hits.candidates).toHaveLength(1);
      expect(hits.candidates[0]!.result.chunk_text).toBe(cueEvidence);
      const column = await memoryCueColumn(engine);
      const plan = await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('enable_seqscan','off',true)");
        return tx.executeRaw(`EXPLAIN SELECT id FROM memory_cues WHERE signature='${cueSignature(column)}' ORDER BY (${cueVectorExpression(column)}) <=> $1::vector(1536) LIMIT 200`, [`[${Array.from(cueVector()).join(',')}]`]);
      });
      expect(JSON.stringify(plan)).toContain('memory_cues_ann_');
      const before = await engine.executeRaw('SELECT * FROM memory_cue_builds');
      await getMemoryCueStatus(engine);
      await recall();
      expect(await engine.executeRaw('SELECT * FROM memory_cue_builds')).toEqual(before);
    });

    test('post-publication edit and same-revision rechunk fail closed', async () => {
      await build();
      const candidates = (await recall()).candidates;
      await installFixtureChunks(engine, 'cue-example', [{ chunk_index: 0, chunk_text: 'Replacement safe projection.', chunk_source: 'compiled_truth' }]);
      expect((await recall()).candidates).toHaveLength(0);
      expect(await revalidateMemoryCueCandidates(engine, candidates, {})).toHaveLength(0);
      await seedCuePage(engine);
      await build();
      await engine.putPage('cue-example', { title: 'Revised title', type: 'note', compiled_truth: cueEvidence, timeline: '', frontmatter: {} }, { sourceId: 'default' });
      expect((await recall()).candidates).toHaveLength(0);
    });

    test('forget and delete/recreate cannot revive old evidence or a delayed worker', async () => {
      await build();
      const candidates = (await recall()).candidates;
      const fact = await engine.insertFact({ fact: cueEvidence, source: 'fixture', visibility: 'world' }, { source_id: 'default' });
      expect((await recordFactWithdrawal(engine, fact.id, 'default')).withdrawn).toBe(true);
      expect(await revalidateMemoryCueCandidates(engine, candidates, {})).toHaveLength(0);
      expect((await recall()).candidates).toHaveLength(0);
      await seedCuePage(engine);
      const delayed = await startCueBuild(engine);
      const result = await runMemoryCueBuild(engine, { buildId: delayed.buildId, providers: { ...cueProviders, generate: async input => {
        await engine.executeRaw("DELETE FROM pages WHERE slug='cue-example' AND source_id='default'");
        await seedCuePage(engine);
        return cueProviders.generate(input);
      } } });
      expect(result.reason).toBe('snapshot_superseded');
      expect((await recall()).candidates).toHaveLength(0);
    });

    test('foreign-source crowd cannot masquerade as exhausted authorized recall', async () => {
      await build();
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('cue-crowd','Crowd fixture') ON CONFLICT(id) DO NOTHING");
      await seedCuePage(engine, 'cue-example', 'cue-crowd');
      await enrollCues(engine, ['default', 'cue-crowd']);
      const foreign = await submitMemoryCueBuild(engine, { sourceIds: ['cue-crowd'], trustedLocal: true, maxUsd: 1 });
      await runMemoryCueBuild(engine, { buildId: foreign.buildId, providers: cueProviders });
      await engine.executeRaw(`INSERT INTO memory_cues(id,window_id,page_id,chunk_id,signature,family,relation,cue_text,quote,embedding)
        SELECT gen_random_uuid(),c.window_id,c.page_id,c.chunk_id,c.signature,c.family,c.relation,c.cue_text,c.quote,c.embedding
        FROM memory_cues c JOIN pages p ON p.id=c.page_id CROSS JOIN generate_series(1,300) WHERE p.source_id='cue-crowd'`);
      const result = await recall({ sourceIds: ['default'] });
      expect(result.status).not.toBe('empty');
      expect(result.candidates.every(c => c.result.source_id === 'default')).toBe(true);
      if (!result.candidates.length) expect(result.status).toBe('degraded');
    });

    test('an empty authorized scope has identical readiness before and after hidden cue inventory changes', async () => {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('cue-empty','Empty fixture') ON CONFLICT(id) DO NOTHING");
      await enrollCues(engine, ['default', 'cue-empty']);
      await submitMemoryCueBuild(engine, { sourceIds: ['cue-empty'], trustedLocal: true, maxUsd: 1 });
      const before = await recall({ sourceIds: ['cue-empty'], excludePrivate: true });
      await build();
      const afterForeign = await recall({ sourceIds: ['cue-empty'], excludePrivate: true });
      expect(afterForeign).toEqual(before);
      await engine.executeRaw("UPDATE pages SET frontmatter=$1::text::jsonb WHERE source_id='default'", [JSON.stringify({ visibility: 'private' })]);
      expect(await recall({ sourceIds: ['cue-empty'], excludePrivate: true })).toEqual(before);
    });

    test('cross-chunk constraints publish and hydrate all original evidence with fail-closed companions', async () => {
      const first = `## User\n🙂 ${'Prelude. '.repeat(35)}I cannot accept any morning call before`;
      const second = 'ten because I cover the morning school run.';
      const quote = 'I cannot accept any morning call before\nten because I cover the morning school run.';
      await engine.putPage('cue-example', { title: 'Boundary fixture', type: 'note', compiled_truth: first, timeline: second, frontmatter: {} }, { sourceId: 'default' });
      await engine.executeRaw("UPDATE pages SET effective_date='2026-01-01' WHERE slug='cue-example' AND source_id='default'");
      await installFixtureChunks(engine, 'cue-example', [
        { chunk_index: 0, chunk_text: first, chunk_source: 'compiled_truth' },
        { chunk_index: 1, chunk_text: second, chunk_source: 'timeline' },
      ]);
      const receipt = await startCueBuild(engine);
      const result = await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: { ...cueProviders, generate: async () => ({
        actualUsd: 0.001, output: [{ family: 'horizon', relation: 'explicit_constraint_applies', quote, text: 'Scheduling an early meeting', chunk_ids: [999999] }],
      }) } });
      expect(result).toEqual({ status: 'complete', windowsProcessed: 1 });
      const hits = await recall();
      expect(hits.candidates).toHaveLength(1);
      const candidate = hits.candidates[0]!;
      expect(candidate.evidence?.map(r => r.chunk_text)).toEqual([first, second]);
      expect(candidate.result).toEqual(candidate.evidence![0]);
      expect(candidate.result.effective_date).toContain('2026-01-01');
      expect(candidate.evidence!.every(r => r.source_id === 'default' && r.page_id === candidate.result.page_id && r.cosine === undefined)).toBe(true);
      expect(JSON.stringify(candidate.evidence)).not.toContain('Scheduling an early meeting');
      expect((await revalidateMemoryCueCandidates(engine, hits.candidates, {}))[0]!.evidence).toEqual(candidate.evidence);
      expect((await recall({ detail: 'low' })).candidates).toHaveLength(0);
      expect(await revalidateMemoryCueCandidates(engine, hits.candidates, { detail: 'low' })).toHaveLength(0);
      const [stored] = await engine.executeRaw<{ grounding: Array<{ chunk_id: number; start: number; end: number; separator: string }> }>('SELECT grounding FROM memory_cues WHERE id=$1::uuid', [candidate.cueId]);
      expect(stored!.grounding.map(s => s.chunk_id)).toEqual(candidate.evidence!.map(r => r.chunk_id));
      for (const invalid of [{}, [], null, [{ chunk_id: 'invalid', start: 0, end: 1, separator: '' }],
        [{ ...stored!.grounding[0], end: 9999999999 }], Array.from({ length: 5 }, () => stored!.grounding[0])]) {
        await engine.executeRaw('UPDATE memory_cues SET grounding=$2::text::jsonb WHERE id=$1::uuid', [candidate.cueId, JSON.stringify(invalid)]);
        expect(await revalidateMemoryCueCandidates(engine, hits.candidates, {})).toHaveLength(0);
      }
      await engine.executeRaw('UPDATE memory_cues SET grounding=$2::text::jsonb WHERE id=$1::uuid', [candidate.cueId, JSON.stringify(stored!.grounding)]);
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('cue-foreign-span','Foreign span fixture') ON CONFLICT(id) DO NOTHING");
      await seedCuePage(engine, 'cue-example', 'cue-foreign-span', second);
      const [foreign] = await engine.executeRaw<{ id: number }>("SELECT cc.id FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.source_id='cue-foreign-span'");
      const corrupted = stored!.grounding.map((span, index) => index === 1 ? { ...span, chunk_id: foreign!.id } : span);
      await engine.executeRaw('UPDATE memory_cues SET grounding=$2::text::jsonb WHERE id=$1::uuid', [candidate.cueId, JSON.stringify(corrupted)]);
      expect((await recall()).candidates).toHaveLength(0);
      expect(await revalidateMemoryCueCandidates(engine, hits.candidates, {})).toHaveLength(0);
      await engine.executeRaw('UPDATE memory_cues SET grounding=$2::text::jsonb WHERE id=$1::uuid', [candidate.cueId, JSON.stringify(stored!.grounding)]);
      await engine.executeRaw("UPDATE content_chunks SET chunk_text='The companion was withdrawn.' WHERE id=$1", [candidate.evidence![1]!.chunk_id]);
      expect(await revalidateMemoryCueCandidates(engine, hits.candidates, {})).toHaveLength(0);
    });

    test('private, quarantine, withdrawn, archived and empty grants filter before return', async () => {
      await build();
      const candidates = (await recall()).candidates;
      expect((await recall({ sourceIds: [] })).candidates).toHaveLength(0);
      for (const frontmatter of [{ visibility: 'private' }, { quarantine: true }, { status: 'withdrawn' }, { status: 'superseded' }]) {
        await engine.executeRaw('UPDATE pages SET frontmatter=$1::text::jsonb', [JSON.stringify(frontmatter)]);
        expect((await recall({ excludePrivate: true })).candidates).toHaveLength(0);
        expect(await revalidateMemoryCueCandidates(engine, candidates, { excludePrivate: true })).toHaveLength(0);
      }
      await engine.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
      expect((await recall()).candidates).toHaveLength(0);
    });

    test('same-slug pages retain source identity and source recreation rejects delayed worker', async () => {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('cue-other','Other fixture') ON CONFLICT(id) DO NOTHING");
      await seedCuePage(engine, 'cue-example', 'cue-other');
      await enrollCues(engine, ['default', 'cue-other']);
      const receipt = await submitMemoryCueBuild(engine, { sourceIds: ['default', 'cue-other'], trustedLocal: true, maxUsd: 1 });
      expect((await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: cueProviders })).status).toBe('complete');
      expect((await recall({ sourceIds: ['cue-other'] })).candidates.map(c => c.result.source_id)).toEqual(['cue-other']);
      const delayed = await submitMemoryCueBuild(engine, { sourceIds: ['cue-other'], trustedLocal: true, maxUsd: 1 });
      const result = await runMemoryCueBuild(engine, { buildId: delayed.buildId, providers: { ...cueProviders, generate: async input => {
        await engine.executeRaw("DELETE FROM sources WHERE id='cue-other'");
        await engine.executeRaw("INSERT INTO sources(id,name) VALUES('cue-other','Recreated fixture')");
        return cueProviders.generate(input);
      } } });
      expect(result.reason).toBe('source_changed');
      expect((await recall({ sourceIds: ['cue-other'] })).candidates).toHaveLength(0);
    });

    test('halfvec custom signatures install and model/prompt rotation invalidate immediately', async () => {
      await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS cue_half halfvec(16)');
      await engine.setConfig('embedding_columns', JSON.stringify({ cue_half: { provider: 'openai:text-embedding-3-small', dimensions: 16, type: 'halfvec' } }));
      await engine.setConfig('search_embedding_column', 'cue_half');
      await enrollCues(engine);
      await build();
      expect((await recall()).candidates).toHaveLength(1);
      await engine.executeRaw("UPDATE memory_cue_windows SET prompt_version='old-prompt'");
      expect((await recall()).candidates).toHaveLength(0);
      await engine.setConfig('embedding_columns', JSON.stringify({ cue_half: { provider: 'openai:text-embedding-3-large', dimensions: 16, type: 'halfvec' } }));
      expect((await loadMemoryCueSettings(engine)).minSimilarity).toBeNull();
      expect((await recall()).reason).toBe('uncalibrated');
    });

    test('large-page coverage resumes bounded passes on the original allowance', async () => {
      const filler = 'Window filler. ';
      await seedCuePage(engine, 'cue-example', 'default', `${cueEvidence} ${filler.repeat(Math.ceil(MAX_CUE_WINDOW_BYTES * 3 / Buffer.byteLength(filler)))}`);
      const receipt = await startCueBuild(engine, { windowLimit: 2 });
      const providers = { ...cueProviders, generate: async () => ({ output: [], actualUsd: 0.001 }) };
      const first = await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers });
      expect(first).toEqual({ status: 'partial', windowsProcessed: 2 });
      expect((await getMemoryCueStatus(engine)).windowsPending).toBeGreaterThan(0);
      for (let pass = 0; pass < 10; pass++) {
        if ((await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers })).status === 'complete') break;
      }
      expect((await getMemoryCueStatus(engine)).builds[0]!.status).toBe('complete');
      const jobs = await engine.executeRaw<{ budget_root_owner_id: number }>('SELECT budget_root_owner_id FROM minion_jobs');
      expect(jobs.every(j => Number(j.budget_root_owner_id) === receipt.budgetOwnerJobId)).toBe(true);
    });

    test('incremental scheduling reuses completed windows without repeat provider calls', async () => {
      const receipt = await build();
      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages LIMIT 1');
      expect((await scheduleMemoryCuePage(engine, 'default', page!.id)).reason).toBe('queued');
      expect((await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: {
        generate: async () => { throw new Error('duplicate generation'); }, embed: async () => { throw new Error('duplicate embedding'); },
      } })).status).toBe('complete');
      expect((await recall()).candidates).toHaveLength(1);
    });

    test('completion serializes pending-page admission before counting and scheduling continuation', async () => {
      const receipt = await startCueBuild(engine);
      const result = await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: cueProviders, boundary: async name => {
        expect(name).toBe('before_completion_lock');
        expect(await engine.executeRaw('SELECT status FROM memory_cue_builds WHERE id=$1::uuid', [receipt.buildId])).toEqual([{ status: 'running' }]);
        await seedCuePage(engine, 'late-cue-page');
        const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='late-cue-page' AND source_id='default'");
        expect((await scheduleMemoryCuePage(engine, 'default', page!.id)).reason).toBe('queued');
      } });
      expect(result.status).toBe('partial');
      expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE id<>$1 AND data->>'buildId'=$2 AND status='waiting'", [receipt.jobId, receipt.buildId])).toHaveLength(1);
      expect((await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: cueProviders })).status).toBe('complete');
      expect((await recall()).candidates.map(c => c.result.slug).sort()).toEqual(['cue-example', 'late-cue-page']);
    });

    test('index certification rejects shadow-schema names and wrong physical definitions', async () => {
      await build();
      const column = await memoryCueColumn(engine);
      const signature = cueSignature(column);
      const name = `memory_cues_ann_${signature.slice(0, 24)}`;
      await engine.executeRaw('CREATE SCHEMA cue_shadow');
      try {
        await engine.executeRaw('CREATE TABLE cue_shadow.decoy(embedding vector(1536),signature text)');
        await engine.executeRaw(`CREATE INDEX ${name} ON cue_shadow.decoy USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE signature='${signature}'`);
        await engine.executeRaw(`DROP INDEX ${name}`);
        expect(await cueIndexExists(engine, signature)).toBe(false);
        expect((await recall()).reason).toBe('index_not_provisioned');
        await engine.executeRaw(`CREATE INDEX ${name} ON memory_cues(signature)`);
        expect(await cueIndexExists(engine, signature)).toBe(false);
        await expect(startCueBuild(engine)).rejects.toThrow('cue_index_invalid');
        await engine.executeRaw(`DROP INDEX ${name}`);
        await engine.executeRaw(`CREATE INDEX ${name} ON memory_cues USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE signature='wrong-signature'`);
        expect(await cueIndexExists(engine, signature)).toBe(false);
        await engine.executeRaw(`DROP INDEX ${name}`);
        await engine.executeRaw(`CREATE INDEX ${name} ON memory_cues USING hnsw ((embedding::vector(1536)) vector_l2_ops) WHERE signature='${signature}'`);
        expect(await cueIndexExists(engine, signature)).toBe(false);
        await engine.executeRaw(`DROP INDEX ${name}`);
        await engine.executeRaw(`CREATE INDEX ${name} ON memory_cues USING hnsw ((embedding::text::vector(1536)) vector_cosine_ops) WHERE signature='${signature}'`);
        expect(await cueIndexExists(engine, signature)).toBe(false);
      } finally {
        await engine.executeRaw(`DROP INDEX IF EXISTS ${name}`);
        await engine.executeRaw('DROP SCHEMA cue_shadow CASCADE');
        await provisionCueIndex(engine, column);
      }
      expect(await cueIndexExists(engine, signature)).toBe(true);
    });

    test('concurrent durable reservations never replenish a cap and refund only once', async () => {
      const receipt = await startCueBuild(engine, { maxUsd: 0.03 });
      const [row] = await engine.executeRaw<CueBuildRow>("UPDATE memory_cue_builds SET status='running',execution_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' WHERE id=$1::uuid RETURNING *", [receipt.buildId]);
      const [page] = await engine.executeRaw<{ id: number; snapshot: string }>(`SELECT id,${cueSnapshotSql} AS snapshot FROM pages p LIMIT 1`);
      const context = { build: row!, token: row!.execution_token!, pageId: page!.id, snapshot: page!.snapshot, windowIndex: 0 };
      const call = { operation: 'fixture', kind: 'embedding' as const, model: 'openai:text-embedding-3-small', maxInputTokens: 1, maxOutputTokens: 0 };
      const reservations = await Promise.allSettled(Array.from({ length: 5 }, () => reserveCueAttempt(engine, context, call)));
      expect(reservations.filter(r => r.status === 'fulfilled')).toHaveLength(3);
      expect(reservations.filter(r => r.status === 'rejected')).toHaveLength(2);
      const hold = reservations.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>;
      await Promise.all([settleCueAttempt(engine, row!, hold.value.id, 0), settleCueAttempt(engine, row!, hold.value.id, 0)]);
      const [owner] = await engine.executeRaw<{ budget_remaining_cents: number }>('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [receipt.budgetOwnerJobId]);
      expect(owner!.budget_remaining_cents).toBe(1);
      await engine.executeRaw("UPDATE memory_cue_builds SET status='failed',execution_token=NULL WHERE id=$1::uuid", [receipt.buildId]);
      await resumeMemoryCueBuild(engine, { buildId: receipt.buildId, trustedLocal: true });
      const [after] = await engine.executeRaw<{ budget_remaining_cents: number }>('SELECT budget_remaining_cents FROM minion_jobs WHERE id=$1', [receipt.budgetOwnerJobId]);
      expect(after!.budget_remaining_cents).toBe(1);
    });

    test('upgrade and repeated migration recreate cue schema without touching canonical evidence', async () => {
      for (const version of [163, 164]) {
        await engine.executeRaw('DROP TABLE memory_cues,memory_cue_indexes,memory_cue_attempts,memory_cue_windows,memory_cue_pages,memory_cue_builds');
        await engine.setConfig('version', String(version));
        const migration = await runMigrations(engine);
        expect(migration.current).toBeGreaterThanOrEqual(165);
        expect(migration.applied).toBe(165 - version);
        expect(await engine.executeRaw("SELECT to_regclass('shared_skill_heads')::text AS heads, to_regclass('shared_skill_members')::text AS members"))
          .toEqual([{ heads: 'shared_skill_heads', members: 'shared_skill_members' }]);
        expect((await runMigrations(engine)).applied).toBe(0);
        expect((await engine.getPage('cue-example', { sourceId: 'default' }))!.compiled_truth).toBe(cueEvidence);
        await build();
        expect((await recall()).candidates).toHaveLength(1);
      }
    });
  });
}
