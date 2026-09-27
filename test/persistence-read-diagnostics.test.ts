import { describe, expect, test } from 'bun:test';
import { BoundedRecords, ReadDiagnostics, safeDiagnosticError } from '../scripts/persistence/read-diagnostics.ts';
import { WriteTimingRecorder } from '../scripts/persistence/read-admission.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

describe('bounded read diagnostics', () => {
  test('counts truncation without replacing retained records', () => {
    const bounded = new BoundedRecords<number>(2);
    for (let i = 0; i < 5; i++) bounded.add(i);
    expect({ ...bounded }).toEqual({ limit: 2, records: [0, 1], total: 5, dropped: 3 });
    expect(() => new BoundedRecords(-1)).toThrow('Invalid diagnostic limit');
  });

  test('retains exact query duration, phase at dispatch, and failed partial reads', async () => {
    const diagnostics = new ReadDiagnostics(performance.now(), 'pglite');
    diagnostics.setPhase('idle');
    try {
      const result = await diagnostics.read(7, 2, async () => {
        expect(diagnostics.context.getStore()).toEqual({ phase: 'idle', query_index: 7 });
        diagnostics.setPhase('loaded');
        return 42;
      });
      expect(result.value).toBe(42);
      const read = diagnostics.reads.records[0];
      expect(read.phase).toBe('idle');
      expect(read.query_index).toBe(7);
      expect(read.corpus_index).toBe(2);
      expect(read.duration_ms).toBe(result.duration);
      expect(read.end_ms! - read.start_ms).toBeCloseTo(result.duration, 8);
      const failure = new Error('unsafe content');
      await expect(diagnostics.read(8, 3, async () => { throw failure; })).rejects.toBe(failure);
      expect(diagnostics.reads.records[1].outcome).toBe('rejected');
      expect(diagnostics.reads.records[1].phase).toBe('loaded');
      expect(diagnostics.reads.records[1].end_ms).not.toBeNull();
      expect(JSON.stringify(diagnostics)).not.toContain('unsafe content');
      expect(diagnostics.context.getStore()).toBeUndefined();
      expect(diagnostics.transaction_support).toBe('unavailable_pglite');
    } finally { diagnostics.stop(); }
  });

  test('root dispatch preserves receiver, arguments, callback result and original promise', async () => {
    const diagnostics = new ReadDiagnostics(performance.now(), 'postgres');
    const handle = { secret: 'unsafe SID' }; const receiver = { receiver: true };
    let promise: Promise<unknown>;
    const root = { begin(this: unknown, option: unknown, callback: (...args: any[]) => any) {
      expect(this).toBe(receiver); expect(option).toBe('unsafe transaction options');
      promise = Promise.resolve().then(() => callback.call(receiver, handle, 19));
      return promise;
    } };
    const original = root.begin; const restore = diagnostics.observeRootBegin(root);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const returned = diagnostics.context.run({ phase: 'setup', query_index: 3 }, () => root.begin.call(receiver, 'unsafe transaction options', function(this: unknown, ...args: unknown[]) {
      expect(this).toBe(receiver); expect(args).toEqual([handle, 19]);
      return pending.then(() => handle);
    }));
    expect(returned).toBe(promise!);
    expect(diagnostics.transactions.setup.records[0].callback_ms).toBeNull();
    await Promise.resolve();
    expect(diagnostics.transactions.setup.records[0].outcome).toBe('pending');
    release(); expect(await returned).toBe(handle);
    const record = diagnostics.transactions.setup.records[0];
    expect(record.query_index).toBe(3);
    expect(record.callback_ms!).toBeGreaterThanOrEqual(record.dispatch_ms);
    expect(record.end_ms!).toBeGreaterThanOrEqual(record.callback_ms!);
    expect(record.dispatch_to_callback_ms).toBe(record.callback_ms! - record.dispatch_ms);
    expect(record.outcome).toBe('fulfilled');
    expect(JSON.stringify(diagnostics)).not.toContain('unsafe');
    restore(); expect(root.begin).toBe(original);
  });

  test('preserves synchronous throws and pre/post callback rejection identity', async () => {
    for (const mode of ['sync', 'before', 'callback'] as const) {
      const diagnostics = new ReadDiagnostics(performance.now(), 'postgres');
      const error = new Error('unsafe error');
      const root = { begin(fn: () => unknown) {
        if (mode === 'sync') throw error;
        if (mode === 'before') return Promise.reject(error);
        return Promise.resolve().then(fn);
      } };
      diagnostics.observeRootBegin(root);
      if (mode === 'sync') expect(() => root.begin(() => {})).toThrow(error);
      else await expect(root.begin(() => { throw error; })).rejects.toBe(error);
      const record = diagnostics.transactions.setup.records[0];
      expect(record.outcome).toBe('rejected');
      expect(record.end_ms).not.toBeNull();
      expect(record.callback_ms === null).toBe(mode !== 'callback');
    }
  });

  test('bounds each phase independently and attributes background transactions to no query', async () => {
    const diagnostics = new ReadDiagnostics(performance.now(), 'postgres');
    const root = { begin(fn: () => unknown) { return Promise.resolve(fn()); } };
    diagnostics.observeRootBegin(root);
    for (let i = 0; i < 4100; i++) await root.begin(() => 1);
    expect(diagnostics.transactions.setup.total).toBe(4100);
    expect(diagnostics.transactions.setup.dropped).toBe(4);
    diagnostics.setPhase('idle');
    try {
      await diagnostics.read(4, 4, async () => {
        diagnostics.setPhase('loaded');
        await root.begin(() => 2);
      });
      diagnostics.setPhase('idle');
      await root.begin(() => 3);
      expect(diagnostics.transactions.idle.records.map(r => r.query_index)).toEqual([4, null]);
      expect(diagnostics.transactions.idle.dropped).toBe(0);
      await Bun.sleep(45);
      expect(diagnostics.event_loop.idle.total).toBeGreaterThan(0);
      expect(diagnostics.event_loop.idle.records.every(r => r.phase === 'idle' && r.end_ms >= r.start_ms && r.delay_ms >= 0)).toBe(true);
    } finally { diagnostics.stop(); }
  });

  test('write observations keep numeric identity across warmup reset without exposing request IDs', () => {
    const diagnostics = new ReadDiagnostics(100, 'pglite');
    const recorder = new WriteTimingRecorder((event, index, at) => diagnostics.write(event, index, at));
    recorder.start('unsafe request UUID', 110); recorder.admitted('unsafe request UUID', 120); recorder.complete('unsafe request UUID', 130);
    recorder.reset(); recorder.start('unsafe second UUID', 150); recorder.admitted('unsafe second UUID', 160);
    expect(diagnostics.writes.records.map(r => [r.write_index, r.event, r.at_ms])).toEqual([
      [0, 'start', 10], [0, 'admitted', 20], [0, 'committed', 30], [1, 'start', 50], [1, 'admitted', 60],
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('unsafe');
  });

  test('errors retain only allowlisted structure, never messages, paths, SQL or arbitrary properties', () => {
    const unsafe = 'SELECT secret FROM private WHERE sid=secret postgres://secret /private/path';
    expect(safeDiagnosticError({ name: 'SystemError', code: 'ENOMEM', errno: -12, syscall: 'memoryUsage',
      message: unsafe, stack: unsafe, detail: unsafe, parameters: [unsafe] })).toEqual({
      name: 'SystemError', code: 'ENOMEM', errno: -12, syscall: 'memoryUsage', stack_present: true,
    });
    expect(safeDiagnosticError({ name: unsafe, code: unsafe, errno: unsafe, syscall: unsafe })).toEqual({ name: 'unknown', stack_present: false });
    const diagnostics = new ReadDiagnostics(performance.now(), 'pglite');
    for (let i = 0; i < 35; i++) diagnostics.failure('metrics_rss', new Error(unsafe));
    expect(diagnostics.failures.total).toBe(35); expect(diagnostics.failures.dropped).toBe(3);
    expect(JSON.stringify(diagnostics)).not.toContain(unsafe);
    expect(safeDiagnosticError(new Proxy({}, { get() { throw new Error(unsafe); } }))).toEqual({ name: 'unknown', stack_present: false });
  });

  test.skipIf(!process.env.DATABASE_URL)('actual PostgreSQL lexical reads enter the observed root; nested savepoints do not', async () => {
    const { engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const diagnostics = new ReadDiagnostics(performance.now(), 'postgres');
    const restore = diagnostics.observeRootBegin(engine.sql);
    diagnostics.setPhase('idle');
    try {
      await diagnostics.read(0, 0, async () => {
        await Promise.all([engine.searchKeyword('fixture'), engine.searchTitles('fixture')]);
      });
      expect(diagnostics.transactions.idle.total).toBe(2);
      expect(diagnostics.transactions.idle.records.every(r => r.query_index === 0 && r.outcome === 'fulfilled' && r.callback_ms !== null)).toBe(true);
      await engine.transaction(async tx => {
        await tx.transaction(async nested => { await nested.executeRaw('SELECT 1'); });
        const rejected = new Error('nested rollback');
        await expect(tx.transaction(async () => { throw rejected; })).rejects.toBe(rejected);
        expect((await tx.executeRaw<{ n: number }>('SELECT 2::integer AS n'))[0].n).toBe(2);
      });
      expect(diagnostics.transactions.idle.total).toBe(3);
      expect(diagnostics.transactions.idle.records[2].query_index).toBeNull();
      const rejected = new Error('root rollback');
      await expect(engine.transaction(async () => { throw rejected; })).rejects.toBe(rejected);
      expect(diagnostics.transactions.idle.records[3].outcome).toBe('rejected');
    } finally { restore(); diagnostics.stop(); await close(); }
  }, 120_000);
});
