import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ChatOpts } from '../src/core/ai/gateway.ts';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { runCycle } from '../src/core/cycle.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { readEvents } from './helpers/belief-ledger.ts';
import * as originCarry from '../src/core/repair/origin-carry.ts';
import { parkDerivedOrigin, readDerivedOriginParks } from '../src/core/persistence/derived-origin-hold.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { CONCEPT, OLD, NEW, atom, deletePage, unmanagedWhile, age, raw, remoteRead, purge, synthesize, state, heldConcept, stillHeld } from './helpers/concept-rebuild-9653.ts';

afterEach(() => { installFaultHook(undefined); __setChatTransportForTests(null); });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`a concept hidden by an input purge is rebuilt as a fresh page (${backend})`, () => {
    for (const unmanaged of [false, true]) {
      const mode = unmanaged ? 'unmanaged' : 'managed';
      test(`${mode}: the tombstone is purged and a fresh page written; nothing of the old body reaches the model or stays`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const requests: ChatOpts[] = [];
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, requests });
          expect(details.rebuilt).toEqual([CONCEPT]);
          expect(requests).toHaveLength(1);
          expect(JSON.stringify(requests[0]!.messages)).not.toContain(OLD);
          expect(JSON.stringify(requests[0]!.messages)).toContain('Atom 5 about storage.');
          const rebuilt = await state(engine);
          expect(rebuilt).toMatchObject({ live: true, marks: 0, old_versions: 0, old_chunks: 0 });
          expect(rebuilt.id).not.toBe(id);
          expect(rebuilt.body).toContain('canaryrebuilt');
          if (!unmanaged) expect(rebuilt.old_journal).toBe(0);
          expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND deleted_at IS NOT NULL', [CONCEPT])).toHaveLength(0);
          expect(await engine.executeRaw('SELECT 1 FROM page_purges WHERE slug=$1', [CONCEPT])).toHaveLength(0);
          // the incoming link: unmanaged in the rebuild's transaction; managed at the extract phase of the same cycle
          expect(rebuilt.links_in).toBe(unmanaged ? 1 : 0);
          if (!unmanaged) {
            await runCycle(engine, { brainDir: root, phases: ['extract'], sourceId: 'default' });
            expect((await state(engine)).links_in).toBe(1);
          }
        }, { databaseUrl });
      }, 300_000);

      if (unmanaged) test('unmanaged, belief ledger on: the rebuild ends the old page as page.expired and the fresh page starts its own lifetime', async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          await enableBeliefLedger(engine, 'default');
          const after = Math.max(0, ...(await readEvents(engine, 'default')).map(e => e.id));
          expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true })).rebuilt).toEqual([CONCEPT]);
          const events = (await readEvents(engine, 'default', after)).filter(e => e.slug === CONCEPT && e.subject_kind === 'page');
          const expired = events.find(e => e.event_type === 'page.expired');
          expect(expired?.purged).toBe(false);
          expect(events.filter(e => e.page_lifetime !== expired!.page_lifetime).length).toBeGreaterThan(0);
        }, { databaseUrl });
      }, 300_000);

      if (unmanaged) test('unmanaged, belief ledger on: a member that left gets its provenance edge retracted, never carried to the fresh page', async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          await enableBeliefLedger(engine, 'default');
          const after = Math.max(0, ...(await readEvents(engine, 'default')).map(e => e.id));
          expect((await synthesize(engine, root, [1, 2, 3, 4], { text: NEW, unmanaged: true })).rebuilt).toEqual([CONCEPT]);
          const left = (await readEvents(engine, 'default', after)).filter(e => e.slug === atom(5) && e.subject_kind === 'link');
          expect(await engine.executeRaw(`SELECT 1 FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
            WHERE f.slug = $1 AND t.slug = $2 AND l.link_source = 'concept-provenance'`, [atom(5), CONCEPT])).toHaveLength(0);
          expect(left.map(e => e.event_type)).toEqual(['link.retracted']);
        }, { databaseUrl });
      }, 300_000);

      if (unmanaged) test('unmanaged: a park the rebuild writes for a dependent survives its refusal', async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const spy = spyOn(originCarry, 'parkUncarriedInPurge').mockImplementation(async (tx, ids) => {
            const park = { source_id: 'default', slug: CONCEPT, page_id: Number(ids[0]), blocking_slug: 'notes/storage-ref', code: 'dependent_written_mid_purge', reason: 'notes/storage-ref depends on it.' };
            await parkDerivedOrigin(tx, park);
            return [{ ...park, parked_at: new Date().toISOString() }];
          });
          try {
            expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true })).rebuilt).toEqual([]);
          } finally { spy.mockRestore(); }
          await stillHeld(engine, id);
          expect((await readDerivedOriginParks(engine)).map(p => p.page_id)).toEqual([id]);
        }, { databaseUrl });
      }, 300_000);

      if (unmanaged) test('unmanaged: an incoming link keeps every column it had, pointed at the fresh page', async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const pick = "SELECT l.link_type, l.context, l.link_source, l.link_kind, l.origin_field, l.resolution_type, l.assertion_tense, l.created_at::text AS created_at, o.slug AS origin FROM links l JOIN pages n ON n.id = l.from_page_id JOIN pages c ON c.id = l.to_page_id LEFT JOIN pages o ON o.id = l.origin_page_id WHERE n.slug = 'notes/storage-ref' AND c.slug = $1";
          await raw(engine, "UPDATE links SET link_kind = 'typed_ner', resolution_type = 'qualified', assertion_tense = 'past' WHERE to_page_id = $1", [id]);
          const before = await engine.executeRaw(pick, [CONCEPT]);
          expect(before).toHaveLength(1);
          expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true })).rebuilt).toEqual([CONCEPT]);
          expect(await engine.executeRaw(pick, [CONCEPT])).toEqual(before);
        }, { databaseUrl });
      }, 300_000);

      test(`${mode}: a failed synthesis leaves it hidden and held`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: '', unmanaged });
          expect(details.rebuild_deferred.map((d: { concept: string }) => d.concept)).toEqual([CONCEPT]);
          await stillHeld(engine, id);
        }, { databaseUrl });
      }, 300_000);

      test(`${mode}: during the model call, a person's delete, a released hold or a second input purge writes nothing`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, during: async () => { await deletePage(engine, ctx, CONCEPT); } });
          expect(details.rebuilt).toEqual([]);
          expect(await state(engine)).toMatchObject({ live: false });
          expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND compiled_truth LIKE $2', [CONCEPT, '%canaryrebuilt%'])).toHaveLength(0);
        }, { databaseUrl });
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root);
          await age(engine, CONCEPT);
          await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, during: async () => { expect(await purge(engine, false)).toEqual([CONCEPT]); } });
          expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND compiled_truth LIKE $2', [CONCEPT, '%canaryrebuilt%'])).toHaveLength(0);
        }, { databaseUrl });
        await managedBrain(async ({ engine, ctx, root }) => {
          const id = await heldConcept(engine, ctx, root);
          const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged, during: async () => {
            await deletePage(engine, ctx, atom(1));
            await age(engine, atom(1));
            expect(await purge(engine, true)).toEqual([atom(1)]);
          } });
          expect(details.rebuilt).toEqual([]);
          expect(await state(engine)).toMatchObject({ id, live: false, marks: 1 });
          expect((await synthesize(engine, root, [2, 3, 4, 5], { text: NEW, unmanaged })).rebuilt).toEqual([CONCEPT]);
        }, { databaseUrl });
      }, 900_000);

      test(`${mode}: a folder rule still covers the fresh page and a remote non-owner reads nothing`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          await heldConcept(engine, ctx, root, () => unmanagedWhile(engine, true, async () => {
            const rule = await proposeRevision(engine, 'default', [{ id: 'concepts', prefix: 'concepts/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
            expect(rule.state).toBe('applied');
          }));
          const [before] = await engine.executeRaw<{ rules: string[] | null }>('SELECT folder_rule_ids AS rules FROM pages WHERE slug=$1', [CONCEPT]);
          expect(before!.rules).not.toBeNull();
          expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged })).rebuilt).toEqual([CONCEPT]);
          const [after] = await engine.executeRaw<{ rules: string[] | null }>('SELECT folder_rule_ids AS rules FROM pages WHERE slug=$1', [CONCEPT]);
          expect(after!.rules).toEqual(before!.rules);
          expect(await remoteRead(engine)).not.toContain('canaryrebuilt');
        }, { databaseUrl });
      }, 600_000);
    }
  });
}
