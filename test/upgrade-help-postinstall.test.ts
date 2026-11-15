/**
 * gbrain ships no postinstall script (#9383), so upgrade's help names none.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('gbrain upgrade --help', () => {
  test('names no package postinstall', () => {
    const run = spawnSync('bun', [join(import.meta.dir, '..', 'src', 'cli.ts'), 'upgrade', '--help'], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('--no-autopilot-install');
    expect(run.stdout).not.toContain('postinstall');
  }, 90_000);
});
