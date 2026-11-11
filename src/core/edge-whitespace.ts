/**
 * The whitespace JavaScript's `String.prototype.trim` strips (WhiteSpace and LineTerminator), for SQL twins of
 * TypeScript predicates. Postgres `btrim(x)` with no set strips spaces only, so a twin that trims there disagrees with
 * its TypeScript side on a tab, newline, NBSP or other edge whitespace. Twins trim with edgeTrimSql instead;
 * test/edge-whitespace-twins.test.ts holds the set equal to what `trim` strips.
 */
export const EDGE_WHITESPACE = ' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

const ASCII_EDGES = [...EDGE_WHITESPACE].filter(c => c.charCodeAt(0) < 0x80);
const WIDE_EDGES_HEX = Buffer.from([...EDGE_WHITESPACE].filter(c => c.charCodeAt(0) >= 0x80).join(''), 'utf8').toString('hex');
const EDGE_WHITESPACE_SQL = `(E'${ASCII_EDGES.map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}'`
  + ` || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('${WIDE_EDGES_HEX}', 'hex'), 'UTF8') ELSE '' END)`;

/**
 * `btrim` of a code-provided SQL expression over EDGE_WHITESPACE: the SQL twin of `.trim()`. The SQL text stays ASCII,
 * since Postgres refuses a `\u` escape above U+007F on a database whose encoding is not UTF8; there it trims the ASCII
 * edge characters only.
 */
export function edgeTrimSql(expr: string): string {
  return `btrim(${expr}, ${EDGE_WHITESPACE_SQL})`;
}

/** ASCII-only lowercase in SQL, independent of the database collation: the twin of `.replace(/[A-Z]/g, …)`. */
export function asciiLowerSql(expr: string): string {
  return `translate(${expr}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
}

/** ASCII-only lowercase, the TypeScript side of asciiLowerSql. */
export const asciiLower = (value: string) => value.replace(/[A-Z]/g, c => c.toLowerCase());
