/**
 * Fact row helpers shared by the facts store members. This module holds no members: index.ts spreads every export of a
 * member module into STORE_MEMBERS, so shared helpers live here and not in a member module. The fact pool's scope and
 * filters (`poolArgs`) live in fact-pool.ts.
 */

type Row = Record<string, unknown>;

export const FACT_DATES = ['valid_from', 'valid_until', 'expired_at', 'consolidated_at', 'embedded_at', 'created_at'] as const;
/** A returned vector (a number list or null) as the `Float32Array` PGLite hands back. */
export const withVector = (row: Row): Row =>
  Array.isArray(row.embedding) ? { ...row, embedding: new Float32Array(row.embedding as number[]) } : row;
