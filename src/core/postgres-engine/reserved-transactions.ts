import type postgres from '#postgres';
import type { BrainEngine } from '../engine.ts';

/**
 * Phase 4.4: what `PostgresEngine.withReservedConnection` adds to its
 * `ReservedConnection`: one transaction at a time on the reserved backend,
 * with `transaction()`'s semantics. Its prepared statements stay on the
 * connection, so a caller that keeps the reservation reuses them. PGLite's
 * reserved connection has none.
 */
export interface ReservedTransactions { transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> }

/**
 * Phase 4.4: `begin` for one reserved postgres.js connection, as `sql.begin`
 * runs it on a pooled one: BEGIN, the callback with a handle whose
 * `savepoint` nests (rolled back to on error, like postgres.js), COMMIT, and
 * ROLLBACK on failure. BEGIN and SAVEPOINT are sent with the statements that
 * follow them instead of a round trip ahead (the server still runs them
 * first). A COMMIT the server answers with ROLLBACK (an earlier statement
 * failed unobserved) is an error, never a silent success.
 */
export function reservedTransactions(reserved: postgres.ReservedSql): ReturnType<typeof postgres> {
  const settle = async <T>(marker: Promise<unknown>, body: Promise<T>): Promise<T> => {
    const [opened, ran] = await Promise.allSettled([marker, body]);
    if (opened.status === 'rejected') throw opened.reason;
    if (ran.status === 'rejected') throw ran.reason;
    return ran.value;
  };
  const begin = async (fn: (handle: unknown) => Promise<unknown>) => {
    let savepoints = 0;
    const handle = Object.assign(reserved, {
      savepoint: async (inner: (child: unknown) => Promise<unknown>) => {
        const name = `s${savepoints++}`;
        const marker = reserved.unsafe(`savepoint ${name}`).execute();
        try { return await settle(marker, Promise.resolve().then(() => inner(handle))); }
        catch (error) { if (await marker.then(() => true, () => false)) await reserved.unsafe(`rollback to ${name}`); throw error; }
      },
    });
    const opened = reserved.unsafe('begin').execute();
    let result: unknown;
    try { result = await settle(opened, Promise.resolve().then(() => fn(handle))); }
    catch (error) { await reserved.unsafe('rollback').catch(() => reserved.discard()); throw error; }
    const done = await reserved.unsafe('commit') as unknown as { command?: string };
    if (done.command !== 'COMMIT') throw Object.assign(new Error('The transaction was rolled back at commit.'), { code: '25P02' });
    return result;
  };
  return { begin } as unknown as ReturnType<typeof postgres>;
}

