/**
 * #4364 unit scope: `apply-migrations --list`/`--dry-run` must surface the
 * pre-flight DB probe outcome instead of swallowing connection errors — an
 * unreachable database used to print the identical all-pending plan (exit 0)
 * as a clean one. Covers the probe-summary formatter and the --require-db
 * flag parse; the end-to-end unreachable-DB spawn is in
 * test/apply-migrations-list-db-state.serial.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { __testing } from '../src/commands/apply-migrations.ts';

const { parseArgs, formatDbProbeLine } = __testing;

describe('formatDbProbeLine (#4364)', () => {
  test('connected → schema/latest summary line', () => {
    expect(formatDbProbeLine({ status: 'connected', schemaVer: 7, latest: 9 }))
      .toBe('Database: connected, schema v7 (latest 9)');
  });

  test('unreachable → loud UNREACHABLE line carrying the reason', () => {
    const line = formatDbProbeLine({ status: 'unreachable', reason: 'connect ECONNREFUSED' });
    expect(line).toContain('UNREACHABLE');
    expect(line).toContain('connect ECONNREFUSED');
  });

  test('skipped → not-probed line carrying the reason', () => {
    const line = formatDbProbeLine({ status: 'skipped', reason: 'pglite manages schema in-process' });
    expect(line).toContain('not probed');
    expect(line).toContain('pglite');
  });
});

describe('--require-db flag (#4364)', () => {
  test('defaults to false; --require-db flips it', () => {
    expect(parseArgs([]).requireDb).toBe(false);
    expect(parseArgs(['--require-db']).requireDb).toBe(true);
  });
});
