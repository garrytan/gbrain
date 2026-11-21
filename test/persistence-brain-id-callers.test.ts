/**
 * The brain identity callers that read `persistence_brain.brain_id` through the typed `readPersistenceBrainId` member.
 *
 * Fail-first: on the base e3e04ef239 every file in MOVED still sent `SELECT brain_id FROM persistence_brain WHERE
 * singleton=1` (two with `FOR UPDATE`) through `executeRaw`, so the first test fails on each of them.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: none of these callers sends the brain identity statement as raw SQL; each one reads the member (a
 *    locking caller passes `{ lock: true }`), which every engine serves, the Rust engine included.
 *  - Regression: a raw identity read in one of these files reaches the Rust engine's raw_sql refusal, which the
 *    `.catch` callers turn into the brain id `host` and the others into a failed command.
 *  - Why existing coverage misses it: the caller suites run on the SQL engines, where the raw read answers.
 *  - Seam: none; the source text of each file. test/engine-parity/brain-id-callers.test.ts runs the moved reads on
 *    every arm.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

/** Each moved file, and how many typed identity reads it makes (the locking ones pass `{ lock: true }`). */
const MOVED: Record<string, { reads: number; locked: number }> = {
  'src/commands/upgrade.ts': { reads: 1, locked: 0 },
  'src/core/sync-identity-downgrades.ts': { reads: 1, locked: 0 },
  'src/core/shared-skills/membership.ts': { reads: 1, locked: 1 },
  'src/core/shared-skills/migration-export.ts': { reads: 1, locked: 0 },
  'src/core/shared-skills/restore.ts': { reads: 1, locked: 1 },
  'src/core/persistence/physical-root.ts': { reads: 2, locked: 0 },
  'src/core/persistence/topology-locks.ts': { reads: 1, locked: 0 },
  'src/core/persistence/reconcile-backup.ts': { reads: 1, locked: 0 },
  'src/core/persistence/reconcile-state.ts': { reads: 1, locked: 0 },
  'src/core/persistence/topology-clone.ts': { reads: 1, locked: 0 },
};

/** The raw identity statement, with or without a lock clause, in any quoting. */
const RAW_IDENTITY = /SELECT\s+brain_id\s+FROM\s+persistence_brain\s+WHERE\s+singleton\s*=\s*1\b/g;
/** A typed identity read: the member, or the identity.ts helper that refuses a missing row. */
const TYPED = /\.readPersistenceBrainId\(|\breadBrainIdentity\(/g;

describe('brain identity callers read the typed member', () => {
  for (const [rel, want] of Object.entries(MOVED)) {
    test(`${rel} sends no raw identity read`, () => {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      expect(text.match(RAW_IDENTITY) ?? []).toEqual([]);
      expect((text.match(TYPED) ?? []).length).toBeGreaterThanOrEqual(want.reads);
      expect((text.match(/\.readPersistenceBrainId\(\{ lock: true \}\)/g) ?? []).length).toBe(want.locked);
    });
  }

  test('the matcher sees the raw shapes the callers sent', () => {
    expect("engine.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1')".match(RAW_IDENTITY)).toHaveLength(1);
    expect("tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE')".match(RAW_IDENTITY)).toHaveLength(1);
    expect("'SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1'".match(RAW_IDENTITY)).toBeNull();
  });
});
