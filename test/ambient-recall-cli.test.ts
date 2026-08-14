/**
 * v0.45.7 — ambient recall CLI surface: the commands the bootstrap templates
 * tell agents to run (`gbrain context-pack …`, `gbrain delta …`) actually
 * execute end-to-end against the real cli.ts entrypoint. Subprocess tests
 * against a shared temp PGLite home (schema init is paid once in beforeAll;
 * later spawns reuse the persisted brain). Pins:
 *   - exit 0 + parseable JSON envelope with protocol_version 1 on both verbs
 *   - `since` echoed NORMALIZED to ISO (never the raw string)
 *   - unparseable --since → exit 1 + the verbError rendering on stderr
 *     (`Error [invalid_params]: …` + the `Fix:` suggestion line)
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      GBRAIN_HOME: home,
      DATABASE_URL: '',
      GBRAIN_DATABASE_URL: '',
      GBRAIN_SKIP_STARTUP_HOOKS: '1', // no detached check-update child
    },
    timeout: 60_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-ambient-cli-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') }),
  );
  // Warm the brain once: the first CLI touch runs initSchema/migrations; the
  // tests below then measure command behavior, not schema-init behavior.
  const warm = run(['delta', '--since', '1970-01-01T00:00:00Z', '--json']);
  expect(warm.status).toBe(0);
}, 120_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('gbrain context-pack (CLI)', () => {
  test('--entities + --budget-tokens --json: exit 0, protocol_version 1, budget fields', () => {
    const { stdout, status } = run([
      'context-pack', '--entities', 'alice-example', '--budget-tokens', '2000', '--json',
    ]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.protocol_version).toBe(1);
    expect(env.entities).toEqual(['alice-example']);
    // Empty brain → empty pack, but the budget contract still rides the envelope.
    expect(env.budget_tokens).toBe(2000);
    expect(env.budget_used).toBe(0);
    expect(env.dropped_count).toBe(0);
    expect(Array.isArray(env.cards)).toBe(true);
    expect(Array.isArray(env.facts)).toBe(true);
  }, 60_000);
});

describe('gbrain delta (CLI)', () => {
  test('--since <ISO> --json: exit 0, protocol_version 1, ISO-normalized echo', () => {
    const { stdout, status } = run(['delta', '--since', '1970-01-01T00:00:00Z', '--json']);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.protocol_version).toBe(1);
    expect(env.since).toBe('1970-01-01T00:00:00.000Z');
    expect(env.pages).toEqual([]);
    expect(env.has_more).toBe(false);
    expect(env.next_cursor).toEqual({ since: '1970-01-01T00:00:00.000Z', slug: '' });
  }, 60_000);

  test('unparseable --since: exit 1, invalid_params rendering on stderr', () => {
    const { stdout, stderr, status } = run(['delta', '--since', 'not-a-date', '--json']);
    expect(status).toBe(1);
    // verbError CLI rendering: `Error [code]: message` + the Fix line (stderr).
    expect(stderr).toContain('Error [invalid_params]:');
    expect(stderr).toContain('not a parseable timestamp');
    expect(stderr).toContain('Fix:');
    expect(stdout).toBe(''); // no envelope on the error path
  }, 60_000);
});
