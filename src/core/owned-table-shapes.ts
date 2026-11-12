/**
 * #9190: gbrain creates its tables with CREATE TABLE IF NOT EXISTS, so a table of the same name that another
 * application created in the brain's schema was adopted silently; later migrations then added columns to it and an
 * upgrade stopped midway on the first statement that compared the wrong type, naming neither table nor column.
 * Before the schema blob replays (engine-sql/bootstrap.ts) and before a migration run (migrate.ts), every table here
 * that already exists must have every column gbrain has given it since it first created the table (v32), with the
 * same type. Otherwise schema setup refuses with `foreign_table` and changes nothing: the table is another
 * application's data, so moving it is the user's decision.
 */
import { opError, type OperationError } from './ops/contract.ts';

/** Columns and types each table has had since v32; every one must exist with its type. */
const OWNED_TABLE_COLUMNS: Record<string, ReadonlyArray<readonly [column: string, type: string]>> = {
  oauth_clients: [
    ['client_id', 'text'], ['client_secret_hash', 'text'], ['client_name', 'text'], ['redirect_uris', 'text[]'],
    ['grant_types', 'text[]'], ['scope', 'text'], ['token_endpoint_auth_method', 'text'], ['client_id_issued_at', 'bigint'],
    ['client_secret_expires_at', 'bigint'], ['created_at', 'timestamp with time zone'],
  ],
  oauth_tokens: [
    ['token_hash', 'text'], ['token_type', 'text'], ['client_id', 'text'], ['scopes', 'text[]'], ['expires_at', 'bigint'],
    ['resource', 'text'], ['created_at', 'timestamp with time zone'],
  ],
  oauth_codes: [
    ['code_hash', 'text'], ['client_id', 'text'], ['scopes', 'text[]'], ['code_challenge', 'text'],
    ['code_challenge_method', 'text'], ['redirect_uri', 'text'], ['state', 'text'], ['resource', 'text'],
    ['expires_at', 'bigint'], ['created_at', 'timestamp with time zone'],
  ],
};

const EXPECTED_ROWS = Object.entries(OWNED_TABLE_COLUMNS)
  .flatMap(([table, columns]) => columns.map(([column, type]) => [table, column, type] as const))
  .map(([table, column, type], ord) => `('${table}', '${column}', '${type}', ${ord})`);

/** One row naming the first mismatch in the current schema (a wrong type before a missing column), or none. */
const SHAPE_PROBE_SQL = `WITH expected(table_name, column_name, expected_type, ord) AS (VALUES ${EXPECTED_ROWS.join(', ')})
SELECT n.nspname AS schema_name, e.table_name, e.column_name, e.expected_type,
  format_type(a.atttypid, a.atttypmod) AS found_type
FROM expected e
JOIN pg_class c ON c.relname = e.table_name
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = e.column_name AND a.attnum > 0 AND NOT a.attisdropped
WHERE a.attname IS NULL OR format_type(a.atttypid, a.atttypmod) <> e.expected_type
ORDER BY a.attname IS NULL, e.ord
LIMIT 1`;

interface ShapeMismatch { schema_name: string; table_name: string; column_name: string; expected_type: string; found_type: string | null }

function foreignTableError(m: ShapeMismatch): OperationError {
  const qualified = `${m.schema_name}.${m.table_name}`;
  const command = 'gbrain apply-migrations --force-schema --yes';
  return opError('foreign_table',
    `Schema setup stopped before changing anything: ${qualified}.${m.column_name} is ${m.found_type ?? 'missing'}, but gbrain's ${m.table_name} needs ${m.expected_type}. ` +
    `A table named ${m.table_name} that gbrain did not create (probably another application sharing this database) is in the way. ` +
    `Give gbrain its own database, or move that table to a schema of its own with ALTER TABLE ${qualified} SET SCHEMA <other_schema> ` +
    `(its indexes and constraints move with it) and point that application there; then run ${command}.`,
    'Ask the user before changing that table: it holds another application\'s data, and moving it affects that application.',
    { detail: qualified, fix: {
      ask_user: true, argv: ['gbrain', 'apply-migrations', '--force-schema', '--yes'], consent: [], actor: 'user', requires_exclusive: false,
      why: `Once ${qualified} has moved, this creates gbrain's own ${m.table_name} and applies the pending migrations.`,
      user_message: `Your database already has a table named ${qualified} that gbrain did not create; it is probably another application's. ` +
        `gbrain stopped before changing anything. Either give gbrain its own database, or move that table with ALTER TABLE ${qualified} SET SCHEMA <other_schema> ` +
        `and point its application at the new schema. Then run ${command}.`,
      verify: { argv: ['gbrain', 'doctor', '--only', 'schema_version', '--json'] },
    } });
}

/** Throws `foreign_table` when a table gbrain owns by name exists with a shape gbrain never gave it. */
export async function assertOwnedTableShapes(queryOne: (sql: string) => Promise<Record<string, unknown> | undefined>): Promise<void> {
  const mismatch = await queryOne(SHAPE_PROBE_SQL);
  if (mismatch?.table_name) throw foreignTableError(mismatch as unknown as ShapeMismatch);
}
