/**
 * Managed atom generations, two leftovers of GBRA-161 PR 1b.
 *
 * #9079: `gbrain repair generations --mode release-held` published a released atom result under the drain's run key, so
 * its completion request collided with the completion the drain had already journaled for the same input and every
 * release ended idempotency_conflict; the held result could never publish.
 * #9275: an activation recorded its members without the identity each overwrite replaces, so a member interrupted after
 * the activation was read back with no before-identity, judged a person's edit (kept_edited) and settled; the previous
 * atom body stayed live and the new extraction was dropped.
 * Seams: the phase's _pages / _chat inputs (no paid call) and a consumer:preparing fault hook. PGLite always, Postgres
 * when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { operations } from '../src/core/operations.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { atomOwnerKey } from '../src/core/generations/adapters/atoms.ts';
import { listPendingMembers } from '../src/core/generations/managed.ts';
import { managedAtomSession, publishManagedAtomGeneration, readAtomOrigin, resumeManagedGenerationMembers } from '../src/core/persistence/atom-maintenance.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { managedBrain, pathologicalArms } from './pathological/harness.ts';

const NOTE = 'notes/acme-example-plan';
const KEY = { kind: 'atom', sourceId: 'default', ownerKey: atomOwnerKey({ kind: 'page', slug: NOTE }) };
const body = (label: string) => '---\ntype: note\ntitle: Acme example plan\n---\n\n' + (label + ': the team ships small changes, measures each launch and reviews outcomes weekly. ').repeat(12) + '\n';
const TITLES = ['Ship small changes', 'Review outcomes weekly', 'Measure each launch', 'Pair on reviews'];

async function extract(engine: BrainEngine, atoms: Array<{ title: string; body?: string }>) {
  const chat = async (_o: ChatOpts): Promise<ChatResult> => {
    const text = JSON.stringify(atoms.map(atom => ({ title: atom.title, body: atom.body ?? atom.title + '.', atom_type: 'insight' })));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  const page = (await engine.getPage(NOTE, { sourceId: 'default' }))!;
  const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: chat, _transcripts: [],
    _pages: [{ slug: NOTE, content: page.compiled_truth, contentHash: page.content_hash! }] });
  await disposePersistenceConsumer(engine);
  return result;
}

async function edit(ctx: OperationContext, label: string) {
  const snap = await ctx.engine.readPageSnapshot(NOTE, { sourceId: 'default' });
  await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: NOTE, content: body(label), ...(snap ? { expected_revision: snap.revision } : {}) });
  await disposePersistenceConsumer(ctx.engine);
}

const atomRows = (engine: BrainEngine) => engine.executeRaw<{ slug: string; live: boolean; body: string }>(
  "SELECT slug, deleted_at IS NULL AS live, compiled_truth AS body FROM pages WHERE source_id='default' AND type='atom' AND frontmatter->>'source_slug'=$1 ORDER BY slug", [NOTE]);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`managed atom generations (${backend})`, () => {
    test('#9079: release-held publishes a held result past the completion the drain journaled for the same input', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await edit(ctx, 'first');
        expect((await extract(engine, TITLES.map(title => ({ title })))).status).toBe('ok');
        const live = await atomRows(engine);
        expect(live.map(row => row.live)).toEqual([true, true, true, true]);
        const session = (await managedAtomSession(engine, 'default'))!;
        const page = (await engine.getPage(NOTE, { sourceId: 'default' }))!;
        const origin = await readAtomOrigin(engine, session, { kind: 'page', slug: NOTE, content: page.compiled_truth, contentHash: page.content_hash! });
        const kept = (await engine.readPageSnapshot(live[0]!.slug, { sourceId: 'default' }))!;
        const held = await publishManagedAtomGeneration(engine, session, origin,
          [{ slug: kept.page.slug, content: serializePageToMarkdown(kept.page, kept.tags), links: [] }], { key: KEY, content: page.compiled_truth });
        expect(held).toMatchObject({ state: 'held', reason: 'shrunk' });
        await disposePersistenceConsumer(engine);

        const scope = await resolveRepairScope(engine, 'default');
        const quiet = { info: () => {}, warn: () => {}, error: () => {} };
        const selection = { kind: 'atom', mode: 'release-held' as const, held: true };
        const preview = await (await repairRunner(engine, { apply: false, logger: quiet })).run('generations', scope, { explicit: true, sourceFlag: 'default', generations: selection });
        expect(preview.listing).toEqual([expect.objectContaining({ class: 'release-held' })]);
        const apply = () => repairRunner(engine, { apply: true, noEmbed: true, logger: quiet }).then(runner => runner.run('generations', scope,
          { explicit: true, sourceFlag: 'default', generations: selection, expect: preview.preview_hash }));
        expect((await apply()).outcomes).toEqual({ released: 1 });
        await disposePersistenceConsumer(engine);
        expect((await atomRows(engine)).filter(row => row.live).map(row => row.slug)).toEqual([kept.page.slug]);
      }, { databaseUrl });
    }, 240_000);

    test('#9275: an overwrite interrupted after its activation is resubmitted, not kept as an edit', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await edit(ctx, 'first');
        expect((await extract(engine, TITLES.map(title => ({ title })))).status).toBe('ok');
        const target = (await atomRows(engine)).find(row => row.slug.includes('measure-each-launch'))!;
        await edit(ctx, 'second');
        let crashes = 0;
        installFaultHook(async (point, detail) => {
          if (crashes || point !== 'consumer:preparing' || !detail.writeId) return;
          const [row] = await engine.executeRaw<{ slug: string; phase: string | null }>("SELECT slug, intent->>'phase' AS phase FROM persistence_requests WHERE id=$1::uuid", [detail.writeId]);
          if (row?.phase !== 'overwrite' || row.slug !== target.slug) return;
          crashes++;
          throw new OperationError('revision_conflict', 'Simulated interruption: the overwrite never landed.', 'Run the atom drain again.');
        });
        try { await extract(engine, TITLES.map(title => ({ title, body: title === 'Measure each launch' ? 'Measure each launch against its stated goal.' : undefined }))).catch(() => undefined); }
        finally { installFaultHook(undefined); }
        await disposePersistenceConsumer(engine);
        expect(crashes).toBeGreaterThan(0);
        expect((await listPendingMembers(engine, ['default'], 'atom')).find(row => row.slug === target.slug)?.action).toBe('overwrite');
        expect((await atomRows(engine)).find(row => row.slug === target.slug)!.body).not.toContain('stated goal');

        const session = (await managedAtomSession(engine, 'default'))!;
        const resumed = await resumeManagedGenerationMembers(engine, session, { corpusDir: null });
        await disposePersistenceConsumer(engine);
        expect(resumed.find(row => row.slug === target.slug)?.outcome).toBe('resubmitted');
        expect(resumed.some(row => row.outcome === 'kept_edited')).toBe(false);
        expect((await atomRows(engine)).find(row => row.slug === target.slug)!.body).toContain('stated goal');
        expect(await listPendingMembers(engine, ['default'], 'atom')).toEqual([]);
      }, { databaseUrl });
    }, 240_000);
  });
}
