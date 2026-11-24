/**
 * Failback after an engine swap (`gbrain engine swap --to pglite|postgres`, docs/guides/engine-swap.md#failback).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the way back from the Rust engine: every write made on Rust after the
 * swap reaches the old primary, the copy is verified by the same read calls on both engines before authority moves,
 * and nothing is written while another writer is active. (2) Fails when a changed, added or removed page, a tag, a
 * link, a timeline entry, a chunk, raw data, a fact, a take, an open loop, a file row, a config key or a source is not
 * copied back; when verification passes although a changed page was not copied; when failback switches authority
 * after a failed verification; when it writes while a writer is active; or when it runs without a succeeded swap.
 * (3) test/engine-swap-run.serial.test.ts runs the same round trip against the real Rust store (addon-gated); this file
 * runs everywhere. (4) Seam: a second PGLite engine stands in for the Rust engine. Failback reads the Rust side only
 * through BrainEngine read calls the Rust engine serves (src/core/rust-engine/members.ts), so any engine that serves
 * them exercises the same code. The primary is real PGLite, and real Postgres when DATABASE_URL is set (CI's Postgres
 * arm; locally PG17 with an ICU database). The route probe is injected; the config switch is real (GBRAIN_HOME).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { fencePrimary, markPrimaryCutover, primaryFenced } from '../src/core/engine-swap/fence.ts';
import { readSwapRecord, writeSwapRecord, type SwapRecord } from '../src/core/engine-swap/record.ts';
import { readGraduationRow } from '../src/core/persistence/graduation-schema.ts';
import {
  FAILBACK_ACCEPTED_LOSSES, planFailback, runFailback, verifyFailback, type FailbackDeps,
} from '../src/core/engine-swap/failback.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const RUN = '00000000-0000-4000-8000-00000000fb01';
const HOST = '00000000-0000-4000-8000-00000000fb02';
const URL_ = process.env.DATABASE_URL;

async function embeddingDims(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
  return Number(row!.dims);
}

function vector(dims: number, seed: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = ((i * 7 + seed * 13) % 17) / 17;
  return v;
}

/** The same brain on both engines before the swap: what the seed and the follower would have copied. */
async function writeBrain(engine: BrainEngine): Promise<void> {
  const dims = await embeddingDims(engine);
  for (const [slug, body] of [['people/alice-example', 'Alice runs widget-co.'], ['companies/widget-co', 'A company.'], ['notes/old-example', 'Removed on Rust later.']] as const) {
    await engine.putPage(slug, { type: slug.split('/')[0] === 'people' ? 'person' : 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: { tags: [] } });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth', embedding: vector(dims, slug.length), model: 'test-model', token_count: 4 }]);
  }
  await engine.addTag('people/alice-example', 'founder');
  await engine.addLink('people/alice-example', 'companies/widget-co', 'runs', 'works_at');
  await engine.addTimelineEntry('people/alice-example', { date: '2026-01-02', source: 'test', summary: 'Joined', detail: '' });
  await engine.putRawData('people/alice-example', 'test-feed', { a: 1 });
  await engine.insertFact({ fact: 'Alice prefers mornings', entity_slug: 'people/alice-example', source: 'test' }, { source_id: 'default' });
  await engine.setConfig('example.setting', 'before');
}

/** Writes made on the Rust engine after the swap: an edit, a new page with every dependent row, a delete, a fact, a key. */
async function writeAfterSwap(rust: BrainEngine): Promise<void> {
  const dims = await embeddingDims(rust);
  await rust.putPage('people/alice-example', { type: 'person', title: 'people/alice-example', compiled_truth: 'Alice now runs acme-example.', timeline: '', frontmatter: { tags: [] } });
  await rust.deleteChunks('people/alice-example');
  await rust.upsertChunks('people/alice-example', [{ chunk_index: 0, chunk_text: 'Alice now runs acme-example.', chunk_source: 'compiled_truth', embedding: vector(dims, 99), model: 'test-model', token_count: 5 }]);
  await rust.removeTag('people/alice-example', 'founder');
  await rust.addTag('people/alice-example', 'operator');
  await rust.putPage('companies/acme-example', { type: 'note', title: 'companies/acme-example', compiled_truth: 'Made after the swap.', timeline: '', frontmatter: { tags: [] } });
  await rust.upsertChunks('companies/acme-example', [{ chunk_index: 0, chunk_text: 'Made after the swap.', chunk_source: 'compiled_truth', embedding: vector(dims, 7), model: 'test-model', token_count: 4 }]);
  await rust.addTag('companies/acme-example', 'new');
  await rust.addLink('people/alice-example', 'companies/acme-example', 'runs', 'works_at');
  await rust.addTimelineEntry('companies/acme-example', { date: '2026-11-25', source: 'test', summary: 'Founded', detail: 'after swap' });
  await rust.putRawData('companies/acme-example', 'test-feed', { b: 2 });
  const [page] = await rust.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'companies/acme-example'`);
  await rust.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: 'It will grow', kind: 'bet', holder: 'brain', weight: 0.6 }]);
  await rust.upsertFile({ page_slug: 'companies/acme-example', page_id: page!.id, filename: 'deck.pdf', storage_path: 'files/deck.pdf', content_hash: 'ab'.repeat(32), mime_type: 'application/pdf', size_bytes: 10 });
  await rust.upsertOpenLoop({ sourceId: 'default', dedupKey: 'loop-1', loopType: 'promise', summary: 'Send the deck', evidence: [], detector: 'test' } as never);
  await rust.deletePage('notes/old-example');
  await rust.insertFact({ fact: 'Acme was founded after the swap', entity_slug: 'companies/acme-example', source: 'test' }, { source_id: 'default' });
  await rust.setConfig('example.setting', 'after');
}

interface Arm { name: string; open(): Promise<{ engine: BrainEngine; close(): Promise<void> }>; previous: SwapRecord['brain'] }

const arms: Arm[] = [
  { name: 'PGLite', previous: { key: 'failback-pglite', engine: 'pglite', database_path: '/brains/old.pglite' },
    open: async () => { const e = new PGLiteEngine(); await e.connect({}); await e.initSchema(); return { engine: e, close: () => e.disconnect() }; } },
];
if (URL_) {
  arms.push({ name: 'Postgres', previous: { key: 'failback-postgres', engine: 'postgres', database_path: '' },
    open: async () => { const r = await isolatedPersistencePostgres(URL_, 'instance', 4, { collation: 'icu-en-US' }); return { engine: r.engine, close: r.close }; } });
}

const homes: string[] = [];
afterAll(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

for (const arm of arms) {
  describe(`failback to a ${arm.name} primary`, () => {
    let primary: BrainEngine;
    let rust: BrainEngine;
    let closePrimary: () => Promise<void>;
    let home: string;
    let deps: FailbackDeps;

    async function world(over: Partial<FailbackDeps> = {}): Promise<FailbackDeps> {
      home = mkdtempSync(join(tmpdir(), 'gbrain-failback-'));
      homes.push(home);
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      const store = join(home, 'shadow', 'store');
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: store }));
      ({ engine: primary, close: closePrimary } = await arm.open());
      rust = new PGLiteEngine();
      await rust.connect({});
      await rust.initSchema();
      await writeBrain(primary);
      await writeBrain(rust);
      // The forward swap's end state: the primary is fenced and its graduation row records cutover for the run.
      await fencePrimary(primary, RUN, { hostId: HOST, config: { engine: arm.previous.engine } as unknown as GBrainConfig });
      await markPrimaryCutover(primary, RUN);
      const recordPath = join(home, '.gbrain', 'engine-swap', arm.previous.key, 'run.json');
      const at = new Date('2026-11-24T20:00:00Z').toISOString();
      const record: SwapRecord = {
        version: 1, run_id: RUN, plan_hash: 'swapplan', policy_hash: 'policy', brain: arm.previous, rust_store: store,
        shadow_dir: join(home, 'shadow'), state: 'succeeded', started_at: at, updated_at: at,
        switch: { previous: { engine: arm.previous.engine, database_path: arm.previous.database_path }, at }, error: null,
      };
      writeSwapRecord(recordPath, record);
      deps = {
        primary, rust, recordPath, brainKey: arm.previous.key, runDir: join(home, '.gbrain', 'engine-swap', arm.previous.key),
        writers: async () => null,
        prober: async () => ({ effective_engine: arm.previous.engine, database_path: arm.previous.database_path || null, ok: true }),
        ...over,
      };
      return deps;
    }

    const inHome = <T>(fn: () => Promise<T>): Promise<T> => withEnv({ GBRAIN_HOME: home }, fn);
    const configEngine = (): string => JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).engine;

    async function expectRefused(p: Promise<unknown>, reason: string): Promise<OperationError> {
      const error = await p.then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('engine_swap_refused');
      expect((error as OperationError).reason).toBe(reason);
      return error as OperationError;
    }

    afterEach(async () => {
      await rust?.disconnect().catch(() => undefined);
      await closePrimary?.().catch(() => undefined);
    });

    beforeAll(() => undefined);

    test('the plan names the accepted losses with counts before anything is written', async () => {
      await world();
      await writeAfterSwap(rust);
      const before = await verifyFailback(rust, primary);
      expect(before.ok).toBe(false);
      const plan = await inHome(() => planFailback(deps));
      expect(plan.target).toBe(arm.previous.engine);
      expect(plan.pages).toMatchObject({ changed: 1, added: 1, removed: 1 });
      expect(plan.losses.accepted.map(l => l.name)).toEqual([...FAILBACK_ACCEPTED_LOSSES]);
      expect(plan.losses.accepted.find(l => l.name === 'page_version_collapse')!.count).toBe(1);
      expect(plan.losses.accepted.find(l => l.name === 'new_row_ids')!.count).toBe(1);
      expect(plan.losses.not_carried_tables).toContain('page_versions');
      expect(plan.losses.not_carried_tables).not.toContain('pages');
      expect(plan.plan_hash).toMatch(/^[0-9a-f]{16}$/);
      // Read only: the primary still has the pre-swap page, the fence and the cutover row; config still names rust.
      expect((await primary.getPage('people/alice-example'))!.compiled_truth).toBe('Alice runs widget-co.');
      expect(await primaryFenced(primary, RUN)).toBe(true);
      expect(configEngine()).toBe('rust');
    }, 120_000);

    test('swap, write on Rust, failback: every write is copied back and verified by the same reads on both engines', async () => {
      await world();
      await writeAfterSwap(rust);
      const plan = await inHome(() => planFailback(deps));
      const done = await inHome(() => runFailback(deps, plan.plan_hash));
      expect(done.failback!.state).toBe('succeeded');
      expect(done.failback!.verify!.ok).toBe(true);
      const check = await verifyFailback(rust, primary);
      expect(check.mismatches).toEqual([]);
      expect(check.ok).toBe(true);
      expect((await primary.getPage('people/alice-example'))!.compiled_truth).toBe('Alice now runs acme-example.');
      expect(await primary.getTags('people/alice-example')).toEqual(['operator']);
      expect((await primary.getLinks('people/alice-example')).map(l => l.to_slug).sort()).toEqual(['companies/acme-example', 'companies/widget-co']);
      expect(await primary.getPage('notes/old-example')).toBeNull();
      expect((await primary.getTimeline('companies/acme-example')).map(t => t.summary)).toEqual(['Founded']);
      expect((await primary.getChunksWithEmbeddings('companies/acme-example', { includeUnsealed: true }))[0]!.chunk_text).toBe('Made after the swap.');
      expect((await primary.getRawData('companies/acme-example')).map(r => r.data)).toEqual([{ b: 2 }]);
      expect((await primary.listFactsKeyset('default', null, { activeOnly: false })).map(f => f.fact).sort())
        .toEqual(['Acme was founded after the swap', 'Alice prefers mornings']);
      expect(await primary.getConfig('example.setting')).toBe('after');
      expect((await primary.listOpenLoops()).map(l => l.summary)).toEqual(['Send the deck']);
      // Authority is back on the old engine, the fence is gone, and the graduation row closed the run.
      expect(configEngine()).toBe(arm.previous.engine);
      expect(await primaryFenced(primary, RUN)).toBe(false);
      expect((await readGraduationRow(primary))!.state).toBe('rolled_back');
      expect(readSwapRecord(deps.recordPath)!.failback!.state).toBe('succeeded');
      await primary.putPage('notes/after-failback', { type: 'note', title: 'After', compiled_truth: 'Writes work again.', timeline: '' });
    }, 180_000);

    test('verification fails when a changed page is not copied back, and authority stays on Rust', async () => {
      await world({
        // A write that lands on Rust after the copy and before the verification: the copy never saw it.
        beforeVerify: async () => {
          await rust.putPage('companies/widget-co', { type: 'note', title: 'companies/widget-co', compiled_truth: 'Changed after the copy.', timeline: '', frontmatter: { tags: [] } });
        },
      });
      await writeAfterSwap(rust);
      const plan = await inHome(() => planFailback(deps));
      const error = await expectRefused(inHome(() => runFailback(deps, plan.plan_hash)), 'failback_mismatch');
      expect(error.message).toContain('companies/widget-co');
      expect(configEngine()).toBe('rust');
      expect(await primaryFenced(primary, RUN)).toBe(true);
      expect((await readGraduationRow(primary))!.state).toBe('cutover');
      const record = readSwapRecord(deps.recordPath)!;
      expect(record.failback!.state).toBe('copied');
      expect(record.failback!.error!.code).toBe('failback_mismatch');
    }, 180_000);

    test('failback refuses while a writer is active, before any write', async () => {
      await world({ writers: async () => 'gbrain serve (pid 4242) holds the Rust store' });
      await writeAfterSwap(rust);
      const plan = await inHome(() => planFailback({ ...deps, writers: async () => null }));
      const error = await expectRefused(inHome(() => runFailback(deps, plan.plan_hash)), 'brain_in_use');
      expect(error.message).toContain('pid 4242');
      expect((await primary.getPage('people/alice-example'))!.compiled_truth).toBe('Alice runs widget-co.');
      expect(await primary.getPage('companies/acme-example')).toBeNull();
      expect(configEngine()).toBe('rust');
      expect(await primaryFenced(primary, RUN)).toBe(true);
      expect(readSwapRecord(deps.recordPath)!.failback).toBeUndefined();
    }, 120_000);

    test('failback refuses without a succeeded swap, and on a changed plan', async () => {
      await world();
      const record = readSwapRecord(deps.recordPath)!;
      writeSwapRecord(deps.recordPath, { ...record, state: 'verified', switch: undefined });
      await expectRefused(inHome(() => planFailback(deps)), 'failback_unavailable');
      writeSwapRecord(deps.recordPath, record);
      const plan = await inHome(() => planFailback(deps));
      await writeAfterSwap(rust);
      const changed = await inHome(() => runFailback(deps, plan.plan_hash)).then(() => null, (e: unknown) => e);
      expect((changed as OperationError).code).toBe('preview_changed');
      expect(configEngine()).toBe('rust');
    }, 120_000);
  });
}
