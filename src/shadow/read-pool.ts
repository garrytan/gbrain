/**
 * Where the shadow follower and reconcile read the primary (shadow follow). Each read is its own short, read-only,
 * REPEATABLE READ transaction, so nothing here holds a snapshot open across a slow call into the Rust store.
 *
 * On Postgres the reads use a dedicated one-connection engine of their own, opened on first use: a reconcile pass
 * reading a large relation never takes a connection from the serving pool, and a statement timeout bounds each read.
 * PGLite has a single connection, so its reads share the primary and queue behind its other work.
 */
import type { BrainEngine } from '../core/engine.ts';
import { hasCapability } from '../core/engine-capabilities.ts';
import { DIGEST_SESSION_SETTINGS, digestQuery } from '../core/persistence/graduation-digest.ts';

export type ReadQuery = ReturnType<typeof digestQuery>;

export interface ReadSource {
  /** How long a caller walking many reads in a row waits between them, so a pass does not hog the connection. */
  readonly pauseMs: number;
  read<T>(fn: (tx: BrainEngine, query: ReadQuery) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const READ_TIMEOUT_MS = 30_000;
export function openReadSource(primary: BrainEngine, opts: { pauseMs?: number } = {}): ReadSource {
  const postgres = hasCapability(primary, 'postgres_admin'); // a server database: a second connection is cheap, PGLite has one
  let dedicated: Promise<BrainEngine> | null = null;
  let closed = false;
  const engine = (): Promise<BrainEngine> => {
    if (closed) return Promise.reject(new Error('shadow read source is closed'));
    if (!postgres) return Promise.resolve(primary);
    dedicated ??= (async () => {
      const { PostgresEngine } = await import('../core/postgres-engine.ts');
      const own = new PostgresEngine();
      await own.connect({ engine: 'postgres', database_url: (primary as { connectedDatabaseUrl?: string }).connectedDatabaseUrl, poolSize: 1 })
        .catch(async (error) => { await own.disconnect().catch(() => undefined); throw error; }); // a half-opened pool must not outlive the attempt
      return own;
    })();
    dedicated.catch(() => { dedicated = null; });
    return dedicated;
  };
  return {
    pauseMs: opts.pauseMs ?? (postgres ? 50 : 5),
    async read(fn) {
      return (await engine()).transaction(async (tx) => {
        const query = digestQuery(tx);
        await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await query(DIGEST_SESSION_SETTINGS);
        if (postgres) await query(`SET LOCAL statement_timeout = ${READ_TIMEOUT_MS}`);
        return fn(tx, query);
      }, { readOnly: true });
    },
    async close() {
      closed = true;
      const own = dedicated;
      dedicated = null;
      await (await own?.catch(() => null))?.disconnect().catch(() => undefined);
    },
  };
}
