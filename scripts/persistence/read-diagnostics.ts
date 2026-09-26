import { AsyncLocalStorage } from 'node:async_hooks';

export type ReadPhase = 'setup' | 'seed' | 'warmup' | 'idle' | 'loaded' | 'drain' | 'shutdown';
export type FailureStage = 'connect' | 'schema' | 'activate' | 'seed' | 'warmup' | 'idle_read' | 'loaded_read' |
  'keyword' | 'titles' | 'writer' | 'metrics_query' | 'metrics_rss' | 'drain' | 'validate' | 'shutdown';
type Outcome = 'pending' | 'fulfilled' | 'rejected';

export class BoundedRecords<T> {
  readonly records: T[] = [];
  total = 0;
  dropped = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid diagnostic limit');
  }
  add(record: T): void {
    this.total++;
    if (this.records.length < this.limit) this.records.push(record);
    else this.dropped++;
  }
}

export function safeDiagnosticError(error: unknown) {
  const names = ['Error', 'SystemError', 'TypeError', 'RangeError', 'AssertionError', 'PostgresError', 'AbortError'];
  const codes = ['ENOMEM', 'EIO', 'EAGAIN', 'EINVAL', 'ENOSYS', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
    'ERR_ASSERTION', 'ERR_SYSTEM_ERROR', '53300', '57014', '40P01', '40001', 'write_pending'];
  const syscalls = ['memoryUsage', 'getrusage', 'uv_resident_set_memory', 'read', 'connect'];
  const field = (key: string): unknown => {
    try { return error !== null && typeof error === 'object' ? Reflect.get(error, key) : undefined; }
    catch { return undefined; }
  };
  const name = field('name'); const code = field('code'); const errno = field('errno'); const syscall = field('syscall');
  return {
    name: typeof name === 'string' && names.includes(name) ? name : 'unknown',
    ...(typeof code === 'string' && codes.includes(code) ? { code } : {}),
    ...(typeof errno === 'number' && Number.isSafeInteger(errno) ? { errno } : {}),
    ...(typeof syscall === 'string' && syscalls.includes(syscall) ? { syscall } : {}),
    stack_present: typeof field('stack') === 'string',
  };
}

type ReadRecord = { phase: ReadPhase; query_index: number; corpus_index: number; start_ms: number;
  end_ms: number | null; duration_ms: number | null; outcome: Outcome };
type TransactionRecord = { phase: ReadPhase; query_index: number | null; dispatch_ms: number;
  callback_ms: number | null; end_ms: number | null; dispatch_to_callback_ms: number | null; outcome: Outcome };
type WriteRecord = { write_index: number; phase: ReadPhase; event: 'start' | 'admitted' | 'committed'; at_ms: number };
type LoopRecord = { phase: ReadPhase; start_ms: number; end_ms: number; delay_ms: number };

export class ReadDiagnostics {
  phase: ReadPhase = 'setup';
  readonly reads = new BoundedRecords<ReadRecord>(1024);
  readonly writes = new BoundedRecords<WriteRecord>(4096);
  readonly failures = new BoundedRecords<{ stage: FailureStage; phase: ReadPhase; at_ms: number;
    error: ReturnType<typeof safeDiagnosticError> }>(32);
  readonly transactions: Record<ReadPhase, BoundedRecords<TransactionRecord>>;
  readonly event_loop: Record<ReadPhase, BoundedRecords<LoopRecord>>;
  readonly context = new AsyncLocalStorage<{ phase: ReadPhase; query_index: number }>();
  readonly clock_basis = 'performance.now() milliseconds since workload start; shared with pool sample at_ms';
  readonly transaction_basis = 'root postgres.js begin dispatch through callback entry and promise settlement; includes BEGIN and client scheduling, not pure checkout wait; nested savepoints excluded';
  readonly event_loop_basis = '20ms timer lateness; same observer in all phases; no server sampling or SQL added';
  readonly overhead = 'query context setup precedes query timer and read retention follows it; transaction callbacks, promise observers and timer callbacks add unquantified in-query overhead';
  readonly transaction_support: 'postgres_root_begin' | 'unavailable_pglite';
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(readonly origin: number, kind: 'postgres' | 'pglite') {
    this.transaction_support = kind === 'postgres' ? 'postgres_root_begin' : 'unavailable_pglite';
    const phases: ReadPhase[] = ['setup', 'seed', 'warmup', 'idle', 'loaded', 'drain', 'shutdown'];
    this.transactions = Object.fromEntries(phases.map(phase => [phase, new BoundedRecords<TransactionRecord>(4096)])) as typeof this.transactions;
    this.event_loop = Object.fromEntries(phases.map(phase => [phase, new BoundedRecords<LoopRecord>(2048)])) as typeof this.event_loop;
  }
  setPhase(phase: ReadPhase): void {
    this.stop(); this.phase = phase;
    let previous = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.event_loop[phase].add({ phase, start_ms: previous - this.origin, end_ms: now - this.origin,
        delay_ms: Math.max(0, now - previous - 20) });
      previous = now;
    }, 20);
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
  failure(stage: FailureStage, error: unknown): void {
    this.failures.add({ stage, phase: this.phase, at_ms: performance.now() - this.origin, error: safeDiagnosticError(error) });
  }
  write(event: WriteRecord['event'], writeIndex: number, at: number): void {
    this.writes.add({ event, write_index: writeIndex, phase: this.phase, at_ms: at - this.origin });
  }
  async read<T>(index: number, corpusIndex: number, run: () => Promise<T>): Promise<{ value: T; duration: number }> {
    const record: ReadRecord = { phase: this.phase, query_index: index, corpus_index: corpusIndex,
      start_ms: 0, end_ms: null, duration_ms: null, outcome: 'pending' };
    this.reads.add(record);
    return this.context.run({ phase: record.phase, query_index: index }, async () => {
      const started = performance.now(); record.start_ms = started - this.origin;
      try {
        const value = await run(); const ended = performance.now();
        record.end_ms = ended - this.origin; record.duration_ms = ended - started; record.outcome = 'fulfilled';
        return { value, duration: ended - started };
      } catch (error) {
        const ended = performance.now();
        record.end_ms = ended - this.origin; record.duration_ms = ended - started; record.outcome = 'rejected';
        throw error;
      }
    });
  }
  observeRootBegin<T extends { begin: (...args: any[]) => any }>(root: T): () => void {
    const original = root.begin; const diagnostics = this;
    function begin(this: unknown, ...args: any[]) {
      const callbackIndex = typeof args[0] === 'function' ? 0 : 1;
      const callback = args[callbackIndex];
      const context = diagnostics.context.getStore();
      const record: TransactionRecord = { phase: context?.phase ?? diagnostics.phase, query_index: context?.query_index ?? null,
        dispatch_ms: performance.now() - diagnostics.origin, callback_ms: null, end_ms: null,
        dispatch_to_callback_ms: null, outcome: 'pending' };
      diagnostics.transactions[record.phase].add(record);
      if (typeof callback === 'function') args[callbackIndex] = function(this: unknown, ...values: unknown[]) {
        record.callback_ms = performance.now() - diagnostics.origin;
        record.dispatch_to_callback_ms = record.callback_ms - record.dispatch_ms;
        return Reflect.apply(callback, this, values);
      };
      const complete = (outcome: Outcome) => { record.end_ms = performance.now() - diagnostics.origin; record.outcome = outcome; };
      try {
        const returned = Reflect.apply(original, this, args);
        if (returned instanceof Promise) returned.then(() => complete('fulfilled'), () => complete('rejected'));
        else complete('fulfilled');
        return returned;
      } catch (error) { complete('rejected'); throw error; }
    }
    root.begin = begin as T['begin'];
    return () => { root.begin = original; };
  }
  toJSON() {
    return { clock_basis: this.clock_basis, transaction_basis: this.transaction_basis, transaction_support: this.transaction_support,
      event_loop_basis: this.event_loop_basis, overhead: this.overhead, reads: this.reads, writes: this.writes,
      failures: this.failures, transactions: this.transactions, event_loop: this.event_loop };
  }
}
