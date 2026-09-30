// Guard self-test fixture (known-GOOD): a driver-handle double cast is not a brand forgery.
import type { SqlExecutor } from "./executor.ts";

type PgConn = { unsafe(sql: string): Promise<unknown> };

export function postgresExecutor(conn: PgConn): SqlExecutor {
  void conn;
  return { dialect: "postgres" };
}

export function inTransaction(tx: object): SqlExecutor {
  return postgresExecutor(tx as unknown as PgConn);
}
