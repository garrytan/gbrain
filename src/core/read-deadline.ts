/**
 * #6318: the deadline of the preparation a read runs for. A managed-sync preparation's raw reads take its remaining budget
 * as `executeRaw`'s `timeoutMs` (persistence/bounded-reads.ts `boundedReads`), but the engine's own reads
 * (`readPageSnapshot`, `readPageSnapshotsBatch`, `findDuplicatePage`, the import pipeline's lookups) issue their
 * statements on the engine's connection directly. Under a relation lock held elsewhere those statements waited for as long
 * as the lock lasted, through a pooler that drops the session's `statement_timeout`. Work run inside
 * `withReadDeadline(deadlineAt, fn)` carries the deadline, and the Postgres engine's scoped reads issued from it run on a
 * reserved connection in a read-only transaction whose `statement_timeout` is the time left
 * (postgres-engine/bounded-statement.ts `runDeadlineRead`, pipelined), so the server ends them at the deadline. A
 * transaction's own statements and PGLite are unaffected.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<number | undefined>();

/** #8651: a read refused because its deadline passed before it had a connection; nothing was sent. */
export class ReadDeadlineError extends Error {
  readonly code = 'read_deadline';
  constructor() {
    super('The read was not sent: its deadline passed while it waited for a database connection.');
    this.name = 'ReadDeadlineError';
  }
}

export function withReadDeadline<T>(deadlineAt: number, fn: () => T): T {
  return store.run(deadlineAt, fn);
}

/** The epoch-millisecond deadline of the work this read runs for, or undefined. */
export function readDeadline(): number | undefined {
  return store.getStore();
}
