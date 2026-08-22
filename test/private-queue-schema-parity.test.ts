/**
 * 3-way private-queue schema-surface parity (v0.46.25, #4332).
 *
 * Three schema blobs must carry the dream-inline private-queue lifecycle
 * surface in lockstep:
 *   - src/schema.sql              (authoring source; build:schema input)
 *   - src/core/schema-embedded.generated.ts (generated Postgres blob)
 *   - src/core/pglite-schema.ts   (PGLite blob)
 *
 * A blob missing the columns re-introduces the v121 wedge class (its own
 * CREATE INDEX references a column its CREATE TABLE no longer declares on a
 * fresh install); a blob missing an index silently loses the partial-index
 * scoping that keeps startup private-queue recovery off the general job
 * table. Assertions are text-level with whitespace normalization so
 * formatting-only divergence between the blobs can't false-fail.
 *
 * Scope is deliberately narrow: ONLY the private-queue surface. Full blob
 * parity is a known TODO — do not grow this file into it.
 *
 * Parallel-lane file: no DB boot, no env mutation, no mock.module.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const BLOBS = [
  'src/schema.sql',
  'src/core/schema-embedded.generated.ts',
  'src/core/pglite-schema.ts',
] as const;

/**
 * Collapse whitespace runs and strip spaces around parens/commas. Applied to
 * BOTH haystack and needle, so any formatting-only difference (indentation,
 * line wrapping, `(queue, x)` vs `(queue,x)`) compares equal.
 */
function normalizeSql(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');
}

// The three column definitions from migration v136 / the minion_jobs
// CREATE TABLE body. The FK must SET NULL (detach, never cascade-delete a
// child job) when the owner row disappears.
const COLUMN_DEFS = [
  'private_queue_owner_job_id INTEGER REFERENCES minion_jobs(id) ON DELETE SET NULL',
  'private_queue_owner_token TEXT',
  'private_queue_lease_until TIMESTAMPTZ',
];

// Both partial indexes, INCLUDING their predicates: the recovery index is
// only useful scoped to dream-inline queues in live statuses, and the owner
// index only over non-NULL owners.
const INDEX_DEFS = [
  `CREATE INDEX IF NOT EXISTS idx_minion_jobs_private_queue_recovery
     ON minion_jobs (queue, private_queue_lease_until)
     WHERE queue LIKE 'dream-inline-%'
       AND status IN ('waiting','active','delayed','waiting-children','paused')`,
  `CREATE INDEX IF NOT EXISTS idx_minion_jobs_private_queue_owner
     ON minion_jobs (private_queue_owner_job_id)
     WHERE private_queue_owner_job_id IS NOT NULL`,
];

describe('private-queue schema surface parity (3-way)', () => {
  for (const blob of BLOBS) {
    test(`${blob} declares the three private-queue columns and both dream-inline partial indexes`, () => {
      const normalized = normalizeSql(
        readFileSync(resolvePath(process.cwd(), blob), 'utf-8'),
      );
      for (const def of COLUMN_DEFS) {
        expect(normalized).toContain(normalizeSql(def));
      }
      for (const def of INDEX_DEFS) {
        expect(normalized).toContain(normalizeSql(def));
      }
    });
  }
});
