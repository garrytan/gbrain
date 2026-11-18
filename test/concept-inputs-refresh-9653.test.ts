/**
 * #9653 follow-up: a brain upgraded with a stale concept input record (an edge to a former member that an older version
 * never dropped) is cleared by the next synthesis cycle even when the concept is unchanged, because the cycle replaces
 * the record with the group's current members. Purging the retired former member then leaves the concept live; purging
 * a current member still hides it. Managed and unmanaged brains, PGLite and, with DATABASE_URL, Postgres. Synthetic data only.
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

const STALE = 'A narrative built from atoms one to five.';

/** Upgraded-brain fixture: the concept is current with atoms 1-5 but its record still names retired atom 0. */
async function upgradedBrain(engine: BrainEngine, ctx: OperationContext, root: string): Promise<void> {
  await engine.setConfig('models.dream.synthesize', MODEL);
  for (const i of [0, 1, 2, 3, 4, 5]) await put(ctx, i);
  await synthesize(engine, root, [0, 1, 2, 3, 4], 'A narrative built from atoms zero to four.');
  await retire(engine, ctx, 0);
  await synthesize(engine, root, [1, 2, 3, 4, 5], STALE);
  await restoreStaleEdge(engine, 0);
  expect(await inputSlugs(engine)).toEqual([0, 1, 2, 3, 4, 5].map(slugOf));
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#9653 a synthesis cycle refreshes an unchanged concept's stale input record (${backend})`, () => {
    test('the record lists exactly the current members, and purging the retired member leaves the concept live', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await upgradedBrain(engine, ctx, root);
        const before = (await engine.getPage(CONCEPT, { sourceId: 'default' }))?.compiled_truth;
        await synthesize(engine, root, [1, 2, 3, 4, 5], STALE);
        expect((await engine.getPage(CONCEPT, { sourceId: 'default' }))?.compiled_truth).toBe(before);
        expect(await inputSlugs(engine)).toEqual([1, 2, 3, 4, 5].map(slugOf));
        expect(await conceptStaleInputsCheck(engine)).toMatchObject({ status: 'ok', details: { count: 0 } });
        expect(await purge(engine)).toContain(slugOf(0));
        expect(await concept(engine)).toEqual({ live: true, rederive: false });
      }, { databaseUrl });
    }, 240_000);

    test('after the refresh, purging a current member still hides the concept', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await upgradedBrain(engine, ctx, root);
        await synthesize(engine, root, [1, 2, 3, 4, 5], STALE);
        await retire(engine, ctx, 3);
        expect(await purge(engine)).toContain(slugOf(3));
        expect(await concept(engine)).toEqual({ live: false, rederive: true });
      }, { databaseUrl });
    }, 240_000);
  });
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`#9653 an unmanaged cycle refreshes an unchanged concept's stale input record (${backend})`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-9653-refresh-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        _resetWriteThroughCacheForTest();
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          await engine.setConfig('models.dream.synthesize', MODEL);
          for (const atom of members([0, 1, 2, 3, 4, 5])) await engine.putPage(atom.slug, { type: 'note', title: atom.title, compiled_truth: atom.body, timeline: '', frontmatter: {} });
          await runPhaseSynthesizeConcepts(engine, { _atoms: members([1, 2, 3, 4, 5]), _chat: chat(STALE) });
          await restoreStaleEdge(engine, 0);
          expect(await inputSlugs(engine)).toEqual([0, 1, 2, 3, 4, 5].map(slugOf));
          await runPhaseSynthesizeConcepts(engine, { _atoms: members([1, 2, 3, 4, 5]), _chat: chat(STALE) });
          expect(await inputSlugs(engine)).toEqual([1, 2, 3, 4, 5].map(slugOf));
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 240_000);
}
