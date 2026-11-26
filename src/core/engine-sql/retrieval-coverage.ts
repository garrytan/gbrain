
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { QueryOpts, Row, SqlExecutor } from './executor.ts';
import { renderFragment, type SqlFragment } from './fragment.ts';

/** The raw path of `SqlExecutor`, plus the engine's `jitOff` option (`EngineRawRead`): the engines hand the two JIT-off counts their own `executeRaw`. */
type Exec = { executeRaw<R = Row>(sql: string, params?: unknown[], opts?: QueryOpts & { jitOff?: boolean }): Promise<R[]> };

/** Render `fragment` and run it on the unscoped raw path, as master did. `jitOff` runs it with JIT off on Postgres (PGLite ignores it). */
async function rows<R>(exec: Exec, fragment: SqlFragment, jitOff = false): Promise<R[]> {
  const { text, params } = renderFragment(fragment);
  return exec.executeRaw<R>(text, params, jitOff ? { jitOff: true } : undefined);
}
