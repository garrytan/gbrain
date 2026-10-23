/**
 * GBRA-161 PR 1a: the generation primitive and `gbrain repair generations`.
 *
 * Protects: a derived result replaces the live generation only whole and only when it may: a complete successor retires
 * what it dropped (versioned, stamped, preimage on the ledger) in the transaction that activates it; a shrink below the
 * floor, an empty result without proof, an oversize result and a stale or moved producer are held or fenced with nothing
 * retired; an identical replay is a no-op; an unrecorded row naming the key is retired only on retained producer
 * evidence; restore republishes the replaced generation and refuses an item edited since; release-held publishes a held
 * result once and refuses one that lacks proof; purge scrubs ledger copies; every printed preview command parses.
 * Fails when: any retirement happens outside a complete activation, or the repair writes more or other than its preview.
 * Seams: a synthetic page kind (test/helpers/synthetic-generation.ts) whose input the test sets. PGLite always, Postgres
 * when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { publishGeneration, heldForInput } from '../../src/core/generations/publish.ts';
import { originGone } from '../../src/core/generations/proofs.ts';
import { generationsPreviewArgv, type GenerationsSelection } from '../../src/core/generations/repair.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairPreviewCommand, repairRunner } from '../../src/core/repair/registry.ts';
import { parseRepairArgs } from '../../src/commands/repair.ts';
import { generationHeldCheck, generationRetirementsCheck } from '../../src/commands/doctor/checks/generations.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { liveSlugs, setSyntheticInput, syntheticAdapter, syntheticItem, syntheticKey } from '../helpers/synthetic-generation.ts';
import { pathologicalArms } from './harness.ts';

const OWNER = 'owner:notes/source-a';
const key = syntheticKey('default', OWNER);
const slug = (name: string) => `derived/${name}`;
const items = (spec: Record<string, string>) => Object.entries(spec).map(([name, body]) => syntheticItem(OWNER, slug(name), body));
const input = (pin: string, size = 100) => ({ pin, size });

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-g1-'));
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

async function publish(engine: BrainEngine, spec: Record<string, string>, pin: string, extra: Partial<Parameters<typeof publishGeneration>[2]> = {}) {
  setSyntheticInput(key, input(pin));
  return publishGeneration(engine, syntheticAdapter, { key, items: items(spec), input: input(pin), ...extra });
}

const FOUR = { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.', d: 'Delta claim.' };

async function repair(engine: BrainEngine, selection: GenerationsSelection, expect?: string): Promise<RepairResult> {
  const scope = await resolveRepairScope(engine, 'default');
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  return (await repairRunner(engine, { apply: expect !== undefined, noEmbed: true, logger: quiet })).run('generations', scope,
    { explicit: true, sourceFlag: 'default', generations: selection, ...(expect ? { expect } : {}) });
}

const retiredBy = async (engine: BrainEngine, name: string) => (await engine.executeRaw<{ deleted: boolean; retired_by: string | null }>(
  "SELECT deleted_at IS NOT NULL AS deleted, frontmatter->>'retired_by' AS retired_by FROM pages WHERE slug=$1", [slug(name)]))[0];
const body = async (engine: BrainEngine, name: string) => (await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [slug(name)]))[0]?.compiled_truth;

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 generation primitive (${backend})`, () => {
    test('a complete successor retires what it dropped, versioned and stamped, with its preimage on the ledger', async () => {
      await withBrain(databaseUrl, async engine => {
        const first = await publish(engine, FOUR, 'pin-1');
        expect(first).toMatchObject({ state: 'published', generation: 1 });
        const second = await publish(engine, { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.' }, 'pin-2');
        expect(second).toMatchObject({ state: 'published', generation: 2, retired: [slug('d')] });
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a'), slug('b'), slug('c')]);
        expect(await retiredBy(engine, 'd')).toEqual({ deleted: true, retired_by: 'extract-atoms' });
        const [ledger] = await engine.executeRaw<{ action: string; has_preimage: boolean }>(`SELECT i.action, i.preimage IS NOT NULL AS has_preimage
          FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id WHERE g.state='live' AND i.item_key=$1`, [slug('d')]);
        expect(ledger).toEqual({ action: 'retired', has_preimage: true });
        expect((await generationRetirementsCheck(engine, ['default'])).details).toMatchObject({ items: 1, keys: 1 });
      });
    }, 120_000);

    test('a shrink below the floor is held with nothing retired, and the same input is not recomputed', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, FOUR, 'pin-1');
        const held = await publish(engine, { a: 'Alpha claim.' }, 'pin-2');
        expect(held).toMatchObject({ state: 'held', reason: 'shrunk' });
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a'), slug('b'), slug('c'), slug('d')]);
        expect(await heldForInput(engine, key, 'pin-2')).toBe(true);
        const check = await generationHeldCheck(engine, ['default']);
        expect(check.status).toBe('warn');
        expect(check.fix?.argv).toEqual(generationsPreviewArgv({ kind: 'synthetic', sourceId: 'default' }, 'release-held'));
      });
    }, 120_000);

    test('an empty result retires nothing without proof; originGone retires the generation once the input is gone', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, { a: 'Alpha claim.' }, 'pin-1');
        expect(await publish(engine, {}, 'pin-2')).toMatchObject({ state: 'held', reason: 'no_proof' });
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a')]);
        setSyntheticInput(key, null);
        const gone = await publishGeneration(engine, syntheticAdapter, { key, items: [], proof: originGone() });
        expect(gone).toMatchObject({ state: 'published', retired: [slug('a')] });
        expect(await liveSlugs(engine, OWNER)).toEqual([]);
      });
    }, 120_000);

    test('a result past generations.max_items is held oversize', async () => {
      await withBrain(databaseUrl, async engine => {
        await engine.setConfig('generations.max_items', '8');
        const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`n${i}`, `Claim number ${i}.`]));
        expect(await publish(engine, nine, 'pin-1')).toMatchObject({ state: 'held', reason: 'oversize' });
        expect(await liveSlugs(engine, OWNER)).toEqual([]);
      });
    }, 120_000);

    test('a stale or moved producer is fenced and writes nothing; an identical replay changes nothing', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, { a: 'Alpha claim.' }, 'pin-1');
        const stale = await publish(engine, { b: 'Beta claim.' }, 'pin-1', { expectedGeneration: 0 }).catch(error => error);
        expect(stale).toBeInstanceOf(OperationError);
        expect((stale as OperationError).code).toBe('generation_fenced');
        setSyntheticInput(key, input('pin-moved'));
        const moved = await publishGeneration(engine, syntheticAdapter, { key, items: items({ b: 'Beta claim.' }), input: input('pin-1') }).catch(error => error);
        expect((moved as OperationError).code).toBe('generation_fenced');
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a')]);
        const replay = await publish(engine, { a: 'Alpha claim.' }, 'pin-1');
        expect(replay.state).toBe('unchanged');
        expect((await engine.executeRaw('SELECT 1 FROM derived_generations')).length).toBe(1);
      });
    }, 120_000);

    test('an unrecorded row naming the key is protected without producer evidence and retired with it', async () => {
      await withBrain(databaseUrl, async engine => {
        await engine.putPage(slug('hand'), { type: 'note', title: 'hand', compiled_truth: 'A hand-written note.', frontmatter: { synthetic_owner: OWNER } });
        await engine.putPage(slug('legacy'), { type: 'note', title: 'legacy', compiled_truth: 'An older derived claim.', frontmatter: { synthetic_owner: OWNER, synthetic_producer: 'synthetic' } });
        await engine.createVersion(slug('legacy'), { sourceId: 'default' });
        await engine.setConfig('generations.shrink_floor', '0.05');
        const outcome = await publish(engine, { a: 'Alpha claim.' }, 'pin-1');
        expect(outcome).toMatchObject({ state: 'published', retired: [slug('legacy')], protected: [slug('hand')] });
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a'), slug('hand')]);
      });
    }, 120_000);

    test('restore republishes the replaced generation from the preview it bound, retiring what the generation added', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, FOUR, 'pin-1');
        await publish(engine, { a: 'Alpha claim, revised.', b: 'Beta claim.', c: 'Gamma claim.', e: 'Epsilon claim.' }, 'pin-2');
        const selection: GenerationsSelection = { kind: 'synthetic', mode: 'restore', key: OWNER };
        const preview = await repair(engine, selection);
        expect(preview.listing).toEqual([{ item: `default:${OWNER}`, class: 'restore', detail: 'generation 2 back to 1: revive 2, retire 1' }]);
        expect(preview.apply_command).toContain(`--expect ${preview.preview_hash}`);
        const applied = await repair(engine, selection, preview.preview_hash);
        expect(applied.outcomes).toEqual({ restored: 1 });
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a'), slug('b'), slug('c'), slug('d')]);
        expect(await body(engine, 'a')).toContain('Alpha claim.');
        expect(await body(engine, 'a')).not.toContain('revised');
        expect(await retiredBy(engine, 'e')).toEqual({ deleted: true, retired_by: 'generation-restore' });
        const [live] = await engine.executeRaw<{ generation: number; restore_of: number | null }>("SELECT generation, restore_of FROM derived_generations WHERE state='live'");
        expect(Number(live!.generation)).toBe(3);
        expect(live!.restore_of).not.toBeNull();
      });
    }, 120_000);

    test('restore refuses a key with an item edited since, leaving every item of it unchanged', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, FOUR, 'pin-1');
        await publish(engine, { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.', e: 'Epsilon claim.' }, 'pin-2');
        await engine.putPage(slug('e'), { type: 'note', title: 'e', compiled_truth: 'Epsilon, edited by hand.', frontmatter: { synthetic_owner: OWNER, synthetic_producer: 'synthetic' } });
        const selection: GenerationsSelection = { kind: 'synthetic', mode: 'restore', key: OWNER };
        const preview = await repair(engine, selection);
        expect(preview.listing?.[0]).toMatchObject({ class: 'refused' });
        expect(preview.listing?.[0]?.detail).toContain(`${slug('e')}: edited_since`);
        const applied = await repair(engine, selection, preview.preview_hash);
        expect(applied.outcomes).toEqual({ refused: 1 });
        expect(applied.stopped?.reason).toBe('incomplete');
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a'), slug('b'), slug('c'), slug('e')]);
        expect(await body(engine, 'e')).toContain('edited by hand');
      });
    }, 120_000);

    test('release-held publishes a held shrink once and refuses a held result that lacks proof', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, FOUR, 'pin-1');
        await publish(engine, { a: 'Alpha claim.' }, 'pin-2');
        const selection: GenerationsSelection = { kind: 'synthetic', mode: 'release-held', held: true };
        const preview = await repair(engine, selection);
        expect(preview.listing).toEqual([expect.objectContaining({ class: 'release-held' })]);
        const applied = await repair(engine, selection, preview.preview_hash);
        expect(applied.outcomes).toEqual({ released: 1 });
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a')]);
        expect(await publish(engine, {}, 'pin-3')).toMatchObject({ state: 'held', reason: 'no_proof' });
        const noProof = await repair(engine, selection);
        expect(noProof.listing).toEqual([expect.objectContaining({ class: 'refused', detail: expect.stringContaining('no_proof is not releasable') })]);
        expect(await liveSlugs(engine, OWNER)).toEqual([slug('a')]);
      });
    }, 120_000);

    test('purging a page scrubs its preimages from the ledger, and restore then refuses it', async () => {
      await withBrain(databaseUrl, async engine => {
        await publish(engine, FOUR, 'pin-1');
        await publish(engine, { a: 'Alpha claim.', b: 'Beta claim.', c: 'Gamma claim.' }, 'pin-2');
        const { scrubGenerationLedger } = await import('../../src/core/generations/ledger-scrub.ts');
        expect(await scrubGenerationLedger(engine, 'default', { slug: slug('d') })).toEqual({ derived_generation_items: 1, derived_generations: 0 });
        const preview = await repair(engine, { kind: 'synthetic', mode: 'restore', key: OWNER });
        expect(preview.listing?.[0]?.detail).toContain(`${slug('d')}: no_preimage`);
      });
    }, 120_000);

    test('every preview command the generations surfaces print parses as a valid repair invocation', async () => {
      const commands = [repairPreviewCommand('generations').split(' '), repairPreviewCommand('generations', { source: 'default' }).split(' '),
        generationsPreviewArgv({ kind: 'atom' }), generationsPreviewArgv({ kind: 'atom', sourceId: 'default' }, 'release-held'),
        generationsPreviewArgv({ kind: 'atom', ownerKey: 'source_slug:notes/a', sourceId: 'default' })];
      for (const argv of commands) {
        expect(argv.slice(0, 3)).toEqual(['gbrain', 'repair', 'generations']);
        const parsed = parseRepairArgs(argv.slice(2));
        expect(parsed.kind).toBe('generations');
        expect(parsed.generationKind).toBe('atom');
        expect(Boolean(parsed.since || parsed.held || parsed.key)).toBe(true);
      }
    });
  });
}
