/**
 * GBRA-438: `gbrain autopilot --install` refusals on PGLite and repo-less brains.
 *
 * 1. Protects: both refusals carry a registered code, a why, and a fix that
 *    points a PGLite or repo-less brain at free upkeep instead of a daemon.
 * 2. Fails when: a refusal loses its code, its fix asks for consent on the
 *    free path, or the Postgres no-repo fix stops asking the user for the dir.
 * 3. Real seams: the refusal builders autopilot.ts passes to exitCliError.
 */
import { describe, expect, test } from 'bun:test';
import { autopilotNoRepoRefusal, autopilotPgliteRefusal } from '../src/commands/autopilot-refusals.ts';
import { CODES } from '../src/core/error-registry.ts';

describe('autopilot --install refusals (GBRA-438)', () => {
  test('PGLite daemon refusal points at free upkeep', () => {
    const e = autopilotPgliteRefusal('PGLite holds one writer.\nsecond line');
    expect(e.code).toBe('autopilot_pglite_daemon');
    expect(e.message).toBe('PGLite holds one writer. To install the daemon anyway on a dedicated brain, re-run with --force.');
    expect(e.why).toBeTruthy();
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'maintain', '--status'], consent: [] });
  });

  test('repo-less PGLite brain is sent to free upkeep, not asked for a repo', () => {
    const e = autopilotNoRepoRefusal('pglite');
    expect(e.code).toBe('autopilot_no_repo');
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'maintain', '--status'], consent: [] });
  });

  test('Postgres brain without a repo is asked for the directory', () => {
    const e = autopilotNoRepoRefusal('postgres');
    expect(e.code).toBe('autopilot_no_repo');
    expect(e.fix).toMatchObject({ argv: ['gbrain', 'autopilot', '--install', '--repo', '<dir>'], ask_user: true, consent: ['persistent_install'] });
  });

  test('both codes are registered', () => {
    expect(Object.keys(CODES)).toEqual(expect.arrayContaining(['autopilot_pglite_daemon', 'autopilot_no_repo']));
  });
});
