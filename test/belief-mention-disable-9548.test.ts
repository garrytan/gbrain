/**
 * #9548: turning mention linking off on a belief-covered source removes the plain mention links the pass wrote.
 *
 * 1. Protects: each removed link is journaled as an unmanaged `link.retracted` (op `mention_pass`), so the ledger's
 *    last state for the origin page matches its stored links and the drift scan finds nothing.
 * 2. Fails when: the disable step deletes the links outside a belief batch: the ledger still asserts them and the
 *    origin page reads as drift.
 * 3. Why existing coverage misses it: belief-stale-links-7031 journals the pass's reconcile writes; no probe runs the
 *    disable branch on a covered source.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { scanBeliefDrift } from '../src/core/belief/coverage-report.ts';
import { runMentionPass } from '../src/core/mentions/pass.ts';
import { maintenanceAttribution } from '../src/core/persistence/attribution.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const origin = 'companies/acme-example', target = 'people/alice-example';

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe('#9548 mention disable on a belief-covered source (' + engineCase.name + ')', () => {
    test('disabling mention linking journals each removed plain mention link and leaves no drift', async () => {
      await beliefBrain(async b => {
        await b.put(target, beliefPage({ type: 'person', title: 'Alice Example' }));
        await b.put(origin, beliefPage({ prose: 'Acme Example met Alice Example last week.' }));
        expect(await runMentionPass(b.engine, { sourceId: b.sourceId })).toMatchObject({ created: 1 });
        const asserted = (await b.events()).findLast(e => e.subject_kind === 'link')!;
        expect([asserted.slug, asserted.event_type, asserted.cause.op]).toEqual([origin, 'link.asserted', 'mention_pass']);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        const before = await b.lastId();
        await b.engine.setConfig('mentions.auto_link', 'false');
        expect(await runMentionPass(b.engine, { sourceId: b.sourceId })).toMatchObject({ removed: 1, state: 'disabled' });
        expect(await b.engine.executeRaw("SELECT 1 FROM links WHERE link_source = 'mentions'")).toEqual([]);
        const events = await b.events(before);
        expect(events.map(e => [e.slug, e.subject_key, e.event_type, e.origin, e.cause.op]))
          .toEqual([[origin, asserted.subject_key, 'link.retracted', 'unmanaged', 'mention_pass']]);
        const publications = [...new Set(events.map(e => e.publication_id))];
        expect(await b.engine.executeRaw('SELECT 1 FROM belief_commit_marks WHERE publication_id = ANY($1::uuid[])', [publications]))
          .toHaveLength(publications.length);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
      }, { managed: true, databaseUrl: engineCase.databaseUrl });
    }, 180_000);

    if (engineCase.name === 'postgres') {
      const other = 'source-b', person = 'people/alice-example', colleague = 'people/bob-example', local = 'notes/source-a-note';
      const pid = async (db: Pick<BrainEngine, 'executeRaw'>) => Number((await db.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid);
      const blockedBy = async (b: BeliefBrain, holder: number) => (await b.engine.executeRaw<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))', [holder])).map(r => Number(r.pid));
      // The engine's transactions run `hook` on each statement of the wrapped tx, so a test can hold one mid-transaction.
      const pausing = (engine: BrainEngine, hook: (tx: BrainEngine, member: string, args: unknown[]) => Promise<void>) => new Proxy(engine, { get(target, key) {
        if (key === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => run(new Proxy(tx, { get(inner, member) {
          const value = Reflect.get(inner, member);
          if (typeof value !== 'function') return value;
          return async (...args: unknown[]) => { await hook(inner, String(member), args); return value.apply(inner, args); };
        } })));
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const twoSources = async (b: BeliefBrain) => {
        await b.engine.setConfig('link_resolution.cross_source', 'true');
        await b.engine.transaction(async tx => {
          await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
          await tx.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [other]);
        });
        const actor = await maintenanceAttribution(b.engine);
        await b.engine.transaction(tx => withCoordinatedWrite(tx, [other], async () => {
          await tx.putPage(person, { type: 'person', title: 'Alice Example', compiled_truth: 'Works with Bob Example.' }, { sourceId: other });
          await tx.putPage(colleague, { type: 'person', title: 'Bob Example', compiled_truth: 'A synthetic person.' }, { sourceId: other });
        }, actor));
        await enableBeliefLedger(b.engine, other);
        await b.put(local, beliefPage({ type: 'note', title: 'Source A note', prose: 'No names yet.' }));
        expect(await runMentionPass(b.engine, { sourceId: other })).toMatchObject({ state: 'complete', created: 1 });
        expect(await runMentionPass(b.engine, { sourceId: b.sourceId })).toMatchObject({ state: 'complete', created: 0 });
        await b.put(local, beliefPage({ type: 'note', title: 'Source A note', prose: 'Met Alice Example.' }));
        await disposePersistenceConsumer(b.engine);
      };
      // Neither pass fails (no 40P01), the disable removes source B's one link, and only source A's mention can remain.
      const settle = async (b: BeliefBrain, passes: Array<Promise<unknown>>) => {
        const results = await Promise.allSettled(passes);
        const failures = results.flatMap(r => r.status === 'rejected' ? [{ code: (r.reason as { code?: string })?.code, message: String((r.reason as Error)?.message) }] : []);
        expect(failures).toEqual([]);
        const [reconciled, disabled] = results.map(r => (r as PromiseFulfilledResult<{ created: number }>).value);
        expect(disabled).toMatchObject({ state: 'disabled', removed: 1 });
        const remaining = await b.engine.executeRaw(
          "SELECT f.source_id, f.slug, t.source_id AS target_source, t.slug AS target FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE l.link_source = 'mentions'");
        expect(remaining).toEqual(reconciled!.created ? [{ source_id: b.sourceId, slug: local, target_source: other, target: person }] : []);
        return reconciled!;
      };

      test('a disable that waits behind a cross-source reconcile holding its status row completes without deadlock', async () => {
        await beliefBrain(async b => {
          await twoSources(b);
          const reached = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
          let disablePid = 0;
          const reconciling = pausing(b.engine, async (tx, member, args) => {
            if (member !== 'addLinksBatch' || !(args[0] as Array<{ to_source_id?: string }>).some(r => r.to_source_id === other)) return;
            reached.resolve(await pid(tx));
            await release.promise;
          });
          const disabling = pausing(b.engine, async (tx, member, args) => {
            // The write context (gbrain.write_sources) is the typed setWriteContext member now; it was one raw set_config statement.
            if ((member === 'setWriteContext' || (member === 'executeRaw' && String(args[0]).includes('gbrain.write_sources'))) && !disablePid) disablePid = await pid(tx);
          });
          const watchdog = setTimeout(() => release.resolve(), 30_000);
          const reconcile = runMentionPass(reconciling, { sourceId: b.sourceId });
          void reconcile.catch(error => reached.reject(error));
          let disable: Promise<unknown> | undefined;
          try {
            const holder = await reached.promise;
            await b.engine.setConfig('mentions.auto_link', 'false');
            disable = runMentionPass(disabling, { sourceId: other });
            void disable.catch(() => undefined);
            await waitFor(async () => disablePid > 0 && (await blockedBy(b, holder)).includes(disablePid),
              { timeoutMs: 20_000, label: 'the disable waits on the reconcile transaction' });
          } finally {
            release.resolve();
            clearTimeout(watchdog);
          }
          expect(await settle(b, [reconcile, disable!])).toMatchObject({ state: 'complete', created: 1 });
        }, { managed: true, databaseUrl: engineCase.databaseUrl });
      }, 180_000);

      test('a cross-source reconcile that runs while the disable is mid-transaction completes without deadlock', async () => {
        await beliefBrain(async b => {
          await twoSources(b);
          const scanned = Promise.withResolvers<void>(), publish = Promise.withResolvers<void>();
          const deleted = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
          const disabling = pausing(b.engine, async (tx, member, args) => {
            if (member !== 'executeRaw' || !String(args[0]).includes('INSERT INTO mention_index_status')) return;
            deleted.resolve(await pid(tx));
            await release.promise;
          });
          const watchdog = setTimeout(() => { publish.resolve(); release.resolve(); }, 30_000);
          const reconcile = runMentionPass(b.engine, { sourceId: b.sourceId, beforePublish: async () => { scanned.resolve(); await publish.promise; } });
          void reconcile.catch(error => scanned.reject(error));
          let disable: Promise<unknown> | undefined;
          let settled = false;
          try {
            await scanned.promise;
            await b.engine.setConfig('mentions.auto_link', 'false');
            disable = runMentionPass(disabling, { sourceId: other });
            void disable.catch(error => deleted.reject(error));
            const holder = await deleted.promise;
            publish.resolve();
            void reconcile.finally(() => { settled = true; }).catch(() => undefined);
            await waitFor(async () => settled || (await blockedBy(b, holder)).length > 0,
              { timeoutMs: 20_000, label: 'the reconcile publishes or waits on the disable transaction' });
          } finally {
            publish.resolve();
            release.resolve();
            clearTimeout(watchdog);
          }
          await settle(b, [reconcile, disable!]);
        }, { managed: true, databaseUrl: engineCase.databaseUrl });
      }, 180_000);
    }
  });
}
