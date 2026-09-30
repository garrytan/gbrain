/**
 * Row normalizer for engine-sql results (refactor wave 1, A5).
 *
 * PGLite and postgres.js decode some column types differently (int8 as
 * number vs string, vector as text, timestamps as string on text projections).
 * A statement that needs a uniform shape declares each column's kind ONCE, at
 * module scope; `compileRowNormalizer` returns a function that converts only
 * the declared columns and leaves every other column as the driver returned
 * it. The declared kind picks the conversion, never the value's runtime type.
 * `test/engine-sql-normalize.test.ts` pins each kind on both engines.
 */

import { parseEmbedding } from '../utils.ts';
import type { Row } from './executor.ts';

export type ColumnKind = 'jsonb' | 'bigint' | 'date' | 'vector' | 'text[]';

const CONVERT: Record<ColumnKind, (value: unknown) => unknown> = {
  /** Parsed JSON; a driver that returned the JSON text is parsed once. */
  jsonb: (v) => (typeof v === 'string' ? JSON.parse(v) : v),
  /** JS number (int8 arrives as string from postgres.js, number from PGLite). */
  bigint: (v) => (v === null || v === undefined ? v : Number(v)),
  /** `Date` instant. */
  date: (v) => (v === null || v === undefined || v instanceof Date ? v : new Date(String(v))),
  /** `Float32Array` (pgvector text literal or driver array). */
  vector: (v) => (v === null || v === undefined ? null : parseEmbedding(v)),
  /** `string[]`; NULL stays NULL. */
  'text[]': (v) => (v === null || v === undefined ? v : (v as unknown[]).map((x) => (x === null ? null : String(x)))),
};

export function compileRowNormalizer<R extends object = Row>(kinds: Readonly<Record<string, ColumnKind>>): (row: Row) => R {
  const entries = Object.entries(kinds).map(([column, kind]) => [column, CONVERT[kind]] as const);
  return (row) => {
    const out: Row = { ...row };
    for (const [column, convert] of entries) {
      if (column in out) out[column] = convert(out[column]);
    }
    return out as unknown as R;
  };
}
