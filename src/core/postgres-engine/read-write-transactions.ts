/**
 * #7183: every transaction gbrain opens on Postgres declares itself read-write, and an autocommit statement the server
 * refuses as read-only runs once more inside such a transaction.
 *
 * A transaction-mode pooler (PgBouncer `pool_mode=transaction`, Supavisor) shares server connections between clients.
 * A client that runs a session-level `SET default_transaction_read_only = on` leaves that default on the server
 * connection, and a pooler that does not restore it hands it to every later client of that connection; a role or
 * database default does the same to every connection. gbrain's writes then fail with SQLSTATE 25006 (`cannot execute
 * INSERT in a read-only transaction`, `... SELECT FOR SHARE ...`). A transaction's own characteristics outrank the
 * session default, so:
 *
 * - `beginReadWrite` opens `BEGIN READ WRITE` (postgres.js `begin('read write', fn)`). A hot standby refuses read-write
 *   mode at BEGIN (0A000, before `fn` runs); the transaction then opens without it, as before, so reads keep working there.
 * - `READ_WRITE_BEGIN` is the statement for the raw envelopes on reserved connections.
 * - `retryReadOnlyAutocommit` runs an autocommit statement on a pool and, when the server refused it with 25006, runs it
 *   once more inside `beginReadWrite`. The first run changed nothing: an autocommit statement is its own implicit
 *   transaction, which the error rolled back. Nothing is spent until a statement is refused. A statement that cannot run
 *   in a transaction block (25001) reports the original refusal.
 *
 * A session-level `SET default_transaction_read_only = off` cannot fix this: through a transaction pooler it lands on
 * whichever server connection that statement gets, and is itself session state left for other clients.
 */
import type postgres from '#postgres';

type Sql = ReturnType<typeof postgres>;

/** SQLSTATE `read_only_sql_transaction`. */
export const READ_ONLY_SQLSTATE = '25006';
export const READ_WRITE_BEGIN = 'BEGIN READ WRITE';

const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;

export function isReadOnlyTransactionError(error: unknown): boolean {
  return codeOf(error) === READ_ONLY_SQLSTATE;
}

/** A pool opens transactions on its own connections; transaction and reserved handles have no `reserve`. */
function isPool(conn: unknown): conn is Sql {
  return typeof (conn as { reserve?: unknown }).reserve === 'function' && typeof (conn as { begin?: unknown }).begin === 'function';
}

function standbyRefusal(error: unknown): boolean {
  return codeOf(error) === '0A000' && /read-write mode during recovery/i.test(String((error as { message?: unknown }).message ?? ''));
}

/** `options.first` is the pipelined-first-statement test (GBRA-156), kept beside the read-write mode. */
export async function beginReadWrite<T>(pool: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>, options?: { first?: unknown }): Promise<T> {
  let entered = false;
  const run = (tx: postgres.TransactionSql) => { entered = true; return fn(tx); };
  try {
    return await (options ? pool.begin({ ...options, mode: 'read write' } as never, run) : pool.begin('read write', run)) as T;
  } catch (error) {
    if (entered || !standbyRefusal(error)) throw error;
    return await (options ? pool.begin(options as never, fn) : pool.begin(fn)) as T;
  }
}

/** A pool whose `begin` (with or without options) opens read-write transactions; a transaction or reserved handle is returned unchanged. */
export function readWriteTransactions(conn: Sql): Sql {
  if (!isPool(conn)) return conn;
  type Body = (tx: postgres.TransactionSql) => Promise<unknown>;
  return { begin: (options: Body | { first?: unknown }, fn?: Body) => typeof options === 'function' ? beginReadWrite(conn, options) : beginReadWrite(conn, fn!, options) } as unknown as Sql;
}

export async function retryReadOnlyAutocommit<T>(conn: Sql, run: (conn: Sql) => Promise<T>): Promise<T> {
  try {
    return await run(conn);
  } catch (error) {
    if (!isReadOnlyTransactionError(error) || !isPool(conn)) throw error;
    try {
      return await beginReadWrite(conn, tx => run(tx as unknown as Sql));
    } catch (retryError) {
      throw codeOf(retryError) === '25001' ? error : retryError;
    }
  }
}
