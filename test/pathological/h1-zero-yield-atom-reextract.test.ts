/**
 * H-1 (#7013): a zero-yield re-extraction never retires an existing atom generation.
 *
 * Protects: on a managed brain, a page whose atoms were published once is edited and re-extracted; the model
 * honestly returns `[]`. The prior atom stays live (no `retired_by`), the scan state advances for the new
 * content (the completed `managed-atoms` checkpoint and the page state, so the next run makes no model call), and
 * `gbrain repair stale-atoms` does not list the kept atom. A later non-empty extraction still retires it, and an
 * unmanaged brain agrees with the managed one. A partial publish retires nothing either: when the batch's re-written
 * atom conflicts (it was edited between admission and publication), the batch's retirement of another atom is
 * refused and that atom stays live.
 * Seams: the phase's `_pages` / `_chat` test inputs (no paid call), and a `consumer:preparing` fault hook that makes
 * the re-written atom's preparation fail `revision_conflict`, as a concurrent edit of that atom would.
 * Fails when: `publishManagedAtoms(..., [])` computes retirements for every prior atom of the origin and
 * soft-deletes them with `retired_by: managed-reextract` (master before the fix), or the stale-atoms preview counts
 * a zero-yield completion as a replacement.
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer, waitForWrites } from '../../src/core/persistence/service.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { staleAtomsRepair } from '../../src/core/repair/stale-atoms.ts';
import { operations } from '../../src/core/operations.ts';
import { OperationError, type OperationContext } from '../../src/core/ops/contract.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const NOTE = 'notes/acme-example-launch';
const body = (label: string) => `---\ntype: note\ntitle: Acme example launch\n---\n\n${`${label}: the team measures every launch against exit criteria and reviews them weekly. `.repeat(12)}\n`;

function stubChat(titles: string[]) {
  let calls = 0;
  const chat = async (_o: ChatOpts): Promise<ChatResult> => {
    calls++;
    const text = JSON.stringify(titles.map(title => ({ title, body: `${title}.`, atom_type: 'insight' })));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { chat, calls: () => calls };
}

const atoms = (engine: BrainEngine) => engine.executeRaw<{ slug: string; live: boolean; retired_by: string | null }>(
  `SELECT slug, deleted_at IS NULL AS live, frontmatter->>'retired_by' AS retired_by FROM pages
    WHERE source_id='default' AND type='atom' AND frontmatter->>'source_slug'=$1 ORDER BY slug`, [NOTE]);

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

async function staleAtomsListed(engine: BrainEngine): Promise<string[]> {
  const [{ id }] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_brain LIMIT 1').catch(() => [{ id: 'brain' }]);
  const plan = await staleAtomsRepair.plan(engine, { brain_id: String(id), source_ids: ['default'] }, null, { apply: false });
  return plan.items.map(item => item.slug);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`H-1 zero-yield atom re-extraction (${backend})`, () => {
    test('H-1 managed: an honest [] re-extraction keeps the prior atom live and advances the scan state', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await edit(ctx, 'first');
        expect((await extract(engine, ['Launch exit criteria'])).status).toBe('ok');
        const [atom] = await atoms(engine);
        expect(atom).toEqual({ slug: atom!.slug, live: true, retired_by: null });

        await edit(ctx, 'second');
        const empty = await extract(engine, []);
        expect({ status: empty.status, calls: empty.calls }).toEqual({ status: 'ok', calls: 1 });
        expect(await atoms(engine)).toEqual([{ slug: atom!.slug, live: true, retired_by: null }]);
        const page = (await engine.getPage(NOTE, { sourceId: 'default' }))!;
        const [state] = await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'locator'=$1
             AND completed_keys->0->>'contentHash'=$2 AND completed_keys->0->>'failure' IS NULL`, [NOTE, page.content_hash]);
        expect(state!.n).toBe(1);
        expect((await extract(engine, ['Never asked'])).calls).toBe(0);
        expect(await staleAtomsListed(engine)).toEqual([]);

        await edit(ctx, 'third');
        expect((await extract(engine, ['Launch review cadence'])).status).toBe('ok');
        const after = await atoms(engine);
        expect(after.find(row => row.slug === atom!.slug)).toEqual({ slug: atom!.slug, live: false, retired_by: 'managed-reextract' });
        expect(after.filter(row => row.live).length).toBe(1);
      }, { databaseUrl });
    }, 240_000);

    test('H-1 managed partial publish: a retirement whose sibling atom page conflicted retires nothing', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await edit(ctx, 'first');
        await extract(engine, ['Launch exit criteria', 'Weekly review owner']);
        const first = await atoms(engine);
        expect(first.map(row => row.live)).toEqual([true, true]);
        const kept = first.find(row => row.slug.includes('exit-criteria'))!.slug;
        const retiring = first.find(row => row.slug.includes('review-owner'))!.slug;
        await edit(ctx, 'second');
        let fired = false;
        installFaultHook(async (point, detail) => {
          if (fired || point !== 'consumer:preparing' || !detail.writeId) return;
          const [row] = await engine.executeRaw<{ slug: string; kind: string | null }>(
            "SELECT slug, intent->>'kind' AS kind FROM persistence_requests WHERE id=$1::uuid", [detail.writeId]);
          if (row?.kind !== 'managed_atom_page' || row.slug !== kept) return;
          fired = true;
          throw new OperationError('revision_conflict', `Page ${kept} changed after the atom batch was accepted.`, 'Run the atom drain again.');
        });
        try { await extract(engine, ['Launch exit criteria', 'Launch review cadence']).catch(() => undefined); }
        finally { installFaultHook(undefined); }
        expect(fired).toBe(true);
        const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state IN ('queued','running')");
        await waitForWrites(engine, pending, { engine: engine.kind } as GBrainConfig, 60_000);
        await disposePersistenceConsumer(engine);
        const after = await atoms(engine);
        expect(after.find(row => row.slug === retiring)).toEqual({ slug: retiring, live: true, retired_by: null });
        const [refused] = await engine.executeRaw<{ state: string; error_code: string | null }>(
          `SELECT state, error_code FROM persistence_requests WHERE source_id='default' AND slug=$1 AND intent->>'kind'='managed_atom_delete'`, [retiring]);
        expect(refused).toEqual({ state: expect.not.stringMatching(/^committed$/), error_code: 'revision_conflict' });
      }, { databaseUrl });
    }, 240_000);

    test('H-1 unmanaged: the same [] re-extraction keeps the prior atom, matching the managed path', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-h1-'));
      try {
        await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
          try {
            await engine.putPage(NOTE, { type: 'note', title: 'Acme example launch', compiled_truth: body('first'), timeline: '' }, { sourceId: 'default' });
            await extract(engine, ['Launch exit criteria']);
            const [atom] = await atoms(engine);
            expect(atom!.live).toBe(true);
            await engine.putPage(NOTE, { type: 'note', title: 'Acme example launch', compiled_truth: body('second'), timeline: '' }, { sourceId: 'default' });
            expect((await extract(engine, [])).calls).toBe(1);
            expect(await atoms(engine)).toEqual([{ slug: atom!.slug, live: true, retired_by: null }]);
            expect(await staleAtomsListed(engine)).toEqual([]);
          } finally { await close(); }
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    }, 240_000);
  });
}
