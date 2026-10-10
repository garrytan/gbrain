/**
 * #6288 part 1 / #6352 (P2.3, UC2): a publish that neither resolves nor rejects. `boundPublication` never settles before
 * the publish does (nothing releases or reports a request while its transaction can still commit), marks it overdue at
 * the ceiling, aborts its signal after the grace (it reaches the transaction only on an engine that takes
 * `transaction(fn, { signal })`) and reports stuck after the settle window. Barrier cases hold a real publishMutation at
 * `before_publication` (after the token lock), `after_publication` (after the file rename) and `before_commit`, then
 * release it: the write commits exactly once. On Postgres the publish transaction carries a transaction-local
 * idle_in_transaction_session_timeout, so a publisher idle past it is ended by the server and commits nothing.
 * Synthetic content only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { publishSingleWrite } from '../src/core/persistence/group-publish.ts';
import { bindPublicationTimeouts, boundPublication, publicationIdleTimeoutMs, publicationTransaction, PUBLICATION_CEILING_DEFAULT_MS } from '../src/core/persistence/publication-deadline.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const putPage = operations.find(o => o.name === 'put_page')!;
const page = (body: string) => `---\ntitle: Example\ntype: note\n---\n\n${body}\n`;
const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('boundPublication', () => {
  test('never settles before the publish; overdue at the ceiling, signal aborted after the grace, stuck after the settle window', async () => {
    const events: string[] = [];
    let release!: (value: string) => void, seen: AbortSignal | undefined;
    const fake = { transaction: (fn: (tx: unknown) => Promise<unknown>, opts?: { signal?: AbortSignal }) => { seen = opts?.signal; return fn({}); } } as unknown as BrainEngine;
    let stuckSettled: Promise<void> | undefined;
    const work = boundPublication(() => publicationTransaction(fake, () => new Promise<string>(resolve => { release = resolve; })),
      { ceilingMs: 20, graceMs: 20, settleMs: 20, onOverdue: () => events.push('overdue'), onStuck: settled => { events.push('stuck'); stuckSettled = settled; } });
    let outcome: string | undefined;
    void work.then(value => { outcome = value; });
    await tick(10); expect(events).toEqual([]); expect(seen?.aborted).toBe(false);
    await tick(20); expect(events).toEqual(['overdue']); expect(seen?.aborted).toBe(false);
    await tick(20); expect(seen?.aborted).toBe(true); expect(events).toEqual(['overdue']);
    await tick(25); expect(events).toEqual(['overdue', 'stuck']);
    expect(outcome).toBeUndefined();
    release('committed');
    expect(await work).toBe('committed');
    await stuckSettled;
  });

  test('a publish that settles in time fires nothing; a rejection propagates; outside a publication no signal is passed', async () => {
    const events: string[] = [];
    expect(await boundPublication(async () => 'ok', { ceilingMs: 30, onOverdue: () => events.push('overdue'), onStuck: () => events.push('stuck') })).toBe('ok');
    await expect(boundPublication(async () => { throw new Error('boom'); }, { ceilingMs: 30 })).rejects.toThrow('boom');
    await tick(50);
    expect(events).toEqual([]);
    let opts: unknown = 'unset';
    await publicationTransaction({ transaction: (fn: (tx: unknown) => Promise<unknown>, o?: unknown) => { opts = o; return fn({}); } } as unknown as BrainEngine, async () => 1);
    expect(opts).toBeUndefined();
    expect(PUBLICATION_CEILING_DEFAULT_MS).toBe(300_000);
    expect(publicationIdleTimeoutMs(60_000)).toBe(60_000);
  });
});

for (const kind of testBackends()) {
  describe(`a publish held past the publication ceiling (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let root = '';
    const home = mkdtempSync(join(tmpdir(), 'gbrain-pub-deadline-home-'));
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
    }, 120_000);
    afterAll(async () => { await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine)); await close?.(); rmSync(home, { recursive: true, force: true }); });
    beforeEach(async () => {
      await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
      if (kind === 'pglite') await resetPgliteState(engine as PGLiteEngine);
      _resetWriteThroughCacheForTest();
      if (kind === 'postgres' && root) return;
      root = mkdtempSync(join(home, 'brain-'));
      await engine.setConfig('sync.repo_path', root);
      if (kind === 'postgres') {
        // Postgres binds no worktree on first write; claim it once for this file (a second claim would need a transfer).
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, 'default', root));
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
    });
    const context = (): OperationContext => ({ engine, config: { engine: kind, embedding_disabled: true } as OperationContext['config'],
      logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });

    /** Admits and claims one put_page of `slug` the way the resident consumer would, after a first write bound the worktree. */
    async function claimedPut(slug: string) {
      await putPage.handler(context(), { slug: `notes/bootstrap-${randomUUID().slice(0, 8)}`, content: page('Binds the worktree.'), request_id: randomUUID() });
      await disposePersistenceConsumer(engine);
      const binding = (await getWorktreeBinding(engine, 'default'))!;
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const authority = await submissionAuthority(context(), 'put_page', 'default', source!.incarnation, slug);
      const intent = { content: page('Written by a process that cannot lock.') };
      await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: source!.incarnation,
        slug, pageId: null, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation, requestId: randomUUID(), callerIntent: intent, intent });
      const row = (await claimNextWrite(engine, localHostId()))!;
      return { row, binding, prepared: await preparePageMutation(engine, row, context().config) };
    }
    for (const boundary of ['before_publication', 'after_publication', 'before_commit'] as const) {
      test(`a publish held at ${boundary} past the ceiling is reported overdue and stuck, never settled early; released, it commits once`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
        const slug = `notes/held-${boundary.replaceAll('_', '-')}`;
        const { row, prepared } = await claimedPut(slug);
        let open!: () => void;
        const barrier = new Promise<void>(resolve => { open = resolve; });
        const events: string[] = [];
        const work = boundPublication(() => publishMutation(engine, row, prepared, localHostId(), { boundary: async name => { if (name === boundary) await barrier; } }),
          { ceilingMs: 30, graceMs: 30, settleMs: 30, onOverdue: () => events.push('overdue'), onStuck: () => events.push('stuck') });
        let settled = false;
        void work.then(() => { settled = true; }, () => { settled = true; });
        await tick(150);
        expect(events).toEqual(['overdue', 'stuck']);
        expect(settled).toBe(false);
        // PGLite has one connection, held by the open publish transaction: a read there would wait behind it.
        if (kind === 'postgres') expect((await getWriteRequestById(engine, row.id))?.state).toBe('running');
        open();
        const done = await work;
        expect(done.state).toBe('committed');
        const [count] = await engine.executeRaw<{ n: number | string }>("SELECT count(*) AS n FROM persistence_requests WHERE id=$1::uuid AND state='committed'", [row.id]);
        expect(Number(count!.n)).toBe(1);
        expect(await engine.getPage(slug, { sourceId: 'default' })).not.toBeNull();
      }), 120_000);
    }

    test('the publish transaction opens with the idle bound (Postgres) and receives the publication signal', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      const { row, prepared } = await claimedPut('notes/bound-wiring');
      const first: string[] = [], signals: Array<AbortSignal | undefined> = [];
      const recording = new Proxy(engine, { get(target, key) {
        if (key === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>, opts?: { signal?: AbortSignal }) => {
          signals.push(opts?.signal);
          let seen = false;
          return target.transaction(tx => fn(new Proxy(tx, { get(t, k) {
            if (k === 'executeRaw') return (sql: string, ...rest: unknown[]) => { if (!seen) { seen = true; first.push(sql); } return (t.executeRaw as (...a: unknown[]) => unknown)(sql, ...rest); };
            const member = Reflect.get(t, k, t); return typeof member === 'function' ? member.bind(t) : member;
          } })));
        };
        const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
      } }) as BrainEngine;
      const done = await boundPublication(() => publishMutation(recording, row, prepared, localHostId()), { ceilingMs: 60_000 });
      expect(done.state).toBe('committed');
      const publish = first.findIndex(sql => sql.includes('idle_in_transaction_session_timeout'));
      if (kind === 'postgres') expect(publish).toBeGreaterThanOrEqual(0); else expect(publish).toBe(-1);
      expect(signals.some(signal => signal instanceof AbortSignal)).toBe(true);
    }), 120_000);

    for (const path of kind === 'postgres' ? ['publishMutation', 'publishSingleWrite'] as const : ['publishMutation'] as const)
    test(`a refused timeout bind fails the publication inside its own transaction, with no unhandled rejection, and leaves no page (${path})`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
      const slug = `notes/bind-refused-${path.toLowerCase()}`;
      const { row, prepared } = await claimedPut(slug);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        const refusing = new Proxy(engine, { get(target, key) {
          if (key === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(new Proxy(tx, { get(t, k) {
            if (k === 'kind') return 'postgres';
            if (k === 'executeRaw') return (sql: string, ...rest: unknown[]) => sql.includes('idle_in_transaction_session_timeout')
              ? Promise.reject(Object.assign(new Error('SET refused by the pooler'), { code: '0A000' })) : (t.executeRaw as (...a: unknown[]) => unknown)(sql, ...rest);
            const member = Reflect.get(t, k, t); return typeof member === 'function' ? member.bind(t) : member;
          } })));
          const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
        } }) as BrainEngine;
        const outcome = await (path === 'publishMutation' ? publishMutation(refusing, row, prepared, localHostId()) : publishSingleWrite(refusing, row, prepared, localHostId())).then(done => ({ done }), error => ({ error }));
        await tick(50);
        expect(unhandled).toEqual([]);
        if ('done' in outcome) expect(outcome.done.state).not.toBe('committed');
        else expect(String((outcome.error as Error).message)).toContain('SET refused');
        expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
      } finally { process.off('unhandledRejection', onUnhandled); }
    }), 120_000);

    test(kind === 'postgres' ? 'a publish transaction idle past its bound is ended by the server and commits nothing' : 'PGLite: the idle bound is never applied (an ended idle transaction would wedge its only connection)', async () => {
      const before = await engine.executeRaw<{ n: number | string }>("SELECT count(*) AS n FROM config WHERE key='p23.probe'");
      const attempt = publicationTransaction(engine, async tx => {
        await bindPublicationTimeouts(tx);
        const [shown] = await tx.executeRaw<{ v: string }>("SELECT current_setting('idle_in_transaction_session_timeout') AS v");
        // PGLite would enforce the bound too, and an idle transaction it ends wedges its only connection, so it is never set there.
        expect(shown!.v === '0').toBe(kind !== 'postgres');
        if (kind === 'postgres') await tx.executeRaw("SELECT set_config('idle_in_transaction_session_timeout','300ms',true)");
        await tx.executeRaw("INSERT INTO config(key,value) VALUES('p23.probe','x')");
        await tick(1200);
        await tx.executeRaw('SELECT 1');
        return 'committed';
      });
      if (kind === 'postgres') await expect(attempt).rejects.toBeDefined();
      else expect(await attempt).toBe('committed');
      const [after] = await engine.executeRaw<{ n: number | string }>("SELECT count(*) AS n FROM config WHERE key='p23.probe'");
      expect(Number(after!.n) - Number(before[0]!.n)).toBe(kind === 'postgres' ? 0 : 1);
      if (kind !== 'postgres') await engine.executeRaw("DELETE FROM config WHERE key='p23.probe'");
    }, 30_000);
  });
}
