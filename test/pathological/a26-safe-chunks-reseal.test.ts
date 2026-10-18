/**
 * GBRA-130 A-26: \`gbrain repair safe-chunks\` re-seals pages chunked before the
 * safe-chunk fence (src/core/repair/safe-chunks.ts), and a managed
 * \`gbrain reindex\` delegates to it (src/commands/reindex.ts).
 *
 * Protects: a page whose re-seal throws (here a projection constraint error
 * from the chunk install) is reported as a held outcome
 * \`projection_unbuildable\` with the classified code and message, its chunks
 * stay as they were (withheld, the safe default), every later page is
 * re-sealed, and a rerun does not throw; a managed reindex counts it as failed
 * instead of failing the command. A run-scoped failure (connection lost, 25P02,
 * abort, a held writer) still stops the run.
 * Fails when: the apply rethrows anything but a revision conflict again (the
 * kind aborts at the same page id on every rerun and the managed reindex
 * never reaches contextual-mode).
 * Why new: test/safe-chunk-reseal.test.ts covers healthy re-seals only.
 * Seams: a test-only trigger on content_chunks builds the unbuildable page
 * directly; run-scoped errors are injected at the engine's transaction.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, runRepair } from '../../src/core/repair/core.ts';
import { safeChunksRepair } from '../../src/core/repair/safe-chunks.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runReindex } from '../../src/commands/reindex.ts';
import { _resetCliExitVerdictForTests } from '../../src/core/cli-force-exit.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const SLUGS = ['notes/a1', 'notes/a2', 'notes/a3', 'notes/a4'];
const POISON = 'notes/a2';
const quiet = { info() {}, warn() {}, error() {} };

/** Builds the bad state directly: every chunk insert for the poison page fails a constraint, as a projection that cannot be installed does. */
async function refuseChunksOf(engine: BrainEngine, slug: string) {
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION pathological_refuse_chunk() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF NEW.page_id = ${Number(page!.id)} THEN RAISE EXCEPTION 'pathological: chunk refused for this page' USING ERRCODE = 'check_violation'; END IF; RETURN NEW; END $fn$`);
  await engine.executeRaw('DROP TRIGGER IF EXISTS pathological_refuse_chunk ON content_chunks');
  await engine.executeRaw('CREATE TRIGGER pathological_refuse_chunk BEFORE INSERT OR UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION pathological_refuse_chunk()');
}

async function quietIo<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  const out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr);
  let stdout = '';
  (process.stdout.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => { stdout += String(chunk); return true; };
  (process.stderr.write as unknown as (chunk: unknown) => boolean) = () => true;
  try { return { result: await fn(), stdout }; } finally { process.stdout.write = out; process.stderr.write = err; }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('A-26 safe-chunks: one unbuildable page never stops the re-seal (' + backend + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close(); });
    afterEach(() => { _resetCliExitVerdictForTests(); process.exitCode = 0; });
    beforeEach(async () => {
      await engine.executeRaw('DROP TRIGGER IF EXISTS pathological_refuse_chunk ON content_chunks');
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [SOURCE]);
      for (const slug of SLUGS) {
        await importFromContent(engine, slug, '---\ntitle: ' + slug + '\ntype: note\n---\n\nBody of ' + slug + ' for the safe-chunk fixture, long enough to chunk.\n', { noEmbed: true, sourceId: SOURCE });
      }
      await engine.executeRaw('UPDATE pages SET chunker_version=1 WHERE source_id=$1', [SOURCE]);
      await engine.executeRaw('DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [SOURCE]);
    });
    const ctxOf = (e: BrainEngine = engine) => ({ engine: e, sourceId: SOURCE, remote: false as const, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: quiet }) as never;
    const run = async (e?: BrainEngine) => runRepair(ctxOf(e), safeChunksRepair, await resolveRepairScope(engine), { apply: true, embed: false });

    test('item case: an unbuildable page is held projection_unbuildable and every other page is re-sealed', async () => {
      await refuseChunksOf(engine, POISON);
      const before = await snapshotItems(engine, SOURCE);
      const result = await expectUnitNotAborted(() => run());
      expect(result).toMatchObject({ applied: 3, complete: true, failed: [] });
      expect(result.outcomes).toMatchObject({ held: 1 });
      const held = result.outcome_items?.find(o => o.outcome === 'held');
      expectItemFailure({ key: held?.item, code: held?.reason, fix: (held?.detail as { fix?: unknown } | undefined)?.fix }, { key: SOURCE + ':' + POISON, code: 'projection_unbuildable', fix: /gbrain repair safe-chunks --source default/ });
      expect(held?.detail).toMatchObject({ code: 'invalid_data', message: expect.stringContaining('chunk refused') });
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: SLUGS.filter(s => s !== POISON), progressFields: ['chunks'] });
      const [poison] = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, POISON]);
      expect(Number(poison!.chunker_version)).toBe(1);
      const rerun = await expectUnitNotAborted(() => run());
      expect(rerun.outcomes).toMatchObject({ held: 1 });
    });

    test('recovery case: once the page can be built again, the next run re-seals it', async () => {
      await refuseChunksOf(engine, POISON);
      await expectUnitNotAborted(() => run());
      await engine.executeRaw('DROP TRIGGER IF EXISTS pathological_refuse_chunk ON content_chunks');
      const before = await snapshotItems(engine, SOURCE);
      const result = await expectUnitNotAborted(() => run());
      expect(result).toMatchObject({ applied: 1, complete: true });
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: [POISON], progressFields: ['chunks'] });
    });

    test('breaker case: when every page is unbuildable the held outcomes trip item_failures_systemic and the run is not complete', async () => {
      for (let i = 5; i <= 8; i++) {
        await importFromContent(engine, 'notes/a' + i, '---\ntitle: notes/a' + i + '\ntype: note\n---\n\nBody of notes/a' + i + ' for the safe-chunk fixture, long enough to chunk.\n', { noEmbed: true, sourceId: SOURCE });
      }
      await engine.executeRaw('UPDATE pages SET chunker_version=1 WHERE source_id=$1', [SOURCE]);
      await engine.executeRaw('DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [SOURCE]);
      await engine.executeRaw(`CREATE OR REPLACE FUNCTION pathological_refuse_chunk() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION 'pathological: chunk refused for every page' USING ERRCODE = 'check_violation'; END $fn$`);
      await engine.executeRaw('DROP TRIGGER IF EXISTS pathological_refuse_chunk ON content_chunks');
      await engine.executeRaw('CREATE TRIGGER pathological_refuse_chunk BEFORE INSERT OR UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION pathological_refuse_chunk()');
      const before = await snapshotItems(engine, SOURCE);
      const result = await run();
      expect(result.stopped?.reason).toBe('item_failures_systemic');
      expect(result.complete).toBe(false);
      expect(result.applied).toBe(0);
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE));
      const again = await run();
      expect(again.stopped?.reason).toBe('item_failures_systemic');
    });

    test('a managed reindex counts the held page as failed instead of failing the command', async () => {
      await refuseChunksOf(engine, POISON);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      _resetCliExitVerdictForTests();
      const { result, stdout } = await expectUnitNotAborted(() => quietIo(() => runReindex(engine, ['--markdown', '--no-embed', '--json'])));
      expect(result.failed).toBe(1);
      expect(result.reindexed).toBe(3);
      expect(JSON.parse(stdout.trim().split('\n').pop()!)).toMatchObject({ failed: 1, reindexed: 3 });
    });

    for (const { name, error } of runScopedErrors()) {
      test('run case: a run-scoped ' + name + ' during a re-seal stops the run and holds nothing', async () => {
        const injected = error();
        const faulty = new Proxy(engine, { get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop === 'transaction' && typeof value === 'function') {
            return (...args: unknown[]) => new Error().stack?.includes('resealSafeChunks') ? Promise.reject(injected) : (value as Function).apply(target, args);
          }
          return typeof value === 'function' ? value.bind(target) : value;
        } }) as BrainEngine;
        const before = await snapshotItems(engine, SOURCE);
        let thrown: unknown;
        const result = await run(faulty).catch(err => { thrown = err; return null; });
        if (result) {
          expect(result.stopped?.reason).toBe('owner_unavailable');
          expect(result.outcomes?.held ?? 0).toBe(0);
        } else expect(thrown).toBe(injected);
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE));
      });
    }
  });
}
