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
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OperationError } from '../src/core/ops/contract.ts';
import { primaryFenced } from '../src/core/engine-swap/fence.ts';
import { readSwapRecord, writeSwapRecord } from '../src/core/engine-swap/record.ts';
import { readGraduationRow } from '../src/core/persistence/graduation-schema.ts';
import {
  FAILBACK_ACCEPTED_LOSSES, planFailback, runFailback, verifyFailback, type FailbackDeps,
} from '../src/core/engine-swap/failback.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { openFailbackWorld, openPglite, RUN, writeAfterSwap, type FailbackArm, type FailbackWorld } from './helpers/failback-world.ts';
import { withEnv } from './helpers/with-env.ts';

const URL_ = process.env.DATABASE_URL;

const arms: FailbackArm[] = [
  { name: 'PGLite', previous: { key: 'failback-pglite', engine: 'pglite', database_path: '/brains/old.pglite' }, open: openPglite },
];
if (URL_) {
  arms.push({ name: 'Postgres', previous: { key: 'failback-postgres', engine: 'postgres', database_path: '' },
    open: async () => { const r = await isolatedPersistencePostgres(URL_, 'instance', 4, { collation: 'icu-en-US' }); return { engine: r.engine, close: r.close }; } });
}

const inHome = <T>(w: FailbackWorld, fn: () => Promise<T>): Promise<T> => withEnv({ GBRAIN_HOME: w.home }, fn);
const configEngine = (w: FailbackWorld): string => JSON.parse(readFileSync(join(w.home, '.gbrain', 'config.json'), 'utf8')).engine;

async function expectRefused(p: Promise<unknown>, reason: string): Promise<OperationError> {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(OperationError);
  expect((error as OperationError).code).toBe('engine_swap_refused');
  expect((error as OperationError).reason).toBe(reason);
  return error as OperationError;
}

for (const arm of arms) {
  describe(`failback to a ${arm.name} primary`, () => {
    /** One world per scenario, opened in beforeAll and closed in afterAll. */
    function scenario(name: string, over: ((e: { primary: BrainEngine; rust: BrainEngine }) => Partial<FailbackDeps>) | undefined, body: (w: FailbackWorld) => Promise<void>, timeout: number): void {
      describe(name, () => {
        let w: FailbackWorld;
        beforeAll(async () => { w = await openFailbackWorld(arm, over); }, 180_000);
        afterAll(async () => { await w?.close(); });
        test(name, () => body(w), timeout);
      });
    }

    scenario('the plan names the accepted losses with counts before anything is written', undefined, async w => {
      await writeAfterSwap(w.rust);
      const before = await verifyFailback(w.rust, w.primary);
      expect(before.ok).toBe(false);
      const plan = await inHome(w, () => planFailback(w.deps));
      expect(plan.target).toBe(arm.previous.engine);
      expect(plan.pages).toMatchObject({ changed: 1, added: 1, removed: 1 });
      expect(plan.losses.accepted.map(l => l.name)).toEqual([...FAILBACK_ACCEPTED_LOSSES]);
      expect(plan.losses.accepted.find(l => l.name === 'page_version_collapse')!.count).toBe(1);
      expect(plan.losses.accepted.find(l => l.name === 'new_row_ids')!.count).toBe(1);
      expect(plan.losses.not_carried_tables).toContain('page_versions');
      expect(plan.losses.not_carried_tables).not.toContain('pages');
      expect(plan.plan_hash).toMatch(/^[0-9a-f]{16}$/);
      // Read only: the primary still has the pre-swap page, the fence and the cutover row; config still names rust.
      expect((await w.primary.getPage('people/alice-example'))!.compiled_truth).toBe('Alice runs widget-co.');
      expect(await primaryFenced(w.primary, RUN)).toBe(true);
      expect(configEngine(w)).toBe('rust');
    }, 120_000);

    scenario('swap, write on Rust, failback: every write is copied back and verified by the same reads on both engines', undefined, async w => {
      await writeAfterSwap(w.rust);
      const plan = await inHome(w, () => planFailback(w.deps));
      const done = await inHome(w, () => runFailback(w.deps, plan.plan_hash));
      expect(done.failback!.state).toBe('succeeded');
      expect(done.failback!.verify!.ok).toBe(true);
      const check = await verifyFailback(w.rust, w.primary);
      expect(check.mismatches).toEqual([]);
      expect(check.ok).toBe(true);
      expect((await w.primary.getPage('people/alice-example'))!.compiled_truth).toBe('Alice now runs acme-example.');
      expect(await w.primary.getTags('people/alice-example')).toEqual(['operator']);
      expect((await w.primary.getLinks('people/alice-example')).map(l => l.to_slug).sort()).toEqual(['companies/acme-example', 'companies/widget-co']);
      expect(await w.primary.getPage('notes/old-example')).toBeNull();
      expect((await w.primary.getTimeline('companies/acme-example')).map(t => t.summary)).toEqual(['Founded']);
      expect((await w.primary.getChunksWithEmbeddings('companies/acme-example', { includeUnsealed: true }))[0]!.chunk_text).toBe('Made after the swap.');
      expect((await w.primary.getRawData('companies/acme-example')).map(r => r.data)).toEqual([{ b: 2 }]);
      const facts = await w.primary.listFactsKeyset('default', null, { activeOnly: false });
      expect(facts.map(f => f.fact)).toEqual(['Alice prefers mornings']);
      expect(facts[0]!.expired_at).not.toBeNull();
      expect(await w.primary.getConfig('example.setting')).toBe('after');
      expect((await w.primary.listOpenLoops()).map(l => l.summary)).toEqual(['Send the deck']);
      // Authority is back on the old engine, the fence is gone, and the graduation row closed the run.
      expect(configEngine(w)).toBe(arm.previous.engine);
      expect(await primaryFenced(w.primary, RUN)).toBe(false);
      expect((await readGraduationRow(w.primary))!.state).toBe('rolled_back');
      expect(readSwapRecord(w.deps.recordPath)!.failback!.state).toBe('succeeded');
      await w.primary.putPage('notes/after-failback', { type: 'note', title: 'After', compiled_truth: 'Writes work again.', timeline: '' });
    }, 180_000);

    scenario('verification fails when a changed page is not copied back, and authority stays on Rust', ({ rust }) => ({
      // A write that lands on Rust after the copy and before the verification: the copy never saw it.
      beforeVerify: async () => {
        await rust.putPage('companies/widget-co', { type: 'note', title: 'companies/widget-co', compiled_truth: 'Changed after the copy.', timeline: '', frontmatter: { tags: [] } });
      },
    }), async w => {
      await writeAfterSwap(w.rust);
      const plan = await inHome(w, () => planFailback(w.deps));
      const error = await expectRefused(inHome(w, () => runFailback(w.deps, plan.plan_hash)), 'failback_mismatch');
      expect(error.message).toContain('companies/widget-co');
      expect(configEngine(w)).toBe('rust');
      expect(await primaryFenced(w.primary, RUN)).toBe(true);
      expect((await readGraduationRow(w.primary))!.state).toBe('cutover');
      const record = readSwapRecord(w.deps.recordPath)!;
      expect(record.failback!.state).toBe('copied');
      expect(record.failback!.error!.code).toBe('failback_mismatch');
    }, 180_000);

    scenario('a fact added on Rust after the swap refuses failback by name, before any write', undefined, async w => {
      await writeAfterSwap(w.rust);
      await w.rust.insertFact({ fact: 'Acme was founded after the swap', entity_slug: 'companies/acme-example', source: 'test' }, { source_id: 'default' });
      const error = await expectRefused(inHome(w, () => planFailback(w.deps)), 'failback_unavailable');
      expect(error.message).toContain('1 fact(s) were added on the Rust engine');
      expect(error.message).toContain('facts.event_type');
      expect((await w.primary.getPage('people/alice-example'))!.compiled_truth).toBe('Alice runs widget-co.');
      expect(configEngine(w)).toBe('rust');
    }, 120_000);

    scenario('a changed page with an image chunk refuses failback by name, before any write', undefined, async w => {
      await w.rust.upsertChunks('companies/widget-co', [{ chunk_index: 0, chunk_text: 'A company logo.', chunk_source: 'compiled_truth', modality: 'image' }]);
      const error = await expectRefused(inHome(w, () => planFailback(w.deps)), 'failback_unavailable');
      expect(error.message).toContain('companies/widget-co');
      expect(error.message).toContain('embedding_image');
      expect(configEngine(w)).toBe('rust');
    }, 120_000);

    scenario('failback refuses while a writer is active, before any write', () => ({ writers: async () => 'gbrain serve (pid 4242) holds the Rust store' }), async w => {
      await writeAfterSwap(w.rust);
      const plan = await inHome(w, () => planFailback({ ...w.deps, writers: async () => null }));
      const error = await expectRefused(inHome(w, () => runFailback(w.deps, plan.plan_hash)), 'brain_in_use');
      expect(error.message).toContain('pid 4242');
      expect((await w.primary.getPage('people/alice-example'))!.compiled_truth).toBe('Alice runs widget-co.');
      expect(await w.primary.getPage('companies/acme-example')).toBeNull();
      expect(configEngine(w)).toBe('rust');
      expect(await primaryFenced(w.primary, RUN)).toBe(true);
      expect(readSwapRecord(w.deps.recordPath)!.failback).toBeUndefined();
    }, 120_000);

    scenario('failback refuses without a succeeded swap, and on a changed plan', undefined, async w => {
      const record = readSwapRecord(w.deps.recordPath)!;
      writeSwapRecord(w.deps.recordPath, { ...record, state: 'verified', switch: undefined });
      await expectRefused(inHome(w, () => planFailback(w.deps)), 'failback_unavailable');
      writeSwapRecord(w.deps.recordPath, record);
      const plan = await inHome(w, () => planFailback(w.deps));
      await writeAfterSwap(w.rust);
      const changed = await inHome(w, () => runFailback(w.deps, plan.plan_hash)).then(() => null, (e: unknown) => e);
      expect((changed as OperationError).code).toBe('preview_changed');
      expect(configEngine(w)).toBe('rust');
    }, 120_000);
  });
}
