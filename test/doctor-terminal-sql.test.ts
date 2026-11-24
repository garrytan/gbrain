/**
 * The statements of src/core/engine-sql/doctor-terminal.ts keep the exact text the terminal-failure reader composed.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the aggregate and batch statements equal the text `terminal-failures.ts` used to compose from its own
 *    classifier fragments (`TERMINAL_SQL_PARTS`), so the engines and the TypeScript classifier read one rule. No member
 *    lists a name the engine lacks, and no member is listed twice.
 *  - Regression: a drifted literal changes which request-journal receipts doctor counts as terminal write failures, or
 *    which it treats as superseded, on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines on seeded rows, not the literal against the
 *    composer.
 *  - Seam: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import { DOCTOR_TERMINAL_MEMBERS, DOCTOR_TERMINAL_STATEMENTS } from '../src/core/engine-sql/doctor-terminal.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { composeTerminalBatchSql, composeTerminalGroupsSql } from './helpers/terminal-sql-compose.ts';

/** Widened so `toBe` compares with the composed text, not the literal type of the constant. */
const STATEMENTS: Record<string, string> = DOCTOR_TERMINAL_STATEMENTS;

describe('doctor terminal SQL text', () => {
  test('groups: the statement its reader composed', () => {
    expect(STATEMENTS.groups).toBe(composeTerminalGroupsSql());
  });

  test('batch: the statement its reader composed', () => {
    expect(STATEMENTS.batch).toBe(composeTerminalBatchSql());
  });

  test('every member is listed once and the Rust member list knows it', () => {
    expect(new Set(DOCTOR_TERMINAL_MEMBERS).size).toBe(DOCTOR_TERMINAL_MEMBERS.length);
    for (const member of DOCTOR_TERMINAL_MEMBERS) expect(Object.keys(RUST_ENGINE_MEMBERS)).toContain(member);
  });
});
