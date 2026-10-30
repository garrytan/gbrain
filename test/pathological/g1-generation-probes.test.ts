/**
 * GBRA-161 PR 1a: the primitive's remaining edges, each on the synthetic adapter unless named.
 *
 * Protects: (a) concurrent first publications of one key leave one live row (identical results replay, a different
 * result is fenced) and no duplicate items; (b) a successor item deleted between publish and activation fails activation
 * with `generation_live_conflict` and nothing commits or retires; (c) a different result on the same pin gets a fresh
 * operation identity, is fenced by the expected generation and is never a replay; (d) a strict-order result with a tie
 * holds and retires nothing, while a strictly ordered one closes with restorable retirements (#6023 shape); (e) a missing
 * or uncommitted input cannot mint `committedRemoval` (#7130/#7141 shape); (f) a CLI restore with a refused key exits
 * non-zero and lists the key; (g) three terminal failures on one hold identity hold the result `attempts_exhausted` with
 * the last three codes, later runs stop there, and `--mode release-held` publishes it once.
 * Seams: test/helpers/synthetic-generation.ts. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GenerationAdapter } from '../../src/core/generations/contract.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { committedRemoval } from '../../src/core/generations/proofs.ts';
import { publishGeneration, type PublishRequest } from '../../src/core/generations/publish.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { runRepairCommand } from '../../src/commands/repair.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { liveSlugs, setSyntheticInput, strictSyntheticAdapter, syntheticAdapter, syntheticItem, syntheticKey } from '../helpers/synthetic-generation.ts';
import { pathologicalArms } from './harness.ts';

const OWNER = 'owner:notes/probe-source';
const key = syntheticKey('default', OWNER);
const slug = (name: string) => `derived/${name}`;
const items = (spec: Record<string, string>, ranked = false) => Object.entries(spec).map(([name, body], index) => syntheticItem(OWNER, slug(name), body, ranked ? index + 1 : undefined));
const FOUR = { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.', d: 'Delta claim.' };

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-g1p-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        await run(engine);
      } finally { await close(); setSyntheticInput(key, null); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

function publish(engine: BrainEngine, spec: Record<string, string>, pin: string, extra: Partial<PublishRequest<undefined>> = {}, adapter: GenerationAdapter<undefined> = syntheticAdapter) {
  setSyntheticInput(key, { pin, size: 100 });
  return publishGeneration(engine, adapter, { key, items: items(spec, adapter.strictOrder), input: { pin, size: 100 }, ...extra });
}
const codeOf = (error: unknown) => error instanceof OperationError ? error.code : String(error);
const ledger = async (engine: BrainEngine) => (await engine.executeRaw<{ generation: number; state: string }>('SELECT generation, state FROM derived_generations ORDER BY id'))
  .map(row => `${row.state}:${Number(row.generation)}`);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 generation probes (${backend})`, () => {
    test('concurrent first publications leave one live row: identical results replay, a different result is fenced', async () => {
      await withBrain(databaseUrl, async engine => {
        setSyntheticInput(key, { pin: 'pin-1', size: 100 });
        const same = await Promise.allSettled(Array.from({ length: 4 }, () => publishGeneration(engine, syntheticAdapter, { key, items: items(FOUR), input: { pin: 'pin-1', size: 100 } })));
        expect(same.map(result => result.status === 'fulfilled' ? result.value.state : codeOf(result.reason)).sort()).toEqual(['published', 'unchanged', 'unchanged', 'unchanged']);
        expect(await ledger(engine)).toEqual(['live:1']);
        const [count] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM derived_generation_items');
        expect(Number(count!.n)).toBe(4);
      });
      await withBrain(databaseUrl, async engine => {
        setSyntheticInput(key, { pin: 'pin-1', size: 100 });
        const racing = await Promise.allSettled([FOUR, { e: 'Epsilon claim.' }].map(spec =>
          publishGeneration(engine, syntheticAdapter, { key, items: items(spec), input: { pin: 'pin-1', size: 100 }, expectedGeneration: 0 })));
        expect(racing.map(result => result.status === 'fulfilled' ? result.value.state : codeOf(result.reason)).sort()).toEqual(['generation_fenced', 'published']);
        expect(await ledger(engine)).toEqual(['live:1']);
        const live = await liveSlugs(engine, OWNER);
        expect([[slug('a'), slug('b'), slug('c'), slug('d')], [slug('e')]]).toContainEqual(live);
      });
    }, 120_000);

    test('a successor item deleted between publish and activation fails activation; nothing commits or retires', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, FOUR, 'pin-1');
        const hiding: GenerationAdapter<undefined> = { ...syntheticAdapter, async publishItems(tx, k, written, context) {
          await syntheticAdapter.publishItems(tx, k, written, context);
          await tx.softDeletePages([slug('e')], { sourceId: k.sourceId });
        } };
        const failed = await publish(engine, { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.', e: 'Epsilon claim.' }, 'pin-2', {}, hiding).catch(error => error);
        expect(codeOf(failed)).toBe('generation_live_conflict');
        expect(await ledger(engine)).toEqual(['live:1']);
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a'), slug('b'), slug('c'), slug('d')]);
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1', [slug('e')])).toEqual([]);
      });
    }, 120_000);

    test('a different result on the same pin gets a fresh identity: fenced by the expected generation, never a replay', async () => {
      await withBrain(databaseUrl, async engine => {
        expect(await publish(engine, FOUR, 'pin-1', { expectedGeneration: 0 })).toMatchObject({ state: 'published', generation: 1 });
        const stale = await publish(engine, { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.', e: 'Epsilon claim.' }, 'pin-1', { expectedGeneration: 0 }).catch(error => error);
        expect(codeOf(stale)).toBe('generation_fenced');
        expect((stale as OperationError).reason).toBe('stale_generation');
        expect(await publish(engine, FOUR, 'pin-1', { expectedGeneration: 0 })).toMatchObject({ state: 'unchanged', generation: 1 });
        const next = await publish(engine, { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.', e: 'Epsilon claim.' }, 'pin-1', { expectedGeneration: 1 });
        expect(next).toMatchObject({ state: 'published', generation: 2, retired: [slug('d')] });
        const ops = await engine.executeRaw<{ operation_id: string }>('SELECT operation_id FROM derived_generations ORDER BY id');
        expect(new Set(ops.map(row => row.operation_id)).size).toBe(2);
      });
    }, 120_000);

    test('a strict-order result with a tie holds and retires nothing; a strictly ordered one closes with restorable retirements', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, FOUR, 'pin-1', {}, strictSyntheticAdapter);
        setSyntheticInput(key, { pin: 'pin-2', size: 100 });
        const tied = [syntheticItem(OWNER, slug('a'), 'Alpha claim.', 1), syntheticItem(OWNER, slug('b'), 'Beta claim.', 2), syntheticItem(OWNER, slug('c'), 'Gamma claim.', 2)];
        expect(await publishGeneration(engine, strictSyntheticAdapter, { key, items: tied, input: { pin: 'pin-2', size: 100 } })).toMatchObject({ state: 'held', reason: 'tie' });
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a'), slug('b'), slug('c'), slug('d')]);
        const ordered = await publish(engine, { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.' }, 'pin-2', {}, strictSyntheticAdapter);
        expect(ordered).toMatchObject({ state: 'published', retired: [slug('d')] });
        const [retired] = await engine.executeRaw<{ has_preimage: boolean }>(`SELECT i.preimage IS NOT NULL AS has_preimage FROM derived_generation_items i
          JOIN derived_generations g ON g.id=i.generation_id WHERE g.state='live' AND i.action='retired'`);
        expect(retired).toEqual({ has_preimage: true });
      });
    }, 120_000);

    test('a missing or uncommitted input cannot mint committedRemoval; the committed removal retires', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, { a: 'Alpha claim.' }, 'pin-1');
        setSyntheticInput(key, null);
        expect(await publishGeneration(engine, syntheticAdapter, { key, items: [], proof: committedRemoval('pin-2') })).toMatchObject({ state: 'held', reason: 'no_proof' });
        setSyntheticInput(key, { pin: 'pin-3', size: 0 });
        expect(await publishGeneration(engine, syntheticAdapter, { key, items: [], proof: committedRemoval('pin-2') })).toMatchObject({ state: 'held', reason: 'no_proof' });
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a')]);
        setSyntheticInput(key, { pin: 'pin-2', size: 0 });
        expect(await publishGeneration(engine, syntheticAdapter, { key, items: [], proof: committedRemoval('pin-2'), input: { pin: 'pin-2', size: 0 } }))
          .toMatchObject({ state: 'published', retired: [slug('a')] });
      });
    }, 120_000);

    test('a CLI restore with a refused key exits non-zero and lists the key', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, FOUR, 'pin-1');
        await publish(engine, { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.', e: 'Epsilon claim.' }, 'pin-2');
        await engine.putPage(slug('e'), { type: 'note', title: 'e', compiled_truth: 'Epsilon, edited by hand.', frontmatter: { synthetic_owner: OWNER, synthetic_producer: 'synthetic' } });
        const scope = await resolveRepairScope(engine, 'default');
        const quiet = { info: () => {}, warn: () => {}, error: () => {} };
        const preview = await (await repairRunner(engine, { apply: false, logger: quiet })).run('generations', scope,
          { explicit: true, sourceFlag: 'default', generations: { kind: 'synthetic', mode: 'restore', key: OWNER } });
        const lines: string[] = [];
        const log = console.log, err = console.error;
        console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
        console.error = () => {};
        try {
          await runRepairCommand(engine, ['generations', '--kind', 'synthetic', '--key', OWNER, '--source', 'default', '--apply', '--expect', preview.preview_hash!, '--yes', '--json']);
          expect(currentExitCode()).toBe(1);
        } finally { console.log = log; console.error = err; _resetCliExitVerdictForTests(); process.exitCode = 0; }
        const out = JSON.parse(lines.join('\n')) as { results: Array<{ stopped?: { reason: string; message: string }; outcome_items?: Array<{ item: string; outcome: string }> }> };
        expect(out.results[0]!.stopped?.reason).toBe('incomplete');
        expect(out.results[0]!.stopped?.message).toContain(`${slug('e')}: edited_since`);
        expect(out.results[0]!.outcome_items).toEqual([expect.objectContaining({ item: `default:${OWNER}`, outcome: 'refused' })]);
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a'), slug('b'), slug('c'), slug('e')]);
      });
    }, 120_000);

    test('three terminal failures on one hold identity hold attempts_exhausted with the last three codes; release-held publishes it once', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, FOUR, 'pin-1');
        let calls = 0;
        const failing: GenerationAdapter<undefined> = { ...syntheticAdapter, async publishItems() { calls++; throw Object.assign(new Error('synthetic write failure'), { code: `E_SYNTH_${calls}` }); } };
        const next = { a: 'Alpha claim, revised.', b: 'Beta claim.', c: 'Gamma claim.', d: 'Delta claim.' };
        for (let i = 1; i <= 3; i++) expect(String(await publish(engine, next, 'pin-2', {}, failing).catch(error => error.code))).toBe(`E_SYNTH_${i}`);
        const stopped = await publish(engine, next, 'pin-2', {}, failing);
        expect(stopped).toMatchObject({ state: 'held', reason: 'attempts_exhausted' });
        expect(calls).toBe(3);
        const [held] = await engine.executeRaw<{ held_reason: string; held_context: { codes: string[] } }>("SELECT held_reason, held_context FROM derived_generations WHERE state='held'");
        expect(held?.held_reason).toBe('attempts_exhausted');
        expect(held?.held_context.codes).toEqual(['E_SYNTH_1', 'E_SYNTH_2', 'E_SYNTH_3']);
        expect(await engine.executeRaw('SELECT 1 FROM derived_generation_attempts')).toEqual([]);
        const scope = await resolveRepairScope(engine, 'default');
        const quiet = { info: () => {}, warn: () => {}, error: () => {} };
        const selection = { kind: 'synthetic', mode: 'release-held' as const, held: true };
        const preview = await (await repairRunner(engine, { apply: false, logger: quiet })).run('generations', scope, { explicit: true, sourceFlag: 'default', generations: selection });
        expect(preview.listing).toEqual([expect.objectContaining({ class: 'release-held', detail: expect.stringContaining('held attempts_exhausted') })]);
        const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('generations', scope,
          { explicit: true, sourceFlag: 'default', generations: selection, expect: preview.preview_hash });
        expect(applied.outcomes).toEqual({ released: 1 });
        expect(await ledger(engine)).toEqual(['superseded:1', 'live:2']);
        expect((await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [slug('a')]))[0]!.compiled_truth).toContain('revised');
      });
    }, 120_000);
  });
}
