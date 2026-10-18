import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const { default: Queue } = await import(new URL('../vendor/postgres/src/queue.js', import.meta.url).href);
const { Query } = await import(new URL('../vendor/postgres/src/query.js', import.meta.url).href);
import { withTransactionAbort } from '../src/core/postgres-engine/transaction-abort.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

// Offline forced interleaving: actual reservation/Query/helper code, simulated
// transport and backend response. This cannot certify PostgreSQL termination.
const source = readFileSync(new URL('../vendor/postgres/src/index.js', import.meta.url), 'utf8');
const ownSource = source.slice(source.indexOf('  function own(c) {'), source.indexOf('  async function reserve('));
const cancelSource = source.slice(source.indexOf('  function cancel(query) {'), source.indexOf('  async function end('));
function fixture(mode: 'reply' | 'fail' | 'hang' = 'reply') {
  const events: string[] = [];
  let active: any;
  let reply!: () => void;
  const ready = Promise.withResolvers<void>();
  const c: any = {
    execute(q: any) { active = q; q.active = true; q.state = { pid: 1, secret: 0 }; events.push('execute'); ready.resolve(); return true; },
    terminate() { events.push('terminate'); active?.reject(Object.assign(new Error('destroyed'), { code: 'CONNECTION_DESTROYED' })); },
  };
  const own = new Function('Queue', 'Errors', 'move', 'reserved', 'full', 'onopen', ownSource + '\nreturn own;')(
    Queue, { generic: (code: string, message: string) => Object.assign(new Error(message), { code }) },
    () => {}, {}, {}, () => events.push('release'),
  );
  const reservation = own(c);
  const handle: any = {
    discard: reservation.discard,
    cancelAndDiscard: reservation.cancelAndDiscard,
  };
  const cancel = new Function('Connection', 'options', 'queries', 'Errors', cancelSource + '\nreturn cancel;')(
    () => ({ cancel(_state: unknown, resolve: () => void, reject: (e: Error) => void) {
      events.push('cancel:start');
      if (mode === 'fail') { reject(new Error('cancel transport failed')); return; }
      reply = () => {
        events.push('backend:57014');
        active.reject(Object.assign(new Error('cancelled'), { code: '57014' }));
        reservation(); resolve(); events.push('cancel:confirmed');
      };
    } }), {}, Queue(), { generic: (code: string, message: string) => Object.assign(new Error(message), { code }) },
  );
  const query = () => new Query(['SELECT synthetic'], [], (q: any) => reservation.enqueue(q), cancel, { cancelFence: true });
  handle.unsafe = query;
  return { events, ready: ready.promise, reservation, handle, query, respond: () => reply(), c };
}

describe('transaction cancellation ordering (offline actual Query/reservation)', () => {
  test('parent abort preserves canceller until backend response, with child listener registered later', async () => {
    const traces: string[][] = [];
    await Promise.all(Array.from({ length: 8 }, async () => {
      const f = fixture(); const ac = new AbortController();
      const engine = new PostgresEngine();
      Object.defineProperty(engine, '_sql', { value: f.handle });
      const result = withTransactionAbort(ac.signal, async attach => {
        attach(f.handle);
        return await engine.executeRaw('SELECT synthetic', [], { signal: ac.signal });
      }).then(() => null, e => e);
      await f.ready; ac.abort(new Error('deadline'));
      if (!f.events.includes('cancel:start')) console.log(JSON.stringify({ evidence: 'offline-failed-order', events: f.events }));
      expect(f.events.filter(e => e === 'cancel:start')).toHaveLength(1);
      expect(f.events).not.toContain('terminate');
      f.respond();
      const error = await result;
      expect(error.name).toBe('AbortError');
      expect(f.events.indexOf('cancel:confirmed')).toBeLessThan(f.events.indexOf('terminate'));
      traces.push(f.events);
    }));
    console.log(JSON.stringify({ evidence: 'offline-forced-interleaving', traces }));
  });

  test('queued and new queries cannot execute while cancellation awaits a backend response', async () => {
    const f = fixture(); const q = f.query(); const first = q.catch((e: any) => e);
    await f.ready;
    const stop = f.reservation.cancelAndDiscard();
    const second = f.query().catch((e: any) => e);
    expect((await second).code).toBe('CONNECTION_CLOSED');
    expect(f.events.filter(e => e === 'execute')).toHaveLength(1);
    expect(f.events).not.toContain('release');
    f.respond(); await stop; await first;
    expect(f.events.filter(e => e === 'terminate')).toHaveLength(1);
    expect(f.events).not.toContain('release');
  });

  test('repeat cancelAndDiscard shares one promise and one CancelRequest', async () => {
    const f = fixture(); const first = f.query().catch((e: any) => e); await f.ready;
    const a = f.reservation.cancelAndDiscard(); const b = f.reservation.cancelAndDiscard();
    expect(a).toBe(b); expect(f.events.filter(e => e === 'cancel:start')).toHaveLength(1);
    f.respond(); await a; await first;
    expect(f.events.filter(e => e === 'terminate')).toHaveLength(1);
  });

  test('cancel transport failure discards but does not certify cancellation', async () => {
    const f = fixture('fail'); const first = f.query().catch((e: any) => e); await f.ready;
    await expect(f.reservation.cancelAndDiscard()).rejects.toThrow('cancel transport failed');
    expect((await first).code).toBe('CONNECTION_DESTROYED');
    expect(f.events).not.toContain('backend:57014');
    expect(f.events.filter(e => e === 'terminate')).toHaveLength(1);
  });

  test('missing backend response triggers a bounded unconfirmed fallback', async () => {
    const f = fixture('hang'); const first = f.query().catch((e: any) => e); await f.ready;
    await expect(f.reservation.cancelAndDiscard({ timeout: 5 })).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    expect((await first).code).toBe('CONNECTION_DESTROYED');
    expect(f.events).not.toContain('backend:57014');
    // Simulate a delayed cancel response after force discard. No later query
    // can be admitted to the old reservation or receive that cancellation.
    f.respond(); await Promise.resolve();
    expect((await f.query().catch((e: any) => e)).code).toBe('CONNECTION_CLOSED');
    expect(f.events.filter(e => e === 'execute')).toHaveLength(1);
  });

  test('independent force discard rejects cancellation confirmation', async () => {
    const f = fixture(); const first = f.query().catch((e: any) => e); await f.ready;
    const stop = f.reservation.cancelAndDiscard(); f.reservation.discard(); f.respond();
    await expect(stop).rejects.toMatchObject({ code: 'CONNECTION_DESTROYED' });
    await first;
  });

  test('a synchronous canceller failure still retires the connection', async () => {
    const f = fixture(); const q = f.query(); const first = q.catch((e: any) => e); await f.ready;
    q.canceller = () => { throw new Error('synchronous cancel failure'); };
    await expect(f.reservation.cancelAndDiscard()).rejects.toThrow('synchronous cancel failure');
    expect((await first).code).toBe('CONNECTION_DESTROYED');
    expect(f.events.filter(e => e === 'terminate')).toHaveLength(1);
  });

  test('abort before handle attachment uses cancellation when attached and waits for it', async () => {
    const ac = new AbortController(); const attachReady = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>(); let called = 0, done = false;
    const run = withTransactionAbort(ac.signal, async attach => {
      await attachReady.promise;
      attach({ cancelAndDiscard: () => { called++; return cancelled.promise; }, discard: () => { throw new Error('wrong path'); } });
      throw new Error('driver stopped');
    }).catch((e: any) => e).finally(() => { done = true; });
    ac.abort(); attachReady.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(called).toBe(1); expect(done).toBe(false);
    cancelled.resolve(); expect((await run).name).toBe('AbortError');
  });

  test('helper retains cancellation failure without an unhandled rejection, keeping the driver error as cause', async () => {
    const ac = new AbortController(); const failed = new Error('unconfirmed'); const closed = new Error('closed');
    const result = withTransactionAbort(ac.signal, async attach => {
      attach({ cancelAndDiscard: () => Promise.reject(failed) }); ac.abort(); throw closed;
    }).catch((e: any) => e);
    const error = await result;
    expect(error.name).toBe('AbortError');
    expect(error.cancelFailure).toBe(failed);
    expect(error.cause).toBe(closed);
  });

  test('late abort after successful COMMIT preserves the committed result', async () => {
    const ac = new AbortController(); const f = fixture();
    const result = withTransactionAbort(ac.signal, async attach => {
      attach(f.handle);
      // COMMIT ReadyForQuery released the reservation before the caller's
      // continuation sees the abort. The driver's cancellation is now a no-op.
      f.reservation.releaseConnection(); ac.abort();
      return { committed: true, writeCount: 1 };
    });
    expect(await result).toEqual({ committed: true, writeCount: 1 });
    expect(f.events).not.toContain('terminate');
    expect(f.events).not.toContain('cancel:start');
  });

  test('busy unfenced query must not certify server cancellation', async () => {
    const f = fixture(); const q = f.query(); q.options.cancelFence = false;
    const result = q.catch((e: any) => e); await f.ready;
    await expect(f.reservation.cancelAndDiscard()).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    expect((await result).code).toBe('CONNECTION_DESTROYED');
    expect(f.events).not.toContain('backend:57014');
    expect((await f.query().catch((e: any) => e)).code).toBe('CONNECTION_CLOSED');
  });

  test('idle discard does not send a cancel or affect a successor reservation', async () => {
    const f = fixture(); await f.reservation.cancelAndDiscard();
    expect(f.events).toEqual(['terminate']);
    const successor = { marker: 'successor' }; f.c.reserved = successor;
    await f.reservation.cancelAndDiscard(); f.reservation.discard();
    expect(f.c.reserved).toBe(successor);
    expect(f.events).toEqual(['terminate']);
  });
});
