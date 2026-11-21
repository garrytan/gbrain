/**
 * GST-3216 PR 1: `gbrain identity` runs end to end through the real cli.ts on a repo-less keyless PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '', GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    timeout: 60_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-identity-cli-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') }));
});

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe('gbrain identity (CLI)', () => {
  test('--json on a fresh brain: no identifiers, the reserved owner page', () => {
    const { stdout, status, stderr } = run(['identity', '--json']);
    expect({ status, stderr: status === 0 ? '' : stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ member: null, identifiers: [], entity: { slug: 'memory/owner', source_id: null, basis: 'reserved_page' }, pages: [], conflicts: [], skipped_sources: [] });
  }, 120_000);

  test('human output names the owner page and says no identifier is known yet', () => {
    const { stdout, status } = run(['identity']);
    expect(status).toBe(0);
    expect(stdout).toContain('Owner page: memory/owner');
    expect(stdout).toContain('Identifiers: none yet');
  }, 60_000);

  test('--member with no value is a usage error', () => {
    const { stderr, status } = run(['identity', '--member']);
    expect(status).toBe(2);
    expect(stderr).toContain('--member needs a member id');
  }, 60_000);

  test('--member with an id no member has is a usage error, not a made-up identity', () => {
    const { stdout, stderr, status } = run(['identity', '--member', 'nobody-example', '--json']);
    expect(status).toBe(2);
    expect(stdout).not.toContain('memory/members/nobody-example');
    expect(`${stdout}${stderr}`).toContain('no member has the id nobody-example');
  }, 60_000);
});
