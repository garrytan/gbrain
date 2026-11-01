import { describe, expect, test } from 'bun:test';
import { runBoundedStatement } from '../src/core/postgres-engine/bounded-statement.ts';

function fixture(stall: 'open' | 'read' | 'close' | null, abortOnReserve = false) {
  const controller = new AbortController();
  const reason = new Error('caller deadline');
  const log: string[] = [];
  const outstanding: Array<(error: unknown) => void> = [];
  let ready!: () => void;
  const issued = new Promise<void>(resolve => { ready = resolve; });
  const reserved = {
    unsafe(sql: string) {
      const phase = sql.startsWith('BEGIN') ? 'open' : sql === 'COMMIT' ? 'close' : 'read';
      log.push(sql);
      const result = phase === stall ? new Promise<unknown[]>((_, reject) => { outstanding.push(reject); }) : Promise.resolve([{ ok: 1 }]);
      return Object.assign(result, {
        simple() { return this; },
        execute() { if (phase === 'close') ready(); return this; },
        // Simulates a pooler which never confirms a CancelRequest.
        cancel() { log.push(`cancel:${phase}`); return new Promise<void>(() => {}); },
      });
    },
    release() { log.push('release'); },
    discard() {
      log.push('discard');
      for (const reject of outstanding) reject(Object.assign(new Error('destroyed'), { code: 'CONNECTION_DESTROYED' }));
    },
  };
  const pool = { async reserve() {
    if (abortOnReserve) controller.abort(reason);
    return reserved;
  } };
  const run = (extra = {}) => runBoundedStatement(pool as never, 'SELECT 1', [], {
    timeoutMs: 60_000, signal: controller.signal, ...extra,
  }, () => { log.push('reserved'); });
  return { controller, reason, log, issued, run, reserved };
}

async function boundedOutcome(pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(value => ({ value, error: null }), error => ({ value: null, error })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('bounded call did not retire')), 500); }),
    ]);
  } finally { clearTimeout(timer); }
}

describe('bounded Postgres envelopes retire aborted reservations (#8155)', () => {
  for (const phase of ['open', 'read', 'close'] as const) {
    test(`abort while ${phase} is stalled discards the owner even if cancellation never settles`, async () => {
      const f = fixture(phase);
      const pending = f.run({ jitOff: true });
      await f.issued;
      f.controller.abort(f.reason);
      let outcome;
      try { outcome = await boundedOutcome(pending); }
      finally { if (!f.log.includes('discard')) f.reserved.discard(); }
      expect(outcome.error).toBe(f.reason);
      expect(f.log.filter(x => x === 'discard')).toHaveLength(1);
      expect(f.log).not.toContain('release');
      expect(f.log.some(x => x.startsWith('cancel:'))).toBe(true);
    });
  }

  test('abort between reservation and execution sends no SQL and releases the unused owner', async () => {
    const f = fixture(null, true);
    const outcome = await boundedOutcome(f.run());
    expect(outcome.error).not.toBeNull();
    expect(f.log).not.toContain('SELECT 1');
    expect(f.log).not.toContain('discard');
    expect(f.log).toContain('release');
  });

  test('normal completion keeps the pipelined envelope and removes the abort listener', async () => {
    const f = fixture(null);
    expect(await f.run({ prepare: false })).toEqual([{ ok: 1 }]);
    expect(f.log).toEqual(['reserved', 'BEGIN READ WRITE; SET LOCAL statement_timeout = 60000', 'SELECT 1', 'COMMIT', 'release']);
    f.controller.abort(f.reason);
    expect(f.log.at(-1)).toBe('release');
    expect(f.log).not.toContain('discard');
  });

  test('an already-aborted signal never reserves a connection', async () => {
    const f = fixture(null);
    f.controller.abort(f.reason);
    expect((await boundedOutcome(f.run())).error).not.toBeNull();
    expect(f.log).toEqual([]);
  });

  test('a broken driver need not settle its queries for the caller to abort', async () => {
    const f = fixture('read');
    f.reserved.discard = () => { f.log.push('discard'); };
    const unsafe = f.reserved.unsafe;
    f.reserved.unsafe = sql => {
      const query = unsafe(sql);
      query.cancel = () => { throw new Error('cancel transport failed'); };
      return query;
    };
    const pending = f.run();
    await f.issued;
    f.controller.abort(f.reason);
    expect((await boundedOutcome(pending)).error).toBe(f.reason);
    expect(f.log.filter(x => x === 'discard')).toHaveLength(1);
    expect(f.log).not.toContain('release');
  });

  test('abort in the checkout callback is rechecked before any SQL', async () => {
    const f = fixture(null);
    const pending = runBoundedStatement({ reserve: async () => f.reserved } as never, 'SELECT 1', [], {
      signal: f.controller.signal, timeoutMs: 1000,
    }, () => f.controller.abort(f.reason));
    expect((await boundedOutcome(pending)).error).toBe(f.reason);
    expect(f.log).toEqual(['release']);
  });

  test('a checkout callback failure still releases the unused reservation', async () => {
    const f = fixture(null);
    const pending = runBoundedStatement({ reserve: async () => f.reserved } as never, 'SELECT 1', [], {}, () => { throw f.reason; });
    expect((await boundedOutcome(pending)).error).toBe(f.reason);
    expect(f.log).toEqual(['release']);
  });

  test('cancellation-incapable drivers refuse before SQL instead of leaking a connection', async () => {
    const f = fixture(null);
    const { discard: _discard, ...oldDriver } = f.reserved;
    const pending = runBoundedStatement({ reserve: async () => oldDriver } as never, 'SELECT 1', [], {
      signal: f.controller.signal, timeoutMs: 1000,
    }, () => {});
    expect((await boundedOutcome(pending)).error).toMatchObject({ reasonCode: 'postgres_cancellation_unavailable' });
    expect(f.log).toEqual(['release']);
  });
});
