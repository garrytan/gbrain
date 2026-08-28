/**
 * `gbrain engine status` — the engine-free detection primitive of the
 * db-availability loop. Spawned against the real cli.ts entrypoint (the
 * house pattern for CLI-surface tests) with GBRAIN_HOME pointed at a fresh
 * temp dir per test, so nothing touches the operator's real ~/.gbrain.
 *
 * Pins:
 *   - unconfigured home → effective_engine null + no_url diagnosis + exit 1
 *   - pglite config → engine/source/lock report + exit 0
 *   - env URL override → postgres wins over the file's pglite, redacted URL
 *   - #427 cwd-.env shadow → env.shadowed + env_shadowed diagnosis
 *   - --probe against a closed port → classified conn_refused, no raw
 *     password anywhere in the JSON
 *   - unknown flag → exit 2
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const REPO = join(import.meta.dir, '..');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-engine-status-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function run(args: string[], envOverrides: Record<string, string> = {}, cwd: string = REPO): RunResult {
  const r = spawnSync('bun', ['run', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GBRAIN_HOME: home,
      // Empty string = unset for every truthiness/length check in config.ts.
      DATABASE_URL: '',
      GBRAIN_DATABASE_URL: '',
      GBRAIN_BRAIN_ID: '',
      GBRAIN_SKIP_STARTUP_HOOKS: '1', // no detached check-update child
      ...envOverrides,
    },
    timeout: 60_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function parseReport(stdout: string): any {
  const start = stdout.indexOf('{');
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start));
}

function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(cfg));
}

describe('gbrain engine status', () => {
  test('unconfigured home: effective_engine null, no_url diagnosis, exit 1', () => {
    const { stdout, status } = run(['engine', 'status', '--json']);
    expect(status).toBe(1);
    const report = parseReport(stdout);
    expect(report.schema_version).toBe(1);
    expect(report.brain_id).toBe('host');
    expect(report.effective_engine).toBeNull();
    expect(report.config_file_engine).toBeNull();
    expect(report.db_url_source).toBeNull();
    expect(report.config_diagnosis.reason).toBe('no_url');
    expect(report.env.shadowed).toBe(false);
  }, 60_000);

  test('pglite config: engine pglite, config-file-path source, lock not held, exit 0', () => {
    writeConfig({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
    const { stdout, status } = run(['engine', 'status', '--json']);
    expect(status).toBe(0);
    const report = parseReport(stdout);
    expect(report.effective_engine).toBe('pglite');
    expect(report.config_file_engine).toBe('pglite');
    expect(report.db_url_source).toBe('config-file-path');
    expect(report.database_path).toBe(join(home, '.gbrain', 'brain.pglite'));
    expect(report.pglite_lock.held).toBe(false);
    expect(report.config_diagnosis).toBeUndefined();
  }, 60_000);

  test('env URL override: postgres wins over the pglite config file, URL redacted', () => {
    writeConfig({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
    const { stdout, status } = run(['engine', 'status', '--json'], {
      GBRAIN_DATABASE_URL: 'postgresql://u:p@localhost:59999/x',
    });
    expect(status).toBe(0);
    const report = parseReport(stdout);
    expect(report.effective_engine).toBe('postgres');
    expect(report.config_file_engine).toBe('pglite');
    expect(report.db_url_source).toBe('env:GBRAIN_DATABASE_URL');
    expect(report.database_url).toBe('postgresql://***@localhost:59999/x');
    // The password must never survive redaction, anywhere in the payload.
    expect(stdout).not.toContain(':p@');
    expect(stdout).not.toContain('u:p');
  }, 60_000);

  test('#427 shadow: cwd .env DATABASE_URL is excluded, env_shadowed diagnosis', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gbrain-shadow-cwd-'));
    try {
      const url = 'postgresql://u:p@localhost:5/x';
      writeFileSync(join(cwd, '.env'), `DATABASE_URL=${url}\n`);
      const { stdout, status } = run(['engine', 'status', '--json'], { DATABASE_URL: url }, cwd);
      expect(status).toBe(1);
      const report = parseReport(stdout);
      expect(report.env.shadowed).toBe(true);
      expect(report.config_diagnosis.reason).toBe('env_shadowed');
      expect(report.effective_engine).toBeNull();
      expect(report.env.note).toContain('#427');
      // The shadowed URL still shows up in the env block — redacted.
      expect(report.env.database_url).toBe('postgresql://***@localhost:5/x');
      expect(stdout).not.toContain(':p@');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test('--probe against a closed port: classified conn_refused, exit 1, no raw password', () => {
    const { stdout, status } = run(['engine', 'status', '--json', '--probe'], {
      GBRAIN_DATABASE_URL: 'postgresql://u:p@localhost:59987/x',
      GBRAIN_NO_RETRY_CONNECT: '1',
    });
    expect(status).toBe(1);
    const report = parseReport(stdout);
    expect(report.effective_engine).toBe('postgres');
    expect(report.probe.ok).toBe(false);
    expect(report.probe.diagnosis.reason).toBe('conn_refused');
    // Whole-output redaction sweep: neither the JSON nor any diagnosis text
    // may carry the raw credential.
    const whole = JSON.stringify(report);
    expect(whole).not.toContain(':p@');
    expect(whole).not.toContain('u:p');
    expect(stdout).not.toContain(':p@');
  }, 60_000);

  test('--probe with a MISSING pglite data dir: data_dir_missing, dir NOT created, exit 1', () => {
    // Read-only probe contract: PGLite CREATES a database at a missing path
    // on connect — a status probe against a typo'd/missing data dir must
    // report the misconfiguration, never materialize a junk store that
    // masks it.
    const missing = join(home, 'no-such-dir', 'brain.pglite');
    writeConfig({ engine: 'pglite', database_path: missing });
    const { stdout, status } = run(['engine', 'status', '--json', '--probe']);
    expect(status).toBe(1);
    const report = parseReport(stdout);
    expect(report.effective_engine).toBe('pglite');
    expect(report.probe.ok).toBe(false);
    expect(report.probe.note).toBe('data_dir_missing');
    // The store must not have been created by the probe.
    expect(existsSync(missing)).toBe(false);
  }, 60_000);

  test('unknown token reaching the command parser: exit 2', () => {
    // A bare token passes the CLI-level flag registry and hits
    // runEngineStatus's own parseArgs, which rejects with exit 2.
    const { status, stderr } = run(['engine', 'status', 'bogus']);
    expect(status).toBe(2);
    expect(stderr).toContain('Unknown flag for engine status');
  }, 60_000);

  test('unknown --flag: intercepted by the CLI flag registry before dispatch (exit 1)', () => {
    // Dash-prefixed unknown flags never reach runEngineStatus — the global
    // flag validation in cli.ts rejects them first with its own message.
    const { status, stderr } = run(['engine', 'status', '--bogus']);
    expect(status).toBe(1);
    expect(stderr).toContain('unknown flag --bogus');
  }, 60_000);
});
