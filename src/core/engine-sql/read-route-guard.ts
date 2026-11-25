/**
 * Postgres read routes refuse a statement that changes data.
 *
 * `PostgresEngine`'s typed reads run through a few routes: `preparationRead`, `engineSqlRead` and `ownRawRead`, and the
 * abort-aware read getters (`writeMiscReads`, `cliReads`). Under a read deadline (a preparer's claim clock, a doctor
 * deadline) those routes open `BEGIN READ ONLY` on a reserved connection, so a write sent through one fails there and
 * only there: with no deadline it runs on the ordinary pool and succeeds. A write member routed through a read route
 * would therefore pass every test that sets no deadline and fail in production under one. This executor refuses the
 * write on every call, before it is sent, so the mistake fails the first time it runs.
 *
 * A statement is a read when its first keyword (after whitespace, comments and opening parentheses) is SELECT, WITH,
 * VALUES, TABLE, SHOW or EXPLAIN, a WITH has no data-modifying member (`AS (INSERT|UPDATE|DELETE|MERGE`), and an EXPLAIN
 * is not EXPLAIN ANALYZE. Locking reads (`SELECT ... FOR SHARE`) are reads: the routes run them outside the read-only
 * transaction (`unbounded`). Functions a SELECT calls are not inspected (`set_config` sets a read's own settings).
 */
import type { SqlExecutor } from './executor.ts';
import { renderFragment, type SqlFragment } from './fragment.ts';
import type { BrainEngine } from '../engine.ts';

const LEADING_KEYWORD = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()*([A-Za-z]+)/;
const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN']);
const MODIFYING_MEMBER = /\bAS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(\s*(?:INSERT|UPDATE|DELETE|MERGE)\b/i;

/** Whether `sql` changes data (or schema) rather than reading it; see the module comment for the rule. */
export function isWriteStatement(sql: string): boolean {
  const first = LEADING_KEYWORD.exec(sql)?.[1]?.toUpperCase();
  if (!first || !READ_KEYWORDS.has(first)) return true;
  if (first === 'EXPLAIN') return /^\s*EXPLAIN\s*(?:\([^)]*\bANALYZE\b|ANALYZE\b)/i.test(sql);
  return first === 'WITH' && MODIFYING_MEMBER.test(sql);
}

/** The error a read route raises for a write: a programming error at the member that routed it, named by its statement. */
export class ReadRouteWriteError extends Error {
  readonly code = 'read_route_write';
  constructor(sql: string) {
    super(`A Postgres read route refused a statement that changes data (${sql.replace(/\s+/g, ' ').trim().slice(0, 80)}): `
      + 'a write member must run on the engine\'s write executor, not a read route, which runs READ ONLY under a read deadline.');
    this.name = 'ReadRouteWriteError';
  }
}

function refuse(sql: string): void {
  if (isWriteStatement(sql)) throw new ReadRouteWriteError(sql);
}

/** `exec` for a read route: every statement it sends, inside a transaction it opens too, must be a read. */
export function refuseWrites<T extends SqlExecutor>(exec: T): T {
  return {
    ...exec,
    query: async (...args: Parameters<SqlExecutor['query']>) => { refuse(args[0]); return exec.query(...args); },
    run: async (...args: Parameters<SqlExecutor['run']>) => { refuse(renderFragment(args[0] as SqlFragment).text); return exec.run(...args); },
    executeRaw: async (...args: Parameters<SqlExecutor['executeRaw']>) => { refuse(args[0]); return exec.executeRaw(...args); },
    unsafe: async (...args: Parameters<SqlExecutor['unsafe']>) => { refuse(args[0]); return exec.unsafe(...args); },
    transaction: async (fn: Parameters<SqlExecutor['transaction']>[0]) => exec.transaction(tx => fn(refuseWrites(tx))),
  } as T;
}

/** `refuseWrites` for a route that hands a read the engine's own `executeRaw` (so a fault a test injects there still reaches it). */
export function refuseRawWrites(engine: Pick<BrainEngine, 'executeRaw'>): Pick<BrainEngine, 'executeRaw'> {
  return { executeRaw: async (...args: Parameters<BrainEngine['executeRaw']>) => { refuse(args[0]); return engine.executeRaw(...args); } } as Pick<BrainEngine, 'executeRaw'>;
}
