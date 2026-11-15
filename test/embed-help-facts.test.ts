/**
 * `embed --stale` embeds page chunks, never facts saved with `remember`; the help names the fact form that does.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('gbrain embed --help', () => {
  test('says --stale skips saved facts and names the working --stale --facts --source form', () => {
    const run = spawnSync('bun', [join(import.meta.dir, '..', 'src', 'cli.ts'), 'embed', '--help'], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('--stale --facts --source <id>');
    expect(run.stdout).toContain('remember');
    expect(run.stdout).not.toMatch(/\| --facts(\s|$)/);
  }, 90_000);
});
