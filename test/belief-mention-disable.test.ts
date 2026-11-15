import { describe, expect, test } from 'bun:test';
import type { LinkBatchInput } from '../src/core/engine.ts';
import { disableBeliefLedger } from '../src/core/belief/coverage.ts';
import { scanBeliefDrift } from '../src/core/belief/coverage-report.ts';
import { eventKeyHex, valueHash } from '../src/core/belief/keys.ts';
import { currentStateHash } from '../src/core/belief/ledger.ts';
import { unmanagedBeliefPoint } from '../src/core/belief/projection-point.ts';
import { runMentionPass } from '../src/core/mentions/pass.ts';
import { maintenanceAttribution } from '../src/core/persistence/attribution.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain, type BeliefEvent } from './helpers/belief-ledger.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const origin = 'notes/journal-test', target = 'companies/zebra-test';
async function seed(b: BeliefBrain, scan = true) {
  await b.engine.setConfig('schema_pack', 'gbrain-base-v2');
  await b.put(target, beliefPage({ type: 'company', title: 'Zebra Holdings', prose: 'A company.' }));
  await b.put(origin, beliefPage({ type: 'note', title: 'Notes', prose: 'Met Zebra Holdings today.' }));
  if (scan) expect((await runMentionPass(b.engine, { sourceId: b.sourceId })).created).toBe(1);
}
const disable = async (b: BeliefBrain) => {
  await b.engine.setConfig('mentions.auto_link', 'false');
  return runMentionPass(b.engine, { sourceId: b.sourceId });
};
const links = (b: BeliefBrain) => b.engine.executeRaw(
  `SELECT f.source_id, f.slug, t.source_id AS target_source, t.slug AS target, l.link_type, l.link_source, l.link_kind
     FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id ORDER BY l.id`);
async function snapshot(b: BeliefBrain) {
  const out = [];
  for (const table of ['links', 'page_aliases', 'mention_gazetteer_entries', 'page_mention_state', 'mention_index_status',
    'belief_events', 'belief_commit_marks', 'belief_page_lifetimes']) {
    out.push(await b.engine.executeRaw(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`));
  }
  return out;
}
async function journal(b: BeliefBrain, events: BeliefEvent[]) {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    expect(e.event_key).toBe(eventKeyHex(e.publication_id, e.subject_key, e.event_type));
    expect(e.state_hash).toBe((await currentStateHash(b.engine, b.sourceId, e.source_incarnation, e.slug, { readOnly: true })).hash);
    expect(e.cause.request).toBe(e.publication_id);
  }
  const ids = [...new Set(events.map(e => e.publication_id))];
  expect(await b.engine.executeRaw('SELECT publication_id FROM belief_commit_marks WHERE publication_id=ANY($1::uuid[])', [ids])).toHaveLength(ids.length);
  expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
}
async function addLinks(b: BeliefBrain, rows: LinkBatchInput[]) {
  const sources = [...new Set(rows.map(r => r.from_source_id ?? b.sourceId))];
  const point = unmanagedBeliefPoint(b.sourceId, rows.filter(r => r.from_source_id === b.sourceId).map(r => r.from_slug), 'fixture_links');
  const actor = await maintenanceAttribution(b.engine);
  await b.engine.transaction(tx => withCoordinatedWrite(tx, sources, async () => {
    await tx.lockPageKeys(rows.map(r => ({ sourceId: r.from_source_id ?? b.sourceId, slug: r.from_slug })));
    await point.run(tx, () => tx.addLinksBatch(rows));
  }, actor));
  await point.commit(b.engine);
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe('mention disable journals deletions (' + engineCase.name + ')', () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, opts: { managed?: boolean; enable?: boolean } = {}) =>
      beliefBrain(run, { managed: true, ...opts, databaseUrl: engineCase.databaseUrl });

    test('disabling mentions retracts each origin link without drift', async () => {
      await brain(async b => {
        await seed(b);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        const asserted = (await b.events()).findLast(e => e.subject_kind === 'link')!;
        const last = await b.lastId();
        expect(await disable(b)).toMatchObject({ removed: 1, state: 'disabled' });
        const events = await b.events(last);
        expect(events.map(e => [e.slug, e.event_type, e.origin, e.cause.op]))
          .toEqual([[origin, 'link.retracted', 'unmanaged', 'mention_pass']]);
        const { origin_field, link_kind, resolution_type, assertion_tense } = asserted.value!;
        expect(asserted.value_hash).toBe(valueHash(asserted.value));
        expect(events[0]).toMatchObject({ subject_key: asserted.subject_key,
          prior_hash: valueHash({ origin_field, link_kind, resolution_type, assertion_tense }), value: null, value_hash: null });
        expect(events[0]!.state_hash).not.toBe(asserted.state_hash);
        await journal(b, events);
        expect(await links(b)).toEqual([]);
        const disabled = await snapshot(b);
        expect(await disable(b)).toMatchObject({ removed: 0, state: 'disabled' });
        expect(await snapshot(b)).toEqual(disabled);
      });
    }, 180_000);

    test('retains typed and other producer edges, aliases and the other source twin, with coordinated attribution', async () => {
      await brain(async b => {
        await seed(b);
        const twin = 'twin-test', second = 'notes/second-test', actor = await maintenanceAttribution(b.engine);
        await b.put(second, beliefPage({ type: 'note', title: 'Second', prose: 'Synthetic second origin.' }));
        await b.engine.transaction(async tx => {
          await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
          await tx.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [twin]);
        });
        await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId, twin], async () => {
          await tx.putPage(origin, { type: 'note', title: 'Twin', compiled_truth: 'Synthetic twin.' }, { sourceId: twin });
          await tx.setPageAliases(target, b.sourceId, ['retained-alias'], { inline: true });
        }, actor));
        const row = { from_slug: origin, to_slug: target, from_source_id: b.sourceId, to_source_id: b.sourceId };
        await addLinks(b, [
          { ...row, link_type: 'explicit-plain', link_source: 'mentions', link_kind: 'plain' },
          { ...row, link_type: 'works-at', link_source: 'mentions', link_kind: 'typed_ner' },
          { ...row, link_type: 'manually-linked', link_source: 'manual' },
          { ...row, link_type: 'references', link_source: 'markdown' },
          { ...row, link_type: 'cites', link_source: 'citation-graph' },
          { ...row, to_slug: origin, to_source_id: twin, link_type: 'cross-source', link_source: 'mentions' },
          { ...row, from_source_id: twin, link_type: 'twin-mention', link_source: 'mentions' },
          { ...row, from_slug: second, link_type: 'mentions', link_source: 'mentions' },
        ]);
        const retained = (await links(b)).filter(r => r.link_kind === 'typed_ner' || r.link_source !== 'mentions' || r.source_id === twin);
        expect(retained).toHaveLength(5);
        await b.engine.executeRaw('CREATE TABLE disable_actors (kind text, actor text, request text, sources text)');
        await b.engine.executeRaw(`CREATE FUNCTION capture_disable_actor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          INSERT INTO disable_actors VALUES(current_setting('gbrain.write_principal_kind',true),current_setting('gbrain.write_principal_id',true),
            current_setting('gbrain.write_request',true),current_setting('gbrain.write_sources',true)); RETURN OLD; END $$`);
        await b.engine.executeRaw('CREATE TRIGGER capture_disable_actor BEFORE DELETE ON links FOR EACH ROW EXECUTE FUNCTION capture_disable_actor()');
        const last = await b.lastId();
        expect(await disable(b)).toMatchObject({ removed: 4, state: 'disabled' });
        expect(await links(b)).toEqual(retained);
        const events = await b.events(last);
        expect(events).toHaveLength(4);
        expect(events.map(e => e.slug).sort()).toEqual([origin, origin, origin, second]);
        expect(events.every(e => e.source_id === b.sourceId && e.event_type === 'link.retracted' && e.origin === 'unmanaged')).toBe(true);
        await journal(b, events);
        expect(await b.engine.executeRaw('SELECT origin FROM page_aliases WHERE source_id=$1', [b.sourceId])).toEqual([{ origin: 'frontmatter' }]);
        const actors = await b.engine.executeRaw('SELECT * FROM disable_actors');
        expect(actors.length).toBeGreaterThan(0);
        expect(actors.every(r => r.kind === actor.principal.kind && r.actor === actor.principal.id && !r.request && r.sources === JSON.stringify([b.sourceId]))).toBe(true);
      });
    }, 180_000);

    for (const control of ['no coverage', 'stopped coverage', 'unmanaged covered'] as const) {
      test(control + ' keeps its recording contract', async () => {
        await brain(async b => {
          await seed(b);
          if (control === 'stopped coverage') await disableBeliefLedger(b.engine, b.sourceId);
          const last = await b.lastId(), marks = await b.engine.executeRaw('SELECT * FROM belief_commit_marks ORDER BY publication_id');
          expect(await disable(b)).toMatchObject({ removed: 1, state: 'disabled' });
          expect(await links(b)).toEqual([]);
          if (control === 'unmanaged covered') {
            const events = await b.events(last);
            expect(events.map(e => [e.event_type, e.origin])).toEqual([['link.retracted', 'unmanaged']]);
            await journal(b, events);
          } else {
            expect(await b.events(last)).toEqual([]);
            expect(await b.engine.executeRaw('SELECT * FROM belief_commit_marks ORDER BY publication_id')).toEqual(marks);
          }
        }, { managed: control !== 'unmanaged covered', enable: control !== 'no coverage' });
      }, 180_000);
    }

    test('empty disable has no events or commit marks', async () => {
      await brain(async b => {
        const last = await b.lastId(), marks = await b.engine.executeRaw('SELECT * FROM belief_commit_marks ORDER BY publication_id');
        expect(await disable(b)).toMatchObject({ removed: 0, state: 'disabled' });
        expect(await b.events(last)).toEqual([]);
        expect(await b.engine.executeRaw('SELECT * FROM belief_commit_marks ORDER BY publication_id')).toEqual(marks);
      });
    }, 180_000);

    for (const table of ['mention_index_status', 'belief_events']) {
      test('failure at ' + table + ' rolls back the whole disable', async () => {
        await brain(async b => {
          await seed(b);
          await b.engine.executeRaw(`CREATE FUNCTION reject_disable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected disable rollback'; END $$`);
          await b.engine.executeRaw(`CREATE TRIGGER reject_disable BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_disable()`);
          const before = await snapshot(b);
          try { await expect(disable(b)).rejects.toThrow('injected disable rollback'); }
          finally { await b.engine.executeRaw(`DROP TRIGGER reject_disable ON ${table}`); }
          expect(await snapshot(b)).toEqual(before);
          expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
          const last = await b.lastId();
          expect(await disable(b)).toMatchObject({ removed: 1, state: 'disabled' });
          await journal(b, await b.events(last));
        });
      }, 180_000);
    }

    test('a scanned reconcile cannot publish its old generation after disable', async () => {
      await brain(async b => {
        await seed(b, false);
        const last = await b.lastId();
        let paused = false;
        const pass = await runMentionPass(b.engine, { sourceId: b.sourceId, beforePublish: async () => {
          paused = true;
          expect(await disable(b)).toMatchObject({ removed: 0, state: 'disabled' });
        } });
        expect(paused).toBe(true);
        expect(pass.created).toBe(0);
        expect(pass.skipped).toBeGreaterThan(0);
        expect(await links(b)).toEqual([]);
        expect(await b.events(last)).toEqual([]);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
      });
    }, 180_000);

    if (engineCase.name === 'postgres') test('disable waits for an origin publisher but never sweeps a new unlocked origin', async () => {
      await brain(async b => {
        await seed(b);
        const actor = await maintenanceAttribution(b.engine), last = await b.lastId();
        const ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
        const point = unmanagedBeliefPoint(b.sourceId, [origin], 'fixture_publisher');
        const holding = b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug: origin }]);
          await tx.executeRaw('SELECT source_id FROM mention_index_status WHERE source_id=$1 FOR SHARE', [b.sourceId]);
          await point.run(tx, async () => {
            await tx.addLinksBatch([{ from_slug: origin, to_slug: target, from_source_id: b.sourceId, to_source_id: b.sourceId, link_type: 'mentions', link_source: 'mentions' }]);
            ready.resolve(Number((await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid));
            await release.promise;
          });
        }, actor));
        holding.catch(ready.reject);
        let pending: ReturnType<typeof runMentionPass> | undefined;
        try {
          const pid = await ready.promise;
          pending = disable(b);
          void pending.catch(() => undefined);
          await waitFor(async () => (await b.engine.executeRaw<{ waiting: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))
              AND query LIKE '%page_write_guards%') AS waiting`, [pid]))[0]!.waiting,
          { timeoutMs: 20_000, label: 'disable waits on the origin page key before status locks' });
          const late = 'notes/late-test';
          await b.put(late, beliefPage({ type: 'note', title: 'Late', prose: 'Synthetic late origin.' }));
          await addLinks(b, [{ from_slug: late, to_slug: target, from_source_id: b.sourceId, to_source_id: b.sourceId, link_source: 'mentions' }]);
        } finally {
          release.resolve();
          await holding;
          await point.commit(b.engine);
          if (pending) expect(await pending).toMatchObject({ removed: 1, state: 'disabled' });
        }
        expect((await links(b)).map(r => r.slug)).toEqual(['notes/late-test']);
        const events = await b.events(last), removed = events.filter(e => e.event_type === 'link.retracted');
        expect(removed.map(e => e.slug)).toEqual([origin]);
        await journal(b, removed);
        const publications = [...new Set(events.map(e => e.publication_id))];
        expect(await b.engine.executeRaw('SELECT publication_id FROM belief_commit_marks WHERE publication_id=ANY($1::uuid[])', [publications])).toHaveLength(publications.length);
      });
    }, 180_000);

    if (engineCase.name === 'postgres') test('uncovered disable does not invert status and page reader locks', async () => {
      await brain(async b => {
        await seed(b);
        const ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
        const holding = b.engine.transaction(async tx => {
          await tx.executeRaw('SELECT source_id FROM mention_index_status WHERE source_id=$1 FOR SHARE', [b.sourceId]);
          ready.resolve(Number((await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid));
          await release.promise;
          await tx.executeRaw('SELECT id FROM pages WHERE source_id=$1 FOR SHARE', [b.sourceId]);
        });
        void holding.catch(ready.reject);
        let pending: ReturnType<typeof runMentionPass> | undefined;
        let results: PromiseSettledResult<unknown>[] = [];
        try {
          const pid = await ready.promise;
          pending = disable(b);
          void pending.catch(() => undefined);
          await waitFor(async () => (await b.engine.executeRaw<{ waiting: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))
              AND query LIKE '%mention_index_status%') AS waiting`, [pid]))[0]!.waiting,
          { timeoutMs: 20_000, label: 'uncovered disable waits on the status reader' });
        } finally {
          release.resolve();
          results = await Promise.allSettled(pending ? [holding, pending] : [holding]);
        }
        expect(results.filter(r => r.status === 'rejected').map(r => r.reason?.code)).not.toContain('40P01');
        expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(await pending).toMatchObject({ removed: 1, state: 'disabled' });
        expect(await links(b)).toEqual([]);
        expect(await b.events()).toEqual([]);
      }, { enable: false });
    }, 180_000);

    test('covered disable leaves unrelated origin guards unchanged', async () => {
      await brain(async b => {
        await seed(b);
        const unrelated = 'notes/unrelated-test', actor = await maintenanceAttribution(b.engine);
        const point = unmanagedBeliefPoint(b.sourceId, [unrelated], 'fixture_unrelated_page');
        await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          await point.run(tx, () => tx.putPage(unrelated,
            { type: 'note', title: 'Unrelated', compiled_truth: 'No entity names.' }, { sourceId: b.sourceId, inline: true }));
          await tx.executeRaw(`DELETE FROM page_write_guards WHERE source_incarnation=(SELECT incarnation FROM sources WHERE id=$1) AND slug=$2`, [b.sourceId, unrelated]);
        }, actor));
        await point.commit(b.engine);
        const guards = () => b.engine.executeRaw<{ slug: string }>(
          `SELECT g.slug FROM page_write_guards g JOIN sources s ON s.incarnation=g.source_incarnation WHERE s.id=$1 ORDER BY g.slug`, [b.sourceId]);
        const before = await guards(), last = await b.lastId();
        expect(before.some(g => g.slug === unrelated)).toBe(false);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        expect(await disable(b)).toMatchObject({ removed: 1, state: 'disabled' });
        expect(await guards()).toEqual(before);
        expect(await links(b)).toEqual([]);
        const events = await b.events(last);
        expect(events.map(e => [e.slug, e.event_type, e.origin, e.cause.op]))
          .toEqual([[origin, 'link.retracted', 'unmanaged', 'mention_pass']]);
        await journal(b, events);
      });
    }, 180_000);
  });
}

import type { BrainEngine } from '../src/core/engine.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { readEvents } from './helpers/belief-ledger.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

for (const engineCase of testBackends().map(beliefEngineCase).filter(c => c.name === 'postgres')) {
  describe('cross-source reconcile during covered disable (postgres)', () => {
    for (const overlap of [false, true]) {
      test((overlap ? 'target is the outgoing origin' : 'disjoint outgoing origin control') + ' completes both passes with accurate history', async () => {
        await beliefBrain(async b => {
          const other = 'cross-source-target-test', incoming = 'notes/cross-source-test';
          const outgoing = overlap ? target : 'notes/disjoint-test', localTarget = 'companies/falcon-test';
          const actor = await maintenanceAttribution(b.engine);
          await b.engine.setConfig('schema_pack', 'gbrain-base-v2');
          await b.engine.setConfig('link_resolution.cross_source', 'true');
          await b.engine.transaction(async tx => {
            await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
            await tx.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [other]);
          });
          await b.engine.transaction(tx => withCoordinatedWrite(tx, [other], async () => {
            await tx.putPage(localTarget, { type: 'company', title: 'Falcon Ventures', compiled_truth: 'A synthetic company.' }, { sourceId: other });
            await tx.putPage(target, { type: 'company', title: 'Zebra Holdings',
              compiled_truth: overlap ? 'Met Falcon Ventures.' : 'A synthetic company.' }, { sourceId: other });
            if (!overlap) await tx.putPage(outgoing, { type: 'note', title: 'Separate origin', compiled_truth: 'Met Falcon Ventures.' }, { sourceId: other });
          }, actor));
          expect(await enableBeliefLedger(b.engine, other)).toMatchObject({ complete: true, certified: true });
          await b.put(incoming, beliefPage({ type: 'note', title: 'Cross-source note', prose: 'No names yet.' }));
          expect(await runMentionPass(b.engine, { sourceId: other })).toMatchObject({ state: 'complete', created: 1 });
          expect(await runMentionPass(b.engine, { sourceId: b.sourceId })).toMatchObject({ state: 'complete', created: 0 });
          await b.put(incoming, beliefPage({ type: 'note', title: 'Cross-source note', prose: 'Met Zebra Holdings.' }));
          await disposePersistenceConsumer(b.engine);
          const before = await readEvents(b.engine, other);
          const asserted = before.findLast(e => e.event_type === 'link.asserted')!;
          expect(asserted.slug).toBe(outgoing);
          const last = Number((await b.engine.executeRaw<{ id: number }>('SELECT max(id) AS id FROM belief_events'))[0]!.id);
          const release = Promise.withResolvers<void>();
          let paused: { pid: number; rows: LinkBatchInput[] } | undefined;
          let calls = 0, invoked = 0;
          let enabled: ReturnType<typeof runMentionPass> | undefined, disabled: ReturnType<typeof runMentionPass> | undefined;
          let results: PromiseSettledResult<unknown>[] = [], barrierError: unknown;
          let blocked: Array<{ pid: number; query: string; blockers: number[] }> = [];
          const concurrent = new Proxy(b.engine, { get(engine, key) {
            if (key === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>) => engine.transaction(async tx => {
              await tx.executeRaw("SET LOCAL statement_timeout = '25s'");
              return run(new Proxy(tx, { get(inner, member) {
                if (member === 'addLinksBatch') return async (...args: Parameters<BrainEngine['addLinksBatch']>) => {
                  if (args[0].some(r => r.from_source_id === b.sourceId && r.to_source_id === other)) {
                    calls++;
                    paused = { pid: Number((await inner.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid), rows: args[0] };
                    await release.promise;
                    invoked++;
                  }
                  return inner.addLinksBatch(...args);
                };
                const value = Reflect.get(inner, member);
                return typeof value === 'function' ? value.bind(inner) : value;
              } }));
            });
            const value = Reflect.get(engine, key);
            return typeof value === 'function' ? value.bind(engine) : value;
          } });
          let disabledPid: number | undefined;
          const disabling = new Proxy(b.engine, { get(engine, key) {
            if (key === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>) => engine.transaction(async tx => {
              await tx.executeRaw("SET LOCAL statement_timeout = '25s'");
              disabledPid = Number((await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid);
              return run(tx);
            });
            const value = Reflect.get(engine, key);
            return typeof value === 'function' ? value.bind(engine) : value;
          } });
          const watchdog = setTimeout(() => release.resolve(), 20_000);
          try {
            enabled = runMentionPass(concurrent, { sourceId: b.sourceId });
            void enabled.catch(error => { barrierError = error; });
            await waitFor(() => { if (barrierError) throw barrierError; return paused !== undefined; },
              { timeoutMs: 15_000, label: 'enabled pass reaches its real cross-source link insertion' });
            await b.engine.setConfig('mentions.auto_link', 'false');
            disabled = runMentionPass(disabling, { sourceId: other });
            void disabled.catch(error => { barrierError = error; });
            await waitFor(async () => {
              if (barrierError) throw barrierError;
              blocked = await b.engine.executeRaw<{ pid: number; query: string; blockers: number[] }>(
                `SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
                  WHERE datname=current_database() AND pid=$2::int AND $1::int=ANY(pg_blocking_pids(pid))`, [paused!.pid, disabledPid ?? null]);
              return blocked.length > 0;
            }, { timeoutMs: 15_000, label: 'actual covered disable waits behind the enabled publisher' });
          } finally {
            release.resolve();
            clearTimeout(watchdog);
            results = await Promise.allSettled([enabled, disabled].filter(p => p !== undefined));
          }
          const errors = results.flatMap(r => r.status === 'rejected' ? [{ code: r.reason?.code, message: r.reason?.message, detail: r.reason?.detail }] : []);
          const afterLinks = await links(b);
          const status = await b.engine.executeRaw('SELECT source_id, state, pending, error FROM mention_index_status WHERE source_id=ANY($1::text[]) ORDER BY source_id', [[b.sourceId, other]]);
          const events = (await Promise.all([readEvents(b.engine, b.sourceId, last), readEvents(b.engine, other, last)])).flat();
          const drift = await Promise.all([b.sourceId, other].map(sourceId => scanBeliefDrift(b.engine, sourceId, { deep: true })));
          console.log('CROSS_SOURCE_DISABLE_RECEIPT=' + JSON.stringify({ overlap, syntheticInterleaving: true, paused, disabledPid, calls, invoked, blocked,
            results: results.map(r => r.status === 'fulfilled' ? { status: r.status, value: r.value } : { status: r.status, code: r.reason?.code, message: r.reason?.message, detail: r.reason?.detail }),
            links: afterLinks, status, events, drift }));
          expect(calls).toBe(1);
          expect(invoked).toBe(1);
          expect(errors.map(e => e.code)).not.toContain('40P01');
          expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
          expect(await enabled).toMatchObject({ state: 'complete', created: 1, removed: 0 });
          expect((await enabled)?.failed ?? 0).toBe(0);
          expect(await disabled).toMatchObject({ state: 'disabled', removed: 1 });
          expect(afterLinks).toEqual([{ source_id: b.sourceId, slug: incoming, target_source: other, target,
            link_type: 'mentions', link_source: 'mentions', link_kind: null }]);
          expect(status).toEqual([
            { source_id: other, state: 'disabled', pending: 0, error: null },
            { source_id: b.sourceId, state: 'complete', pending: 0, error: null },
          ].sort((a, z) => a.source_id.localeCompare(z.source_id)));
          expect(await b.engine.getConfig('mentions.auto_link')).toBe('false');
          for (const table of ['mention_gazetteer_entries', 'page_mention_state']) {
            expect(await b.engine.executeRaw(`SELECT 1 FROM ${table} WHERE source_id=$1`, [other])).toEqual([]);
          }
          expect(await b.engine.executeRaw("SELECT 1 FROM page_aliases WHERE source_id=$1 AND origin IN ('declared','subject')", [other])).toEqual([]);
          expect(events.map(e => [e.source_id, e.slug, e.event_type, e.origin, e.cause.op])).toEqual([
            [b.sourceId, incoming, 'link.asserted', 'unmanaged', 'mention_pass'],
            [other, outgoing, 'link.retracted', 'unmanaged', 'mention_pass'],
          ]);
          const retracted = events[1]!;
          const { origin_field, link_kind, resolution_type, assertion_tense } = asserted.value!;
          expect(retracted).toMatchObject({ subject_key: asserted.subject_key,
            prior_hash: valueHash({ origin_field, link_kind, resolution_type, assertion_tense }), value: null, value_hash: null });
          expect(events[0]!.value_hash).toBe(valueHash(events[0]!.value));
          for (const e of events) {
            expect(e.event_key).toBe(eventKeyHex(e.publication_id, e.subject_key, e.event_type));
            expect(e.cause.request).toBe(e.publication_id);
            expect(e.state_hash).toBe((await currentStateHash(b.engine, e.source_id, e.source_incarnation, e.slug, { readOnly: true })).hash);
          }
          const publications = [...new Set(events.map(e => e.publication_id))];
          expect(await b.engine.executeRaw('SELECT publication_id FROM belief_commit_marks WHERE publication_id=ANY($1::uuid[])', [publications])).toHaveLength(2);
          expect(drift.map(d => d.drifted)).toEqual([[], []]);
          expect((await readEvents(b.engine, other)).filter(e => e.id <= last)).toEqual(before);
        }, { managed: true, databaseUrl: engineCase.databaseUrl });
      }, 180_000);
    }
  });
}
