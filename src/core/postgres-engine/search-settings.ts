/**
 * Transaction-local settings for the Postgres search reads (#6039, #6721).
 *
 * JIT off. The search statements (keyword, keyword chunks, CJK, title,
 * vector candidates and the vector `hasMore` witness) are short interactive
 * reads, but their correlated visibility subplans inflate the planner's cost
 * estimate past `jit_above_cost` (100k by default) and, on the vector and
 * common-term statements, past the inlining and optimization thresholds
 * (500k). Postgres then compiles the statement with LLVM on every call, and
 * compilation, not execution, dominates its latency: on a 20k-page brain the
 * remote keyword statement spent 58 of 61 ms compiling and the remote vector
 * candidate statement 990 of 1,394 ms. JIT never pays back on a statement
 * that executes in milliseconds.
 *
 * One statement (#6721). Every setting a search transaction needs (`jit`,
 * the RLS `app.scopes`, `statement_timeout`, the relaxed arms'
 * `enable_seqscan`, the vector scan settings) is applied by a single
 * `SELECT set_config(...), set_config(...)`: each separate statement was a
 * round trip in series with the query, about 30 ms each to a remote pooler.
 * At the top level nothing is read first or restored after: `set_config(...,
 * true)` ends with the transaction, and the read is sent behind the settings
 * statement without waiting for its answer (one round trip for both: the
 * transaction pins its connection, the driver sends in order and budgets the
 * read by the `statement_timeout` it just sent). A failed settings statement
 * aborts the transaction, so the read fails behind it and the settings error
 * is the one raised. Inside a caller's transaction the read
 * runs in a savepoint, and a released savepoint keeps the settings, so one
 * statement reads the caller's values first and one restores them after; a
 * failed read rolls the savepoint back, which reverts them too.
 *
 * Each setting name is a literal in the statement and each value a bound
 * parameter, so the vendored driver reads a `statement_timeout` change from
 * the text and budgets the next statement by it (#6543).
 *
 * Postgres only: PGLite has no JIT provider, no RLS binding and no
 * statement timeout, so its engine never calls this.
 */
import type postgres from '#postgres';

/** Setting name to transaction-local value. */
export type SearchSettings = Readonly<Record<string, string>>;

export const SEARCH_JIT_OFF: SearchSettings = { jit: 'off' };

const SETTING_NAME = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

function names(settings: SearchSettings): string[] {
  const keys = Object.keys(settings);
  for (const name of keys) if (!SETTING_NAME.test(name)) throw new Error(`search setting name not allowed: ${name}`);
  return keys;
}

/** `SELECT set_config('<name>', $1, true), …`: one statement for every setting, values bound. */
export function searchSettingsStatement(settings: SearchSettings): { sql: string; params: string[] } {
  const keys = names(settings);
  return {
    sql: `SELECT ${keys.map((name, i) => `set_config('${name}', $${i + 1}, true)`).join(', ')}`,
    params: keys.map(name => settings[name]!),
  };
}

const SETTINGS_STATEMENT = /^SELECT set_config\('[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?', \$\d+, true\)(, set_config\('[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?', \$\d+, true\))*$/;
const READ_START = /^\s*(--[^\n]*\n\s*)*(select|with)\b/i;
const NOT_A_PLAIN_READ = /;|\b(insert|update|delete|merge|truncate|copy|lock|call|do|nextval|setval|set_config|pg_notify|pg_advisory\w*|pg_try_advisory\w*|txid_current|pg_current_xact_id|lo_\w+|dblink\w*)\b|\bfor\s+(no\s+key\s+|key\s+)?share\b/i;

/**
 * GBRA-156: what a search read transaction may send behind BEGIN before BEGIN's answer (`TransactionOptions.pipelineEarly`).
 * If BEGIN fails, an accepted statement runs in autocommit, so this accepts the settings statement
 * `searchSettingsStatement` builds (transaction-local, a no-op outside a transaction) and single SELECT or WITH
 * statements (after any leading line comments) that name no write, lock, sequence, notification or session-setting keyword. A refusal costs only the
 * round trip: the statement waits for BEGIN's answer, as every statement did before.
 */
export function isPipelinableSearchRead(statement: string): boolean {
  if (SETTINGS_STATEMENT.test(statement)) return true;
  return READ_START.test(statement) && !NOT_A_PLAIN_READ.test(statement);
}

/** `SELECT current_setting('<name>', true) AS "<name>", …`: the caller's values, one row. */
function currentSettingsStatement(keys: string[]): string {
  return `SELECT ${keys.map(name => `current_setting('${name}', true) AS "${name}"`).join(', ')}`;
}

/**
 * Apply `settings` for `run` on the search transaction `tx`. `nested`: `tx`
 * is a savepoint in a caller's transaction, whose values are restored after
 * `run`; a value the caller never set restores to `fallback[name]`
 * (an extension setting not yet loaded reads as NULL), else ''.
 */
// engine-sql-ok: jit, statement_timeout, enable_seqscan and the hnsw settings are Postgres server settings
export async function withSearchSettings<T>(
  tx: ReturnType<typeof postgres>,
  nested: boolean,
  settings: SearchSettings,
  run: () => Promise<T>,
  fallback: SearchSettings = {},
): Promise<T> {
  const keys = names(settings);
  if (keys.length === 0) return run();
  const previous = nested ? (await tx.unsafe(currentSettingsStatement(keys)))[0] as Record<string, string | null> : undefined;
  const set = searchSettingsStatement(settings);
  const applied = tx.unsafe(set.sql, set.params);
  if (previous) await applied;
  else applied.catch(() => undefined);
  const result = await run().catch(async error => {
    await applied;
    throw error;
  });
  await applied;
  if (previous) {
    const restore = searchSettingsStatement(Object.fromEntries(keys.map(name => [name, previous[name] ?? fallback[name] ?? ''])));
    await tx.unsafe(restore.sql, restore.params);
  }
  return result;
}

/** JIT off for `run` alone (the unscoped jit-off reads). */
export function withSearchJitOff<T>(tx: ReturnType<typeof postgres>, nested: boolean, run: () => Promise<T>): Promise<T> {
  return withSearchSettings(tx, nested, SEARCH_JIT_OFF, run);
}
