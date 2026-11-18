/**
 * #9653: a concept re-synthesized without a retired atom must survive that atom's purge. Concept publication recorded
 * its derivation_inputs edges insert-only, so the concept kept an edge to every atom it had ever been built from, and a
 * purge of a former member walked that stale edge and soft-deleted the live concept (marking it needs_rederive).
 * A concept whose current members are all purged is still hidden, as before. Managed brain, PGLite and, with
 * DATABASE_URL, Postgres. Synthetic data only.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { conceptStaleInputsCheck } from '../src/commands/doctor/checks/concept-stale-inputs.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const MODEL = 'anthropic:claude-sonnet-4-6';
const CONCEPT = 'concepts/storage-example';
const slugOf = (i: number) => `atoms/storage-${i}`;
const members = (ids: number[]) => ids.map(i => ({ slug: slugOf(i), concept_refs: [CONCEPT], body: `Atom ${i} about storage.`, title: `storage atom ${i}` }));
const chat = (text: string) => async (): Promise<ChatResult> =>
  ({ text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic' });

async function put(ctx: OperationContext, i: number): Promise<void> {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: slugOf(i), request_id: randomUUID(),
    content: `---\ntitle: storage atom ${i}\ntype: atom\nvisibility: world\n---\nAtom ${i} about storage.` } });
}

/** Retire an atom the way a re-extraction does (a soft delete), then age it past the retention window. */
async function retire(engine: BrainEngine, ctx: OperationContext, i: number): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slugOf(i), { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: slugOf(i), expected_revision: snapshot!.revision, request_id: randomUUID() } });
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id='default' AND slug=$1", [slugOf(i)]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

async function synthesize(engine: BrainEngine, root: string, ids: number[], text: string): Promise<void> {
  await runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root, _atoms: members(ids), _chat: chat(text) });
  await settleManagedGitEffects(engine);
}

async function purge(engine: BrainEngine): Promise<string[]> {
  const result = await purgeDeletedPagesCoordinated(engine, 72);
  await disposePersistenceConsumer(engine);
  return result.slugs;
}

const concept = async (engine: BrainEngine) => (await engine.executeRaw<{ live: boolean; rederive: boolean }>(
  `SELECT p.deleted_at IS NULL AS live, EXISTS (SELECT 1 FROM needs_rederive n WHERE n.derived_table='pages' AND n.derived_id=p.id::text) AS rederive
     FROM pages p WHERE p.source_id='default' AND p.slug=$1`, [CONCEPT]))[0];

/** The page inputs the concept's derivation_inputs edges name, as atom slugs. */
const inputSlugs = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
  `SELECT a.slug FROM derivation_inputs d JOIN pages c ON d.derived_table='pages' AND d.derived_id=c.id::text
     JOIN pages a ON d.input_table='pages' AND a.id::text=d.input_id WHERE c.source_id='default' AND c.slug=$1 ORDER BY a.slug`, [CONCEPT])).map(r => r.slug);

/** A brain from before #9653: the concept's edge to its former member was never dropped. */
const restoreStaleEdge = (engine: BrainEngine, i: number) => engine.executeRaw(`INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id)
  SELECT 'pages', c.id::text, 'pages', a.id::text, 'default' FROM pages c, pages a WHERE c.source_id='default' AND a.source_id='default' AND c.slug=$1 AND a.slug=$2`, [CONCEPT, slugOf(i)]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#9653 purge of a former concept member (${backend})`, () => {
    test('a concept re-synthesized without a retired atom stays live after that atom is purged', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const i of [0, 1, 2, 3, 4, 5]) await put(ctx, i);
        await synthesize(engine, root, [0, 1, 2, 3, 4], 'A narrative built from atoms zero to four.');
        await retire(engine, ctx, 0);
        await synthesize(engine, root, [1, 2, 3, 4, 5], 'A narrative built from atoms one to five.');
        expect((await engine.getPage(CONCEPT, { sourceId: 'default' }))?.compiled_truth).toContain('atoms one to five');
        expect(await inputSlugs(engine)).toEqual([1, 2, 3, 4, 5].map(slugOf));
        expect(await conceptStaleInputsCheck(engine)).toMatchObject({ status: 'ok', details: { count: 0 } });
        expect(await purge(engine)).toContain(slugOf(0));
        expect(await concept(engine)).toEqual({ live: true, rederive: false });
      }, { databaseUrl });
    }, 240_000);

    test('purging a former member hides the archived narrative built with it, and revert_version refuses it', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const i of [0, 1, 2, 3, 4, 5]) await put(ctx, i);
        await synthesize(engine, root, [0, 1, 2, 3, 4], 'A narrative built from atoms zero to four.');
        await retire(engine, ctx, 0);
        await synthesize(engine, root, [1, 2, 3, 4, 5], 'A narrative built from atoms one to five.');
        const old = (await engine.getVersions(CONCEPT, { sourceId: 'default' })).find(v => String(v.compiled_truth).includes('zero to four'));
        expect(old).toBeDefined();
        expect(await purge(engine)).toContain(slugOf(0));
        expect(await concept(engine)).toEqual({ live: true, rederive: false });
        expect((await engine.getVersions(CONCEPT, { sourceId: 'default' })).map(v => String(v.compiled_truth)).filter(t => t.includes('zero to four'))).toEqual([]);
        const snapshot = await engine.readPageSnapshot(CONCEPT, { sourceId: 'default' });
        const reverted = await submitPageMutation(ctx, { operation: 'revert_version', params: { slug: CONCEPT, version_id: Number(old!.id), expected_revision: snapshot!.revision, request_id: randomUUID() } }).then(() => null, (e: { code?: string }) => e.code ?? 'error');
        expect(reverted).toBe('not_found');
        expect((await engine.getPage(CONCEPT, { sourceId: 'default' }))?.compiled_truth).toContain('one to five');
      }, { databaseUrl });
    }, 240_000);

    test('purging a current member, then re-deriving the concept, never brings back a narrative built with it', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const i of [0, 1, 2, 3, 4]) await put(ctx, i);
        await synthesize(engine, root, [0, 1, 2, 3, 4], 'A narrative built from atoms zero to four.');
        await synthesize(engine, root, [0, 1, 2, 3, 4], 'A second narrative from atoms zero to four.');
        await retire(engine, ctx, 3);
        expect(await purge(engine)).toContain(slugOf(3));
        expect(await concept(engine)).toEqual({ live: false, rederive: true });
        await synthesize(engine, root, [0, 1, 2, 4], 'A narrative rebuilt without atom three.');
        const texts = (await engine.getVersions(CONCEPT, { sourceId: 'default' })).map(v => String(v.compiled_truth));
        expect(texts.filter(t => t.includes('zero to four'))).toEqual([]);
      }, { databaseUrl });
    }, 240_000);

    test('doctor counts a concept an older version left with an edge to its retired former member; its purge still hides the concept', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const i of [0, 1, 2, 3, 4, 5]) await put(ctx, i);
        await synthesize(engine, root, [0, 1, 2, 3, 4], 'A narrative built from atoms zero to four.');
        await retire(engine, ctx, 0);
        await synthesize(engine, root, [1, 2, 3, 4, 5], 'A narrative built from atoms one to five.');
        await restoreStaleEdge(engine, 0);
        expect(await conceptStaleInputsCheck(engine)).toMatchObject({ status: 'warn', details: { count: 1, edges: 1 } });
        expect(await purge(engine)).toContain(slugOf(0));
        expect(await concept(engine)).toEqual({ live: false, rederive: true });
      }, { databaseUrl });
    }, 240_000);

    test('a concept still built from a purged atom is hidden and marked needs_rederive, as before', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const i of [0, 1, 2, 3, 4]) await put(ctx, i);
        await synthesize(engine, root, [0, 1, 2, 3, 4], 'A narrative built from atoms zero to four.');
        for (const i of [0, 1, 2, 3, 4]) await retire(engine, ctx, i);
        expect(await purge(engine)).toEqual(expect.arrayContaining([0, 1, 2, 3, 4].map(slugOf)));
        expect(await concept(engine)).toEqual({ live: false, rederive: true });
      }, { databaseUrl });
    }, 240_000);
  });
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`#9653 an unmanaged re-synthesis replaces the concept's input edges (${backend})`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-9653-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        _resetWriteThroughCacheForTest();
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          await engine.setConfig('models.dream.synthesize', MODEL);
          for (const atom of members([0, 1, 2, 3, 4, 5])) await engine.putPage(atom.slug, { type: 'note', title: atom.title, compiled_truth: atom.body, timeline: '', frontmatter: {} });
          await runPhaseSynthesizeConcepts(engine, { _atoms: members([0, 1, 2, 3, 4]), _chat: chat('A narrative built from atoms zero to four.') });
          expect(await inputSlugs(engine)).toEqual([0, 1, 2, 3, 4].map(slugOf));
          await runPhaseSynthesizeConcepts(engine, { _atoms: members([1, 2, 3, 4, 5]), _chat: chat('A narrative built from atoms one to five.') });
          expect(await inputSlugs(engine)).toEqual([1, 2, 3, 4, 5].map(slugOf));
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 240_000);
}
