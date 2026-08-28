/**
 * `gbrain init --prefer-postgres` — the Postgres-first install ladder
 * (db-availability loop 5a). Spawned against the real cli.ts entrypoint (the
 * house pattern for CLI-surface tests, see engine-status.test.ts) with
 * GBRAIN_HOME pointed at a fresh temp dir per test, so nothing touches the
 * operator's real ~/.gbrain. `--no-embedding` keeps the runs deterministic
 * and key-free (no provider env detection, no embed check, no network).
 *
 * Pins:
 *   - existing-config refusal: the ladder NEVER re-runs over a configured
 *     brain (an outage must not let the PGLite floor orphan a Postgres brain)
 *   - no-env fall-through: every rung notes its skip on stderr and the
 *     PGLite floor lands, emitting the single --json envelope
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const REPO = join(import.meta.dir, '..');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-prefer-pg-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function run(args: string[], envOverrides: Record<string, string> = {}): RunResult {
  const r = spawnSync('bun', ['run', CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      ...process.env,
      GBRAIN_HOME: home,
      // Empty string = unset for every truthiness/length check in config.ts
      // and every rung-entry predicate in the ladder.
      DATABASE_URL: '',
      GBRAIN_DATABASE_URL: '',
      GBRAIN_BRAIN_ID: '',
      SUPABASE_ACCESS_TOKEN: '',
      SUPABASE_PROJECT_REF: '',
      SUPABASE_DB_PASSWORD: '',
      PGHOST: '',
      PGPORT: '',
      PGUSER: '',
      PGPASSWORD: '',
      // Keyless posture, deterministically: ambient provider keys on a dev
      // machine would only add "Detected ..." notes, but clear them anyway.
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      VOYAGE_API_KEY: '',
      GBRAIN_SKIP_STARTUP_HOOKS: '1', // no detached check-update child
      ...envOverrides,
    },
    timeout: 170_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(cfg));
}

describe('gbrain init --prefer-postgres', () => {
  test('existing-config refusal: exit 1, points at engine status + db-repair, config untouched', () => {
    const url = 'postgresql://u:p@db.example.com:5432/gbrain';
    writeConfig({ engine: 'postgres', database_url: url });
    const { status, stderr, stdout } = run(['init', '--prefer-postgres', '--no-embedding']);
    expect(status).toBe(1);
    expect(stderr).toContain('already configured');
    expect(stderr).toContain('db-repair');
    // No rung ever ran — the refusal is BEFORE the ladder.
    expect(stderr).not.toContain('rung 1');
    expect(stdout).not.toContain('Brain ready');
    // The raw credential never leaks into the refusal output.
    expect(stderr + stdout).not.toContain('u:p@');
  }, 120_000);

  test('no-env fall-through: every rung notes its skip on stderr, PGLite floor lands, one --json envelope', () => {
    const { status, stderr, stdout } = run(['init', '--prefer-postgres', '--no-embedding', '--json']);
    expect(status).toBe(0);

    // Every reachable-but-unusable rung prints its one-line skip note.
    expect(stderr).toContain('rung 1 (env URL): no GBRAIN_DATABASE_URL/DATABASE_URL');
    expect(stderr).toContain('rung 2 (supabase): no SUPABASE_ACCESS_TOKEN');
    expect(stderr).toContain('rung 3 (local postgres): no PG* env vars and no --local-postgres');
    expect(stderr).toContain('rung 4 (docker): not opted in (--allow-docker)');
    expect(stderr).toContain('falling back to PGLite');

    // The final envelope is the ONLY stdout content — `--json | jq` purity.
    // withStdoutToStderr reroutes BOTH seams (console.log, which Bun writes
    // to fd 1 directly, AND bare process.stdout.write) around the inner init.
    const envelope = JSON.parse(stdout.trim());
    expect(envelope).toEqual({ status: 'ok', engine: 'pglite', ladder_rung: 'pglite', url_source: null });

    // The floor really initialized: config + PGLite data dir exist in the temp home.
    expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(true);
    expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(true);
  }, 180_000);
});
