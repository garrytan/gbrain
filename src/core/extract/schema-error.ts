/** Exact old-schema compatibility for extraction rollups, never a general SQL-error fallback. */
export function isMissingRollupObject(error: unknown, kind: 'column' | 'table', name: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as Record<string, unknown>;
  if (err.code !== (kind === 'column' ? '42703' : '42P01')) return false;
  // Driver SQL metadata wins over message text. Bun's numeric Error.column
  // is a source location, not a database identifier.
  const fields = kind === 'column' ? ['column_name', 'column'] : ['table_name', 'table'];
  const identifiers = fields.map(field => err[field]).filter((value): value is string => typeof value === 'string');
  if (identifiers.length) return identifiers.every(identifier => identifier === name);
  if (typeof err.message !== 'string') return false;
  // PostgreSQL/PGLite omit object metadata for common undefined-object
  // errors. Match the complete diagnostic, including an optional SQL alias.
  const match = kind === 'column'
    ? /^column (?:"([^"]+)"|([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?))(?: of relation "extract_rollup_7d")? does not exist$/.exec(err.message)
    : /^relation "([^"]+)" does not exist$/.exec(err.message);
  const identifier = match?.[1] ?? match?.[2];
  return identifier !== undefined && identifier.split('.').pop() === name;
}
