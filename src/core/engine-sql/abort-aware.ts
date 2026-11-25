/**
 * An executor that refuses every statement once the request's signal has fired (GBRA-156). `executeRaw` did this at
 * each statement; a typed member that runs two statements (a count then a sample, an upsert then its row lookup) would
 * otherwise send the second one for a request nobody waits for. The check runs before the statement, so a statement
 * already sent is not cut short here: a read deadline or the driver's own cancel ends that one.
 */
import { throwIfRequestAborted } from '../request-signal.ts';
import type { SqlExecutor } from './executor.ts';

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
