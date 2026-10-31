/**
 * #6318: the deadline of the preparation a read runs for. A managed-sync preparation's raw reads take its remaining budget
 * as `executeRaw`'s `timeoutMs` (persistence/bounded-reads.ts `boundedReads`), but the engine's own reads
 * (`readPageSnapshot`, `readPageSnapshotsBatch`, `findDuplicatePage`, the import pipeline's lookups) issue their
 * statements on the engine's connection directly. Under a relation lock held elsewhere those statements waited for as long
 * as the lock lasted, through a pooler that drops the session's `statement_timeout`. Work run inside
 * `withReadDeadline(deadlineAt, fn)` carries the deadline, and the Postgres engine's scoped reads issued from it run in a
 * read-only transaction whose `statement_timeout` is the time left (one settings statement, pipelined behind BEGIN), so
 * the server ends them at the deadline. A transaction's own statements and PGLite are unaffected.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<number | undefined>();

export function withReadDeadline<T>(deadlineAt: number, fn: () => T): T {
  return store.run(deadlineAt, fn);
}

/** The epoch-millisecond deadline of the work this read runs for, or undefined. */
export function readDeadline(): number | undefined {
  return store.getStore();
}
