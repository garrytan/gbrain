import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

// #9653: an automatic purge keeps a concept hidden only because one of its inputs was purged, while its rederive mark is open.
const MODEL = 'anthropic:claude-sonnet-4-6';
const CONCEPT = 'concepts/storage-example';
const atom = (i: number) => `atoms/storage-${i}`;
const members = (ids: number[]) => ids.map(i => ({ slug: atom(i), concept_refs: [CONCEPT], body: `Atom ${i} about storage.`, title: `storage atom ${i}` }));
const chat = (text: string) => async (): Promise<ChatResult> => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic' });

async function put(ctx: OperationContext, slug: string, body: string, type = 'atom'): Promise<void> {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: `---\ntitle: ${slug}\ntype: ${type}\nvisibility: world\n---\n${body}` } });
}
async function deletePage(engine: BrainEngine, ctx: OperationContext, slug: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } });
}
/** Moves a tombstone (and its rederive mark, which time moves with it) 100 hours into the past. */
async function age(engine: BrainEngine, slug: string): Promise<void> {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw(`UPDATE needs_rederive n SET marked_at = n.marked_at - interval '100 hours' FROM pages p
    WHERE n.derived_table='pages' AND n.derived_id=p.id::text AND p.source_id='default' AND p.slug=$1`, [slug]);
  await engine.executeRaw("UPDATE pages SET deleted_at=deleted_at - interval '100 hours' WHERE source_id='default' AND slug=$1", [slug]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}
async function purge(engine: BrainEngine, opts: { automatic?: boolean; unmanaged?: boolean }): Promise<string[]> {
  await disposePersistenceConsumer(engine);
  if (opts.unmanaged) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return (await purgeDeletedPagesCoordinated(engine, 72, { automatic: opts.automatic })).slugs; }
  finally {
    if (opts.unmanaged) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await disposePersistenceConsumer(engine);
  }
}
async function synthesize(engine: BrainEngine, root: string, ids: number[]): Promise<void> {
  await runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root, _atoms: members(ids), _chat: chat(`A narrative built from atoms ${ids.join(', ')}.`) });
  await settleManagedGitEffects(engine);
}
async function conceptRows(engine: BrainEngine): Promise<{ rows: number; live: number; links_in: number }> {
  const [row] = await engine.executeRaw<{ rows: number; live: number; links_in: number }>(`SELECT count(*)::int AS rows, count(*) FILTER (WHERE deleted_at IS NULL)::int AS live,
    (SELECT count(*)::int FROM links l JOIN pages c ON c.id=l.to_page_id JOIN pages n ON n.id=l.from_page_id WHERE c.slug=$1 AND n.slug='notes/storage-ref') AS links_in FROM pages WHERE source_id='default' AND slug=$1`, [CONCEPT]);
  return row!;
}
/** A concept built from atoms 0 to 4 and rebuilt from 1 to 5; a note links to it. */
async function concept(engine: BrainEngine, ctx: OperationContext, root: string): Promise<void> {
  await engine.setConfig('models.dream.synthesize', MODEL);
  for (const i of [0, 1, 2, 3, 4, 5]) await put(ctx, atom(i), `Atom ${i} about storage.`);
  await synthesize(engine, root, [0, 1, 2, 3, 4]);
  await put(ctx, 'notes/storage-ref', 'See [[concepts/storage-example]] for the overview.', 'note');
  await deletePage(engine, ctx, atom(0));
  await age(engine, atom(0));
  await synthesize(engine, root, [1, 2, 3, 4, 5]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`automatic purge keeps a concept hidden by an input purge (${backend})`, () => {
    for (const unmanaged of [false, true]) {
      // An unmanaged retention expiry hides nothing derived, so there the inputs go through a managed purge and only the concept's expiry runs unmanaged.
      test(`${unmanaged ? 'unmanaged' : 'managed'}: kept past retention through a second input purge; an explicit purge removes it`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await concept(engine, ctx, root);
          expect(await purge(engine, { automatic: true })).toEqual([atom(0)]);
          expect(await conceptRows(engine)).toMatchObject({ rows: 1, live: 0 });
          await deletePage(engine, ctx, atom(1));
          await age(engine, atom(1));
          expect(await purge(engine, { automatic: true })).toEqual([atom(1)]);
          await age(engine, CONCEPT);
          expect(await purge(engine, { automatic: true, unmanaged })).toEqual([]);
          expect(await purge(engine, { automatic: true, unmanaged })).toEqual([]);
          expect(await conceptRows(engine)).toEqual({ rows: 1, live: 0, links_in: 1 });
          expect(await purge(engine, { unmanaged })).toEqual([CONCEPT]);
          expect((await conceptRows(engine)).rows).toBe(0);
        }, { databaseUrl });
      }, 300_000);
    }

    test('deleting a concept the input purge already hid ends the hold', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await concept(engine, ctx, root);
        expect(await purge(engine, { automatic: true })).toEqual([atom(0)]);
        const hidden = await engine.readPageSnapshot(CONCEPT, { sourceId: 'default', includeDeleted: true });
        await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: CONCEPT, expected_revision: hidden!.revision, request_id: randomUUID() } });
        await age(engine, CONCEPT);
        expect(await purge(engine, { automatic: true })).toEqual([CONCEPT]);
      }, { databaseUrl });
    }, 300_000);

    test('a concept a person deleted is purged on time, also when an input purge marks it afterwards', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const i of [0, 1, 2, 3, 4]) await put(ctx, atom(i), `Atom ${i} about storage.`);
        await synthesize(engine, root, [0, 1, 2, 3, 4]);
        await deletePage(engine, ctx, CONCEPT);
        await age(engine, CONCEPT);
        await deletePage(engine, ctx, atom(0));
        await age(engine, atom(0));
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("UPDATE pages SET deleted_at=deleted_at + interval '50 hours' WHERE source_id='default' AND slug=$1", [CONCEPT]);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        expect(await purge(engine, { automatic: true })).toEqual([atom(0)]);
        const [mark] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM needs_rederive n JOIN pages p ON n.derived_id=p.id::text WHERE n.derived_table='pages' AND p.slug=$1`, [CONCEPT]);
        expect(mark!.n).toBe(1);
        await age(engine, CONCEPT);
        expect(await purge(engine, { automatic: true })).toEqual([CONCEPT]);
      }, { databaseUrl });
    }, 300_000);
  });
}
