import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { waitForWrite } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import * as derivationInputs from '../src/core/facts/derivation-inputs.ts';
import * as pageMutations from '../src/core/persistence/page-mutations.ts';
import * as preparedMaintenance from '../src/core/persistence/prepared-maintenance.ts';
import * as pagePrepare from '../src/core/persistence/page-prepare.ts';
import { releaseHiddenMoment } from '../src/core/facts/derivation-inputs.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { CONCEPT, NEW, atom, members, reply, put, deletePage, raw, purge, synthesize, state, heldConcept, stillHeld } from './helpers/concept-rebuild-9653.ts';
import { assertPurgeParams } from '../src/core/persistence/purge-params.ts';

afterEach(() => { installFaultHook(undefined); __setChatTransportForTests(null); });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`a concept hidden by an input purge is rebuilt as a fresh page: races and the write owner (${backend})`, () => {
    test('managed: a person\'s delete or statement between the purge\'s pre-check and its publication refuses the purge; nothing is rewritten', async () => {
      const between: Array<[string, (engine: BrainEngine, id: number) => Promise<void>]> = [
        ['delete', async (engine, id) => releaseHiddenMoment(engine, id)],
        ['tag', async (engine, id) => raw(engine, "INSERT INTO tags (page_id, tag) VALUES ($1, 'hand-tag')", [id])],
      ];
      for (const [what, act] of between) await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        let fired = false;
        const submit = preparedMaintenance.submitMaintenanceIntent;
        const spy = spyOn(preparedMaintenance, 'submitMaintenanceIntent').mockImplementation(async (e, authority, slug, intent, requestId) => {
          if (!fired && intent.kind === 'managed_maintenance_concept_purge') { fired = true; await act(engine, id); }
          return submit(e, authority, slug, intent, requestId);
        });
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW }).finally(() => spy.mockRestore());
        expect([what, fired, details.rebuilt]).toEqual([what, true, []]);
        const after = await state(engine);
        expect(after).toMatchObject({ id, live: false });
        expect(after.versions).toBeGreaterThan(0);
      }, { databaseUrl });
    }, 600_000);

    test('managed: a write owner too old to re-check the hold refuses the rebuild\'s purge, so a person\'s delete during synthesis keeps its restore window and nothing is published', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        let tagged = false;
        const tag = async () => { if (!tagged) { tagged = true; await releaseHiddenMoment(engine, id); } };
        const submitPage = pageMutations.submitPageMutation;
        const submitIntent = preparedMaintenance.submitMaintenanceIntent;
        const prepareKind = preparedMaintenance.prepareMaintenanceMutation;
        const preparePage = pagePrepare.preparePageMutation;
        const spies = [
          spyOn(pageMutations, 'submitPageMutation').mockImplementation(async (c, input) => {
            if (input.operation === 'delete_page' && input.params.slug === CONCEPT) await tag();
            return submitPage(c, input);
          }),
          spyOn(preparedMaintenance, 'submitMaintenanceIntent').mockImplementation(async (e, authority, slug, intent, requestId) => {
            if (slug === CONCEPT) await tag();
            return submitIntent(e, authority, slug, intent, requestId);
          }),
          // An older owner: it publishes no maintenance kind it does not know, and reads a delete without the hold check.
          spyOn(preparedMaintenance, 'prepareMaintenanceMutation').mockImplementation(async (e, row, config, clock) =>
            prepareKind(e, row.intent?.kind === 'managed_maintenance_concept_purge' ? { ...row, intent: { ...row.intent, kind: 'managed_maintenance_unknown_example' } } : row, config, clock)),
          spyOn(pagePrepare, 'preparePageMutation').mockImplementation(async (e, row, ...rest) => {
            const { concept_hold: _ignored, ...intent } = (row.intent ?? {}) as Record<string, unknown>;
            return preparePage(e, row.operation === 'delete_page' ? { ...row, intent } : row, ...rest);
          }),
        ];
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW }).finally(() => spies.forEach(spy => spy.mockRestore()));
        expect([tagged, details.rebuilt]).toEqual([true, []]);
        const after = await state(engine);
        expect(after).toMatchObject({ id, live: false });
        expect(after.versions).toBeGreaterThan(0);
      }, { databaseUrl });
    }, 300_000);

    test('managed: a member removed between the tombstone purge and the publish refuses the publish, so its text never comes back', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        let fired = false;
        const publish = preparedMaintenance.publishMaintenancePages;
        const spy = spyOn(preparedMaintenance, 'publishMaintenancePages').mockImplementation(async (e, authority, pages, opts) => {
          if (!fired && pages.some(page => page.slug === CONCEPT)) { fired = true; await raw(engine, "UPDATE pages SET deleted_at = now() WHERE source_id = 'default' AND slug = $1", [atom(5)]); }
          return publish(e, authority, pages, opts);
        });
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW }).finally(() => spy.mockRestore());
        expect([fired, details.rebuilt]).toEqual([true, []]);
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2', ['default', CONCEPT])).toHaveLength(0);
      }, { databaseUrl });
    }, 300_000);

    test('unmanaged: the fresh page\'s derivation edges are written in the rebuild\'s transaction, so a failed edge write leaves the concept hidden', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        const spy = spyOn(derivationInputs, 'recordDerivationInputs').mockImplementation(async () => { throw new Error('edge write failed'); });
        try {
          await expect(synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true })).rejects.toThrow('edge write failed');
        } finally { spy.mockRestore(); }
        await stillHeld(engine, id);
        expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true })).rebuilt).toEqual([CONCEPT]);
        expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM derivation_inputs d JOIN pages c ON c.id::text = d.derived_id WHERE d.derived_table = 'pages' AND c.slug = $1 AND c.deleted_at IS NULL", [CONCEPT]))[0]!.n).toBe(5);
      }, { databaseUrl });
    }, 300_000);

    test('a sealed secret also recorded on a live member does not keep the concept hidden, and the member keeps its entry', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        await raw(engine, "INSERT INTO secret_store (id, source_id, rule, ciphertext, nonce, tag, key_id, value_mac) VALUES ('ss_0123456789ad', 'default', 'api_key', 'sealed', 'nonce', 'tag', '0123456789abcdef', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')");
        await raw(engine, "INSERT INTO secret_store_occurrence (entry_id, source_id, page_id, slug, field, origin) VALUES ('ss_0123456789ad', 'default', $1, $2, 'compiled_truth', 'repair')", [id, CONCEPT]);
        await raw(engine, "INSERT INTO secret_store_occurrence (entry_id, source_id, page_id, slug, field, origin) SELECT 'ss_0123456789ad', 'default', p.id, p.slug, 'compiled_truth', 'repair' FROM pages p WHERE p.slug = $1", [atom(1)]);
        expect((await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true })).rebuilt).toEqual([CONCEPT]);
        expect(await engine.executeRaw("SELECT 1 FROM secret_store s JOIN secret_store_occurrence o ON o.entry_id = s.id JOIN pages p ON p.id = o.page_id WHERE s.id = 'ss_0123456789ad' AND p.slug = $1", [atom(1)])).toHaveLength(1);
      }, { databaseUrl });
    }, 300_000);

    test('a sealed secret whose only other occurrence is on another deleted page keeps the concept hidden, so two purges cannot both orphan it', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        await put(ctx, 'notes/other-example', 'Another page that recorded the same secret.', 'note');
        await deletePage(engine, ctx, 'notes/other-example');
        await raw(engine, "INSERT INTO secret_store (id, source_id, rule, ciphertext, nonce, tag, key_id, value_mac) VALUES ('ss_0123456789ae', 'default', 'api_key', 'sealed', 'nonce', 'tag', '0123456789abcdef', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')");
        await raw(engine, "INSERT INTO secret_store_occurrence (entry_id, source_id, page_id, slug, field, origin) VALUES ('ss_0123456789ae', 'default', $1, $2, 'compiled_truth', 'repair')", [id, CONCEPT]);
        await raw(engine, "INSERT INTO secret_store_occurrence (entry_id, source_id, page_id, slug, field, origin) SELECT 'ss_0123456789ae', 'default', p.id, p.slug, 'compiled_truth', 'repair' FROM pages p WHERE p.slug = 'notes/other-example'");
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, unmanaged: true });
        expect(details.rebuild_kept).toEqual([{ source_id: 'default', slug: CONCEPT, reason: 'stated', kinds: ['secret_store_occurrence'] }]);
        await stillHeld(engine, id);
      }, { databaseUrl });
    }, 300_000);

    test('access: a hidden concept no caller could read stays hidden when its current members are all world-readable', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        await raw(engine, "UPDATE pages SET frontmatter = frontmatter || '{\"visibility\":\"private\"}'::jsonb WHERE id = $1", [id]);
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW });
        expect(details.rebuild_kept).toMatchObject([{ slug: CONCEPT, reason: 'access' }]);
        await stillHeld(engine, id);
      }, { databaseUrl });
    }, 300_000);

    test('managed: the publish waits on the purge receipt; a pending purge writes nothing more this cycle and the next one recovers', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        let release!: () => void;
        const stalled = new Promise<void>(resolve => { release = resolve; });
        installFaultHook(async (point, detail) => { if (point === 'consumer:prepared' && (detail as { operation?: string }).operation === 'submit_job') await stalled; });
        const restore = __setMaintenanceWriteWaitForTests(300);
        try {
          const details = (await runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root, _atoms: members([1, 2, 3, 4, 5]), _chat: (async () => reply(NEW)) as never })).details as Record<string, any>;
          expect(details.rebuilt).toEqual([]);
          expect(details.rebuild_deferred).toMatchObject([{ concept: CONCEPT }]);
          expect(details.rebuild_deferred[0].reason).toContain('still pending');
          expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND deleted_at IS NULL', [CONCEPT])).toHaveLength(0);
        } finally { release(); restore(); installFaultHook(undefined); }
        const open = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state NOT IN ('committed','failed','cancelled')");
        for (const row of open) await waitForWrite(engine, row, { engine: engine.kind }, 20_000);
        await settleManagedGitEffects(engine);
        await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW });
        const recovered = await state(engine);
        expect(recovered).toMatchObject({ live: true, old_versions: 0, old_chunks: 0 });
        expect(recovered.body).toContain('canaryrebuilt');
      }, { databaseUrl });
    }, 600_000);

    test('managed: a person who restores, edits or deletes the tombstone before the purge is submitted refuses it', async () => {
      const moves: Array<(engine: BrainEngine, ctx: OperationContext) => Promise<void>> = [
        async (_engine, ctx) => { await submitPageMutation(ctx, { operation: 'restore_page', params: { slug: CONCEPT, request_id: randomUUID() } }); },
        async (engine, ctx) => {
          const at = await engine.readPageSnapshot(CONCEPT, { sourceId: 'default', includeDeleted: true });
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug: CONCEPT, request_id: randomUUID(), expected_revision: at!.revision,
            content: '---\ntitle: storage example\ntype: concept\n---\nWritten by a person.' } });
        },
        async (engine, ctx) => { await deletePage(engine, ctx, CONCEPT); },
      ];
      for (const move of moves) await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW, during: () => move(engine, ctx) });
        expect(details.rebuilt).toEqual([]);
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND compiled_truth LIKE $2', [CONCEPT, '%canaryrebuilt%'])).toHaveLength(0);
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1', [CONCEPT])).toHaveLength(1);
      }, { databaseUrl });
    }, 900_000);

    test('a remote caller, or a purge that is not the retention purge, cannot pass the internal concept_hold', () => {
      expect(() => assertPurgeParams({ slug: CONCEPT, concept_hold: { page_id: 1, deleted_us: '1' } }, true)).toThrow('concept_hold is internal');
      expect(() => assertPurgeParams({ slug: CONCEPT, purge: true, concept_hold: { page_id: 1, deleted_us: '1' } }, false)).toThrow('concept_hold is internal');
      expect(() => assertPurgeParams({ slug: CONCEPT, purge: true, retention: true, concept_hold: { page_id: 1, deleted_us: '1' } }, false)).not.toThrow();
    });
  });
}
