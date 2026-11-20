/**
 * How many publication passes may run at once (persistence/pool-capacity.ts `publicationConcurrency`), by engine kind.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an embedded store with one writer (PGLite, and the Rust store) gets one publisher; Postgres gets
 *    min(2, the ordinary pool's long-hold capacity), read from the pool's `options.max`.
 *  - Regression: a Rust brain has no postgres.js pool, so reading pool options threw
 *    "undefined is not an object (evaluating 'pool.options')" and the consumer stopped before its first claim.
 *  - Why existing coverage misses it: the capacity tests use PGLite and Postgres engines only.
 *  - Seam: engine-shaped objects that carry only `kind` and, for Postgres, `sql.options`; no database.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { publicationConcurrency } from '../src/core/persistence/pool-capacity.ts';

const engineOf = (shape: object) => shape as unknown as BrainEngine;

describe('publicationConcurrency', () => {
  test('a Rust brain gets one publisher, like PGLite, without a pool', () => {
    expect(publicationConcurrency(engineOf({ kind: 'rust' }))).toBe(1);
    expect(publicationConcurrency(engineOf({ kind: 'pglite' }))).toBe(1);
  });

  test('Postgres still reads the pool options', () => {
    expect(publicationConcurrency(engineOf({ kind: 'postgres', sql: { options: { max: 10 } } }))).toBe(2);
    expect(publicationConcurrency(engineOf({ kind: 'postgres', sql: { options: { max: 2 } } }))).toBe(1);
    expect(publicationConcurrency(engineOf({ kind: 'postgres', sql: { options: { max: 1 } } }))).toBe(0);
    expect(() => publicationConcurrency(engineOf({ kind: 'postgres' }))).toThrow(TypeError);
  });
});
