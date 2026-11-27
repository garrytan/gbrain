/**
 * The statements of src/core/engine-sql/doctor-brain.ts keep the exact text the doctor readers built inline.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the orphan-checkpoint statement inlines the predicate `connector-checkpoint-migration.ts` still composes
 *    for its guarded DELETE (`orphanPredicate`), so the doctor listing and the repair delete read one rule; its text
 *    equals the old composed text with the predicate bound from `$2`. No member lists a name the engine lacks, and no
 *    member is listed twice.
 *  - Regression: a drifted inlined predicate changes which connector checkpoint rows doctor reports as orphans (and
 *    repair would delete a different set) on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines on an empty brain for this member, not the text
 *    against the old builder.
 *  - Seam: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import { DOCTOR_BRAIN_MEMBERS, DOCTOR_BRAIN_STATEMENTS } from '../src/core/engine-sql/doctor-brain.ts';
import { orphanPredicate } from '../src/core/persistence/connector-checkpoint-migration.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';

/** Widened so `toBe` compares with the composed text, not the literal type of the constant. */
const STATEMENTS: Record<string, string> = DOCTOR_BRAIN_STATEMENTS;

describe('doctor brain SQL text', () => {
  test('orphanConnectorCheckpoints: the statement its reader composed', () => {
    expect(STATEMENTS.orphanConnectorCheckpoints).toBe(`SELECT c.op, c.fingerprint, c.updated_at::text AS updated_at FROM op_checkpoints c
    WHERE c.op IN ('managed-connector','managed-connector-retry') AND ${orphanPredicate(2)}
    ORDER BY c.op COLLATE "C", c.fingerprint COLLATE "C" LIMIT $1`);
  });

  test('every member is listed once and the Rust member list knows it', () => {
    expect(new Set(DOCTOR_BRAIN_MEMBERS).size).toBe(DOCTOR_BRAIN_MEMBERS.length);
    for (const member of DOCTOR_BRAIN_MEMBERS) expect(Object.keys(RUST_ENGINE_MEMBERS)).toContain(member);
  });
});
