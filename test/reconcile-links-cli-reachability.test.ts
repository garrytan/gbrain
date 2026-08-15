/**
 * #2900 — `reconcile-links` CLI reachability.
 *
 * `reconcile-links` is advertised in `gbrain --help` and fully implemented
 * with a `case 'reconcile-links'` block in cli.ts's handleCliOnly switch, but
 * it was missing from the CLI_ONLY Set. Dispatch only reaches handleCliOnly
 * when the command is in CLI_ONLY, so every invocation fell through to the
 * shared-operations lookup and hit the generic "Unknown command" branch —
 * leaving the documented doc↔impl edge-rebuild tool silently unreachable.
 *
 * Same class of drift as #2035 (`calibration`).
 */

import { describe, test, expect } from 'bun:test';
import { CLI_ONLY } from '../src/cli.ts';

describe('CLI_ONLY command reachability (#2900)', () => {
  test('`reconcile-links` is in CLI_ONLY so dispatch reaches its handler', () => {
    expect(CLI_ONLY.has('reconcile-links')).toBe(true);
  });
});

// #3224 — same drift class: `backfill` has a full `case 'backfill'` handler
// (cli.ts, dispatching to commands/backfill.ts) but was missing from CLI_ONLY,
// so every invocation hit the generic "Unknown command" branch.
describe('CLI_ONLY command reachability (#3224)', () => {
  test('`backfill` is in CLI_ONLY so dispatch reaches its handler', () => {
    expect(CLI_ONLY.has('backfill')).toBe(true);
  });

  test('`gbrain backfill --help` is dispatched, not rejected as unknown', () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const result = spawnSync('bun', ['run', 'src/cli.ts', 'backfill', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_HOME: '/tmp/gbrain-test-backfill-nonexistent' },
    });
    expect(result.stderr ?? '').not.toContain('Unknown command');
    expect(result.status).toBe(0);
  });
});
