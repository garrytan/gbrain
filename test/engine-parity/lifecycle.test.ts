/**
 * BrainEngine parity — lifecycle family (transactions, schema re-init,
 * reconnect, shutdown hooks, reserved connections).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: transaction commit / rollback-on-throw behaviour, idempotent
 *    schema initialisation, reconnect data survival and the shutdown-hook
 *    registration contract are the same on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts).
 *  - Regression: an engine whose transaction leaks writes after a throw,
 *    swallows the thrown error, loses data when initSchema runs on an
 *    initialised brain (every CLI start does this), or drops data on
 *    reconnect — the failure modes behind half-applied sync/import writes.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    entirely without Postgres and has no lifecycle cases; per-engine
 *    tests never compare two engines on one scenario.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 *
 * connect / disconnect run on a second engine from the harness's
 * `unconnectedEngine()`, never on the shared arm engine.
 *
 * holdSchemaMigrationLock is optional on the interface and only Postgres
 * implements it (PGLite serializes migrations in-process,
 * src/core/schema-migration-lock.ts), so its case declares
 * `requires: 'schema_migration_lock'` and runs on the Postgres arm only.
 *
 * Skipped on purpose:
 *  - withReservedConnection with a connection query: ReservedConnection only
 *    exposes executeRaw, which cases may not call. Only the pass-through
 *    contract (return value, error propagation) is checked.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

describe('engine parity: lifecycle', () => {
  parityTest(
    'transaction commits writes made through the tx handle and returns the callback value',
    { methods: ['transaction', 'getPage'] },
    async (engine) => {
      const result = await engine.transaction(async (tx) => {
        await tx.putPage('notes/tx-commit-a', NOTE('A', 'Committed A.'));
        await tx.putPage('notes/tx-commit-b', NOTE('B', 'Committed B.'));
        // Read-your-writes inside the transaction.
        const inside = await tx.getPage('notes/tx-commit-a');
        expect(inside?.compiled_truth).toBe('Committed A.');
        return { inside: inside?.title, marker: 42 };
      });
      const a = await engine.getPage('notes/tx-commit-a');
      const b = await engine.getPage('notes/tx-commit-b');
      expect(a?.compiled_truth).toBe('Committed A.');
      expect(b?.compiled_truth).toBe('Committed B.');
      return { result, a: a?.title, b: b?.title };
    },
  );

  parityTest(
    'transaction rolls back every write when the callback throws and rethrows the same error',
    { methods: ['putPage', 'transaction', 'getPage', 'listPages'] },
    async (engine) => {
      await engine.putPage('notes/tx-keep', NOTE('Keep', 'Original.'));
      let caught = '';
      try {
        await engine.transaction(async (tx) => {
          await tx.putPage('notes/tx-new', NOTE('New', 'Should vanish.'));
          await tx.putPage('notes/tx-keep', NOTE('Keep', 'Edited inside tx.'));
          throw new Error('boom: abort the transaction');
        });
      } catch (error) {
        caught = (error as Error).message.replace(/^\[[a-z]+\]\s*/, '');
      }
      expect(caught).toContain('boom: abort the transaction');
      const created = await engine.getPage('notes/tx-new');
      const kept = await engine.getPage('notes/tx-keep');
      const slugs = (await engine.listPages()).map((p) => p.slug);
      expect(created).toBeNull();
      expect(kept?.compiled_truth).toBe('Original.');
      expect(slugs).toEqual(['notes/tx-keep']);
      return { caught, created, kept: kept?.compiled_truth, slugs };
    },
  );

  parityTest(
    'a failed transaction leaves the engine usable for the next transaction',
    { methods: ['transaction', 'getPage'] },
    async (engine) => {
      const failures: string[] = [];
      for (let i = 0; i < 2; i++) {
        try {
          await engine.transaction(async (tx) => {
            await tx.putPage(`notes/tx-fail-${i}`, NOTE('F', 'Never lands.'));
            throw new Error(`fail-${i}`);
          });
        } catch (error) {
          failures.push((error as Error).message.replace(/^\[[a-z]+\]\s*/, ''));
        }
      }
      await engine.transaction(async (tx) => {
        await tx.putPage('notes/tx-after', NOTE('After', 'Lands.'));
      });
      const after = await engine.getPage('notes/tx-after');
      expect(after?.compiled_truth).toBe('Lands.');
      return {
        failures,
        leaked: [await engine.getPage('notes/tx-fail-0'), await engine.getPage('notes/tx-fail-1')],
        after: after?.title,
      };
    },
  );

  parityTest(
    'transactionDirect commits on success and rolls back on throw',
    { methods: ['transactionDirect', 'getPage', 'putPage'] },
    async (engine) => {
      const value = await engine.transactionDirect(async (tx) => {
        await tx.putPage('notes/direct-commit', NOTE('Direct', 'Direct commit.'));
        return 'done';
      });
      await engine.putPage('notes/direct-keep', NOTE('Keep', 'Original.'));
      let caught = '';
      try {
        await engine.transactionDirect(async (tx) => {
          await tx.putPage('notes/direct-keep', NOTE('Keep', 'Edited inside direct tx.'));
          await tx.putPage('notes/direct-new', NOTE('New', 'Vanishes.'));
          throw new Error('direct boom');
        });
      } catch (error) {
        caught = (error as Error).message.replace(/^\[[a-z]+\]\s*/, '');
      }
      const committed = await engine.getPage('notes/direct-commit');
      const kept = await engine.getPage('notes/direct-keep');
      const created = await engine.getPage('notes/direct-new');
      expect(value).toBe('done');
      expect(caught).toContain('direct boom');
      expect(committed?.compiled_truth).toBe('Direct commit.');
      expect(kept?.compiled_truth).toBe('Original.');
      expect(created).toBeNull();
      return { value, caught, committed: committed?.title, kept: kept?.compiled_truth, created };
    },
  );

  parityTest(
    'a nested transaction joins the outer one: an outer throw rolls back inner writes too',
    { methods: ['transaction', 'getPage'] },
    async (engine) => {
      let caught = '';
      try {
        await engine.transaction(async (outer) => {
          await outer.putPage('notes/nest-outer', NOTE('Outer', 'Outer write.'));
          await outer.transaction(async (inner) => {
            await inner.putPage('notes/nest-inner', NOTE('Inner', 'Inner write.'));
          });
          const insideInner = await outer.getPage('notes/nest-inner');
          expect(insideInner?.compiled_truth).toBe('Inner write.');
          throw new Error('outer abort');
        });
      } catch (error) {
        caught = (error as Error).message.replace(/^\[[a-z]+\]\s*/, '');
      }
      expect(caught).toContain('outer abort');
      const outer = await engine.getPage('notes/nest-outer');
      const inner = await engine.getPage('notes/nest-inner');
      expect(outer).toBeNull();
      expect(inner).toBeNull();
      return { caught, outer, inner };
    },
  );

  parityTest(
    'registerBeforeDisconnect returns an unregister function and does not run the hook until shutdown',
    { methods: ['registerBeforeDisconnect'] },
    async (engine) => {
      let stops = 0;
      const unregister = engine.registerBeforeDisconnect(async () => {
        stops += 1;
      });
      const kind = typeof unregister;
      unregister();
      // Unregistering twice is harmless.
      unregister();
      const second = engine.registerBeforeDisconnect(async () => {
        stops += 1;
      });
      second();
      expect(kind).toBe('function');
      expect(stops).toBe(0);
      return { kind, stops, secondKind: typeof second };
    },
  );

  parityTest(
    'withReservedConnection passes the callback value through, propagates errors, and leaves the engine usable',
    { methods: ['withReservedConnection', 'putPage', 'getPage'], requires: 'raw_sql' },
    async (engine) => {
      // The connection itself is not queried: ReservedConnection only offers executeRaw (forbidden in cases).
      const value = await engine.withReservedConnection(async (conn) => {
        expect(typeof conn.executeRaw).toBe('function');
        return { ok: true };
      });
      let caught = '';
      try {
        await engine.withReservedConnection(async () => {
          throw new Error('reserved boom');
        });
      } catch (error) {
        caught = (error as Error).message.replace(/^\[[a-z]+\]\s*/, '');
      }
      await engine.putPage('notes/reserved-after', NOTE('After', 'Still works.'));
      const after = await engine.getPage('notes/reserved-after');
      expect(caught).toContain('reserved boom');
      expect(after?.compiled_truth).toBe('Still works.');
      return { value, caught, after: after?.title };
    },
  );

  parityTest(
    'initSchema on an initialised brain is idempotent: pages, config and links survive',
    { methods: ['putPage', 'setConfig', 'addLink', 'initSchema', 'getPage', 'getConfig', 'getLinks'] },
    async (engine) => {
      await engine.putPage('people/init-alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice body.', timeline: '' });
      await engine.putPage('companies/init-acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme body.', timeline: '' });
      await engine.addLink('people/init-alice', 'companies/init-acme', '', 'works_at');
      await engine.setConfig('parity.lifecycle.marker', 'before-init');
      // A brain made by `gbrain init` records its embedding model; initSchema on an existing brain refuses to
      // run when the stored model is unknown (same refusal on both engines), so record the default model first.
      await engine.setConfig('embedding_model', 'voyage:voyage-4');
      await engine.initSchema();
      await engine.initSchema();
      const page = await engine.getPage('people/init-alice');
      const marker = await engine.getConfig('parity.lifecycle.marker');
      const links = await engine.getLinks('people/init-alice');
      expect(page?.compiled_truth).toBe('Alice body.');
      expect(marker).toBe('before-init');
      expect(links.map((l) => l.to_slug)).toEqual(['companies/init-acme']);
      // The engine still accepts writes afterwards.
      await engine.putPage('people/init-bob', { type: 'person', title: 'Bob', compiled_truth: 'Bob body.', timeline: '' });
      const bob = await engine.getPage('people/init-bob');
      return { page: page?.title, marker, links: links.map((l) => `${l.from_slug}->${l.to_slug}:${l.link_type}`), bob: bob?.title };
    },
  );

  parityTest(
    'reconnect keeps stored data and leaves the engine writable',
    { methods: ['putPage', 'setConfig', 'reconnect', 'getPage', 'getConfig'] },
    async (engine) => {
      await engine.putPage('notes/recon-a', NOTE('Recon', 'Before reconnect.'));
      await engine.setConfig('parity.lifecycle.recon', 'kept');
      await engine.reconnect();
      const before = await engine.getPage('notes/recon-a');
      const config = await engine.getConfig('parity.lifecycle.recon');
      await engine.putPage('notes/recon-b', NOTE('After', 'After reconnect.'));
      const after = await engine.getPage('notes/recon-b');
      expect(before?.compiled_truth).toBe('Before reconnect.');
      expect(config).toBe('kept');
      expect(after?.compiled_truth).toBe('After reconnect.');
      return { before: before?.title, config, after: after?.title };
    },
  );
  parityTest(
    'connect, initSchema, write, then disconnect runs the shutdown hooks and closes the engine',
    { methods: ['connect', 'initSchema', 'putPage', 'getPage', 'registerBeforeDisconnect', 'disconnect', 'setConfig'] },
    async (engine, _backend, ctx) => {
      // The Postgres second engine opens the arm's own database; record its embedding model as `gbrain init` would.
      await engine.setConfig('embedding_model', 'voyage:voyage-4');
      const { engine: second, config } = ctx.unconnectedEngine();
      await second.connect(config);
      await second.initSchema();
      await second.putPage('notes/second-engine', NOTE('Second', 'Written by a second engine.'));
      const read = await second.getPage('notes/second-engine');
      expect(read?.title).toBe('Second');
      const hooks: string[] = [];
      second.registerBeforeDisconnect(async () => { hooks.push('kept'); });
      const unregister = second.registerBeforeDisconnect(async () => { hooks.push('unregistered'); });
      unregister();
      expect(hooks).toEqual([]);
      await second.disconnect();
      expect(hooks).toEqual(['kept']);
      const hooksAfterFirst = [...hooks];
      // A second disconnect of a closed engine is a no-op on every engine: the shutdown hooks ran once.
      await second.disconnect();
      expect(hooks).toEqual(hooksAfterFirst);
      let afterDisconnect: string;
      try {
        await second.getPage('notes/second-engine');
        afterDisconnect = 'served';
      } catch {
        afterDisconnect = 'refused';
      }
      // The shared arm engine is untouched by the second engine's lifecycle.
      const armStillServes = (await engine.getConfig('embedding_model')) === 'voyage:voyage-4';
      expect(armStillServes).toBe(true);
      return { title: read?.title, hooks: hooksAfterFirst, hooksAfterSecond: [...hooks], afterDisconnect, armStillServes };
    },
  );

  parityTest(
    'holdSchemaMigrationLock runs the callback under the held lock, returns its value, and releases on a throw',
    { methods: ['holdSchemaMigrationLock', 'getPage'], requires: 'schema_migration_lock' },
    async (engine) => {
      const hold = engine.holdSchemaMigrationLock!.bind(engine);
      const value = await hold(async (assertHeld) => { await assertHeld(); return 'migrated'; });
      const thrown = await hold(async () => { throw new Error('migration failed'); })
        .then(() => 'no error', (e: unknown) => (e instanceof Error ? e.message : String(e)));
      // The throw released the lock: a second hold gets it again at once, and the engine still serves reads.
      const again = await hold(async (assertHeld) => { await assertHeld(); return 'again'; });
      const read = await engine.getPage('notes/nobody');
      expect([value, thrown, again, read]).toEqual(['migrated', 'migration failed', 'again', null]);
      return { value, thrown, again, read };
    },
  );
});
