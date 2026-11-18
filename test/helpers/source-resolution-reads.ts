/**
 * Gives a SQL-answering fake engine the typed source-resolution reads (`listLocalPathSources`, `listSourceRoutingRows`,
 * `countDefaultSourceSplit`). Each runs the shared statement from engine-sql/sources.ts against the fake's own
 * `executeRaw`, as both real engines run it against their executor, so a fake keyed on the SQL text still answers and
 * the shared row coercion is exercised. `executeRaw` is looked up on every call, so a spy installed later still sees it.
 */
import * as sourcesSql from '../../src/core/engine-sql/sources.ts';

export function withSourceResolutionReads<T extends object>(fake: T): T {
  const exec = {
    executeRaw: (sql: string, params?: unknown[]) =>
      (fake as unknown as { executeRaw(sql: string, params?: unknown[]): Promise<unknown[]> }).executeRaw(sql, params),
  } as unknown as Parameters<typeof sourcesSql.listLocalPathSources>[0];
  return Object.assign(fake, {
    listLocalPathSources: () => sourcesSql.listLocalPathSources(exec),
    listSourceRoutingRows: () => sourcesSql.listSourceRoutingRows(exec),
    countDefaultSourceSplit: () => sourcesSql.countDefaultSourceSplit(exec),
  });
}
