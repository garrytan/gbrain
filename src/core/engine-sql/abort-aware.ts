/**
 * An executor that refuses every statement once the request's signal has fired (GBRA-156). `executeRaw` did this at
 * each statement; a typed member that runs two statements (a count then a sample, an upsert then its row lookup) would
 * otherwise send the second one for a request nobody waits for. The check runs before the statement, so a statement
 * already sent is not cut short here: a read deadline or the driver's own cancel ends that one.
 *
 * A typed member that replaced an `executeRaw` call wraps its executor with this. The plain `engineSql` and `autocommitSql`
 * getters do not: the members that already ran on them before the move keep their cleanup writes working after a cancel
 * (`setBodyStagingState(id, 'aborted')` runs from a catch block; test/abort-cleanup-writes.test.ts).
 */
import { throwIfRequestAborted } from '../request-signal.ts';
import type { SqlExecutor } from './executor.ts';

// The read routes also refuse a write on every call (read-route-guard.ts); one import line for the engine.
export { refuseRawWrites, refuseWrites } from './read-route-guard.ts';

export function refuseAborted<T extends SqlExecutor>(exec: T): T {
  return {
    ...exec,
    query: async (...args: Parameters<SqlExecutor['query']>) => { throwIfRequestAborted(); return exec.query(...args); },
    run: async (...args: Parameters<SqlExecutor['run']>) => { throwIfRequestAborted(); return exec.run(...args); },
    executeRaw: async (...args: Parameters<SqlExecutor['executeRaw']>) => { throwIfRequestAborted(); return exec.executeRaw(...args); },
    unsafe: async (...args: Parameters<SqlExecutor['unsafe']>) => { throwIfRequestAborted(); return exec.unsafe(...args); },
    transaction: async (fn: Parameters<SqlExecutor['transaction']>[0]) => { throwIfRequestAborted(); return exec.transaction(tx => fn(refuseAborted(tx))); },
  } as T;
}
