/**
 * `--job-isolation process`: the per-job child (`gbrain jobs run-child`) is a
 * fresh gbrain process that re-runs the startup cwd-.env quarantine in the
 * SAME cwd as the worker, so an env-only handoff of GBRAIN_ALLOW_SHELL_JOBS is
 * dropped again whenever a .env there assigns it — exactly the hole
 * `jobs work --allow-shell-jobs` closes for the supervisor → worker hop. The
 * opt-in therefore travels to the child as a flag too (`buildChildArgs`), and
 * the `run-child` case re-asserts the env var from it after preflight.
 */
import { describe, expect, test } from 'bun:test';
import { buildChildArgs } from '../src/core/minions/job-isolation.ts';

describe('buildChildArgs — --allow-shell-jobs pass-through (A5)', () => {
  test('appends --allow-shell-jobs when the spawning env carries GBRAIN_ALLOW_SHELL_JOBS=1', () => {
    expect(buildChildArgs(42, { GBRAIN_ALLOW_SHELL_JOBS: '1' }))
      .toEqual(['jobs', 'run-child', '--job-id', '42', '--allow-shell-jobs']);
  });

  test('omits the flag when the opt-in is absent or not exactly "1" (argv byte-identical)', () => {
    expect(buildChildArgs(42, {})).toEqual(['jobs', 'run-child', '--job-id', '42']);
    expect(buildChildArgs(7, { GBRAIN_ALLOW_SHELL_JOBS: 'true' })).not.toContain('--allow-shell-jobs');
    expect(buildChildArgs(7, { GBRAIN_ALLOW_SHELL_JOBS: '' })).not.toContain('--allow-shell-jobs');
  });
});
