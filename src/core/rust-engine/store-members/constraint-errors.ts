/**
 * A `constraint_violation` of the store as the error the SQL engines raise (shared by the members of tables the store
 * holds to their CHECK, UNIQUE and foreign-key constraints: jobs-oauth-clients.ts, jobs-access-tokens.ts,
 * cli-sources.ts).
 */
import { storeCall } from './common.ts';

/** Which Postgres error a store message is: `new row for relation "t" violates check constraint "c"` and its siblings. */
const PG_REFUSALS: ReadonlyArray<{ re: RegExp; code: string; names: (m: RegExpExecArray) => [table: string | undefined, constraint: string] }> = [
  { re: /^new row for relation "([^"]+)" violates check constraint "([^"]+)"$/, code: '23514', names: m => [m[1]!, m[2]!] },
  { re: /^duplicate key value violates unique constraint "([^"]+)"$/, code: '23505', names: m => [undefined, m[1]!] },
  { re: /^insert or update on table "([^"]+)" violates foreign key constraint "([^"]+)"$/, code: '23503', names: m => [m[1]!, m[2]!] },
  // A delete of a referenced row: the error's table is the referencing one, as Postgres reports it.
  { re: /^update or delete on table "[^"]+" violates foreign key constraint "([^"]+)" on table "([^"]+)"$/, code: '23503', names: m => [m[2]!, m[1]!] },
];

/** A `constraint_violation` of the store as the error PGLite (`constraint`, `table`) and postgres.js (`constraint_name`, `table_name`) raise. */
function asSqlConstraintError(error: unknown): unknown {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== 'constraint_violation') return error;
  for (const { re, code, names } of PG_REFUSALS) {
    const m = re.exec(error.message);
    if (!m) continue;
    const [table, constraint] = names(m);
    return Object.assign(error, { code, constraint, constraint_name: constraint, ...(table ? { table, table_name: table } : {}) });
  }
  return error;
}

export async function refusing<T>(member: string, run: () => Promise<T>): Promise<T> {
  try {
    return await storeCall({ member }, run);
  } catch (error) {
    throw asSqlConstraintError(error);
  }
}
