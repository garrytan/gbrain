/**
 * GBRA-161 PR 1b probes on the managed atom writer (generations/managed.ts): a managed publication is admitted as create
 * members (new identities only), one managed_generation_activate request, then gated overwrite and retire members.
 *
 * Protects:
 *   1. #7013 on the managed writer: an honest empty re-extraction, and a re-extraction whose new atom failed to publish,
 *      retire nothing; the activation never happens and its retire member refuses revision_conflict.
 *   2. Managed vs unmanaged contention on one key: an unmanaged generation that lands on the key between a managed
 *      run's plan and its activation fences the activation (stale_generation); no member overwrites or retires, the
 *      prior atoms keep their content, and the new identity it created is an orphan candidate (doctor, cleanup listing).
 *   3. A crash between activation and the member requests (simulated: every member request ends without committing,
 *      as one a killed run never got to land): old and new atoms are both live (never neither), doctor counts the
 *      pending members, and the next run resumes them so each retirement commits exactly once.
 *   4. The same crash with two real retirements: after the resume both canonical files are gone.
 * Seams: the phase's _pages / _chat inputs (no paid call), a consumer:preparing fault hook, the generation:member
 * fault point. PGLite always, Postgres when DATABASE_URL is set.
 * Fails when: the activation skips its live recheck (1), its expected-generation fence (2), or the run skips
 * resumeManagedGenerationMembers (3, 4).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer, waitForWrites } from '../../src/core/persistence/service.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { operations } from '../../src/core/operations.ts';
import { OperationError, type OperationContext } from '../../src/core/ops/contract.ts';
import { atomGenerationAdapter, atomOwnerKey } from '../../src/core/generations/adapters/atoms.ts';
import { publishGeneration } from '../../src/core/generations/publish.ts';
import { listPendingMembers } from '../../src/core/generations/managed.ts';
import { generationsRepair } from '../../src/core/generations/repair.ts';
import { generationPendingCheck } from '../../src/commands/doctor/checks/generations.ts';
import { settleManagedGitEffects } from '../helpers/managed-brain.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const NOTE = 'notes/acme-example-plan';
const KEY = { kind: 'atom', sourceId: 'default', ownerKey: atomOwnerKey({ kind: 'page', slug: NOTE }) };
const body = (label: string) => '---\ntype: note\ntitle: Acme example plan\n---\n\n' + (label + ': the team ships small changes, measures each launch and reviews outcomes weekly. ').repeat(12) + '\n';

function stubChat(titles: string[]) {
  let calls = 0;
  const chat = async (_o: ChatOpts): Promise<ChatResult> => {
    calls++;
    const text = JSON.stringify(titles.map(title => ({ title, body: title + '.', atom_type: 'insight' })));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { chat, calls: () => calls };
}

const atoms = (engine: BrainEngine) => engine.executeRaw<{ slug: string; live: boolean; retired_by: string | null; body: string }>(
  "SELECT slug, deleted_at IS NULL AS live, frontmatter->>'retired_by' AS retired_by, compiled_truth AS body FROM pages WHERE source_id='default' AND type='atom' AND frontmatter->>'source_slug'=$1 ORDER BY slug", [NOTE]);
const slugOf = async (engine: BrainEngine, fragment: string) => (await atoms(engine)).find(row => row.slug.includes(fragment))!.slug;

async function extract(engine: BrainEngine, titles: string[]) {
  const stub = stubChat(titles);
  const page = (await engine.getPage(NOTE, { sourceId: 'default' }))!;
  const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: stub.chat, _transcripts: [],
    _pages: [{ slug: NOTE, content: page.compiled_truth, contentHash: page.content_hash! }] });
  await disposePersistenceConsumer(engine);
  return { status: result.status, calls: stub.calls() };
}

async function edit(ctx: OperationContext, label: string) {
  const snap = await ctx.engine.readPageSnapshot(NOTE, { sourceId: 'default' });
  await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: NOTE, content: body(label), ...(snap ? { expected_revision: snap.revision } : {}) });
  await disposePersistenceConsumer(ctx.engine);
}

/** Waits for every request the run left queued (a failed activation stops the run's own wait before its members). */
async function drain(engine: BrainEngine) {
  const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state IN ('queued','running','recovering')");
  await waitForWrites(engine, pending, { engine: engine.kind } as GBrainConfig, 60_000);
  await disposePersistenceConsumer(engine);
}

const requestsOf = (engine: BrainEngine, kind: string) => engine.executeRaw<{ slug: string; state: string; error_code: string | null; intent: Record<string, unknown> }>(
  "SELECT slug, state, error_code, intent FROM persistence_requests WHERE source_id='default' AND intent->>'kind'=$1 ORDER BY sequence", [kind]);
const activations = (engine: BrainEngine) => engine.executeRaw<{ id: string; state: string; members: Array<{ slug: string; action: string }> }>(
  'SELECT id, state, members FROM derived_generation_activations ORDER BY created_at, id');
const liveGeneration = async (engine: BrainEngine) => (await engine.executeRaw<{ generation: number }>(
  "SELECT generation FROM derived_generations WHERE source_id='default' AND kind='atom' AND owner_key=$1 AND state='live'", [KEY.ownerKey]))[0]?.generation ?? null;

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('GBRA-161 PR 1b managed atom generation probes (' + backend + ')', () => {
    test('probe 1 (#7013): an empty re-extraction and one whose new atom failed both retire nothing', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await edit(ctx, 'first');
        expect((await extract(engine, ['Ship small changes', 'Review outcomes weekly', 'Measure each launch'])).status).toBe('ok');
        expect((await atoms(engine)).map(row => row.live)).toEqual([true, true, true]);
        await edit(ctx, 'second');
        await extract(engine, []);
        expect((await atoms(engine)).map(row => [row.live, row.retired_by])).toEqual([[true, null], [true, null], [true, null]]);
        expect(await requestsOf(engine, 'managed_atom_delete')).toEqual([]);

        await edit(ctx, 'third');
        let fired = false;
        installFaultHook(async (point, detail) => {
          if (fired || point !== 'consumer:preparing' || !detail.writeId) return;
          const [row] = await engine.executeRaw<{ slug: string; kind: string | null }>("SELECT slug, intent->>'kind' AS kind FROM persistence_requests WHERE id=$1::uuid", [detail.writeId]);
          if (row?.kind !== 'managed_atom_page' || !row.slug.includes('track-error-budgets')) return;
          fired = true;
          throw new OperationError('revision_conflict', 'Page ' + row.slug + ' changed after the atom batch was accepted.', 'Run the atom drain again.');
        });
        try { await extract(engine, ['Ship small changes', 'Review outcomes weekly', 'Track error budgets']).catch(() => undefined); }
        finally { installFaultHook(undefined); }
        expect(fired).toBe(true);
        await drain(engine);
        const after = await atoms(engine);
        expect(after.filter(row => row.slug.includes('measure-each-launch'))).toEqual([expect.objectContaining({ live: true, retired_by: null })]);
        expect(after.some(row => row.slug.includes('track-error-budgets') && row.live)).toBe(false);
        const deletes = await requestsOf(engine, 'managed_atom_delete');
        expect(deletes.map(row => [row.state === 'committed', row.error_code])).toEqual([[false, 'revision_conflict']]);
        expect((await activations(engine)).at(-1)!.state).toBe('pending');
      }, { databaseUrl });
    }, 240_000);

    test('probe 2: an unmanaged generation landing between plan and activation fences it; nothing is overwritten or retired', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await edit(ctx, 'first');
        await extract(engine, ['Ship small changes', 'Review outcomes weekly', 'Measure each launch']);
        const before = await atoms(engine);
        const measure = await slugOf(engine, 'measure-each-launch');
        expect(await liveGeneration(engine)).toBe(1);
        await edit(ctx, 'second');
        let landed = false;
        installFaultHook(async (point, detail) => {
          if (landed || point !== 'consumer:preparing' || !detail.writeId) return;
          const [row] = await engine.executeRaw<{ kind: string | null }>("SELECT intent->>'kind' AS kind FROM persistence_requests WHERE id=$1::uuid", [detail.writeId]);
          if (row?.kind !== 'managed_generation_activate') return;
          landed = true;
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
          try {
            const outcome = await publishGeneration(engine, atomGenerationAdapter, { key: KEY, items: [], approved: { retire: [], retiredBy: 'stale-atoms' } });
            expect(outcome.state).toBe('unchanged');
            await engine.executeRaw("UPDATE derived_generations SET generation=generation+1 WHERE source_id='default' AND kind='atom' AND owner_key=$1 AND state='live'", [KEY.ownerKey]);
          } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
        });
        try { await extract(engine, ['Ship small changes', 'Review outcomes weekly', 'Track error budgets']).catch(() => undefined); }
        finally { installFaultHook(undefined); }
        expect(landed).toBe(true);
        await drain(engine);
        expect(await liveGeneration(engine)).toBe(2);
        const [activation] = (await activations(engine)).slice(-1);
        expect(activation!.state).toBe('pending');
        const after = await atoms(engine);
        for (const prior of before) expect(after.find(row => row.slug === prior.slug)).toMatchObject({ live: true, retired_by: null, body: prior.body });
        expect(after.find(row => row.slug === measure)?.live).toBe(true);
        const created = after.find(row => row.slug.includes('track-error-budgets'))!;
        expect(created.live).toBe(true);
        expect((await requestsOf(engine, 'managed_atom_delete')).every(row => row.state !== 'committed')).toBe(true);
        expect((await requestsOf(engine, 'managed_atom_page')).filter(row => row.intent.phase === 'overwrite').every(row => row.state !== 'committed')).toBe(true);
        const doctor = await generationPendingCheck(engine, ['default']);
        expect(doctor.status).toBe('warn');
        expect(doctor.details).toMatchObject({ orphans: 1, orphan_candidates: [{ slug: created.slug, activation_id: activation!.id }] });
        const listing = await generationsRepair.plan(engine, { brain_id: 'brain', source_ids: ['default'] }, null,
          { apply: false, generations: { kind: 'atom', mode: 'cleanup', since: new Date(0).toISOString() } });
        expect(listing.listing).toEqual([expect.objectContaining({ item: 'default:' + created.slug, class: 'orphan_candidate' })]);
        expect(after.find(row => row.slug === created.slug)?.retired_by ?? null).toBeNull();
      }, { databaseUrl });
    }, 240_000);

    for (const files of [false, true]) {
      test('probe ' + (files ? '4: a two-file retirement resumed after a crash leaves both canonical files gone'
        : '3: a crash between activation and its members leaves old and new live; the next run retires each once'), async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await edit(ctx, 'first');
          await extract(engine, ['Ship small changes', 'Review outcomes weekly', 'Measure each launch', 'Pair on reviews']);
          await settleManagedGitEffects(engine);
          const retiring = [await slugOf(engine, 'measure-each-launch'), await slugOf(engine, 'pair-on-reviews')];
          if (files) for (const slug of retiring) expect(existsSync(join(root, slug + '.md'))).toBe(true);
          await edit(ctx, 'second');
          let crashes = 0;
          installFaultHook(async point => { if (point === 'generation:member') { crashes++; throw new OperationError('revision_conflict', 'Simulated crash: the member request never landed.', 'Run the atom drain again.'); } });
          try { await extract(engine, ['Ship small changes', 'Review outcomes weekly', 'Track error budgets']).catch(() => undefined); await drain(engine); }
          finally { installFaultHook(undefined); }
          expect(crashes).toBeGreaterThan(0);
          const mid = await atoms(engine);
          for (const slug of retiring) expect(mid.find(row => row.slug === slug)?.live).toBe(true);
          expect(mid.find(row => row.slug.includes('track-error-budgets'))?.live).toBe(true);
          expect((await activations(engine)).at(-1)!.state).toBe('activated');
          const pending = await listPendingMembers(engine, ['default'], 'atom');
          expect(pending.filter(row => row.action === 'retire').map(row => row.slug).sort()).toEqual([...retiring].sort());
          expect((await generationPendingCheck(engine, ['default'])).details).toMatchObject({ retire_pending: 2 });

          await extract(engine, ['Ship small changes', 'Review outcomes weekly', 'Track error budgets']);
          await extract(engine, ['Ship small changes', 'Review outcomes weekly', 'Track error budgets']);
          const after = await atoms(engine);
          for (const slug of retiring) expect(after.find(row => row.slug === slug)).toMatchObject({ live: false, retired_by: 'managed-reextract' });
          expect(await listPendingMembers(engine, ['default'], 'atom')).toEqual([]);
          expect((await generationPendingCheck(engine, ['default'])).status).toBe('ok');
          const committed = (await requestsOf(engine, 'managed_atom_delete')).filter(row => row.state === 'committed').map(row => row.slug).sort();
          expect(committed).toEqual([...retiring].sort());
          if (files) {
            await settleManagedGitEffects(engine);
            for (const slug of retiring) expect(existsSync(join(root, slug + '.md'))).toBe(false);
          }
        }, { databaseUrl });
      }, 240_000);
    }
  });
}
