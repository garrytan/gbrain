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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ADDON_TARGET = detectAddonTarget();
const BUILT_ADDON = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${ADDON_TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = ADDON_TARGET !== null && existsSync(BUILT_ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT_ADDON} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

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

  test('a rust brain reports the installed addon from disk; a pglite brain has no rust_addon block and no engines dir', () => {
    writeConfig({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
    expect(parseReport(run(['engine', 'status', '--json']).stdout).rust_addon).toBeUndefined();
    writeConfig({ engine: 'rust', database_path: join(home, 'brain.rust') });
    const { stdout, status } = run(['engine', 'status', '--json'], { GBRAIN_RUST_ENGINE_ADDON: '' });
    expect(status).toBe(0);
    expect(parseReport(stdout).rust_addon).toMatchObject({
      target: ADDON_TARGET, override: false, installed: false, path: null, sha256: null, pinned_sha256: null,
    });
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
  }, 60_000);

  test('--probe on a rust brain whose addon is missing reports rust_engine_addon_missing, not an unclassified database error', () => {
    const store = join(home, 'brain.rust');
    writeConfig({ engine: 'rust', database_path: store });
    const { stdout, status } = run(['engine', 'status', '--json', '--probe'], { GBRAIN_RUST_ENGINE_ADDON: join(home, 'missing.node') });
    expect(status).toBe(1);
    const report = parseReport(stdout);
    expect(report.effective_engine).toBe('rust');
    expect(report.probe.ok).toBe(false);
    expect(report.probe.note).toBe('rust_engine_addon_missing');
    expect(report.probe.refusal).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'override_not_found' });
    expect(report.probe.diagnosis).toBeUndefined();
    expect(existsSync(store)).toBe(false);
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
  }, 60_000);

  withAddon('--probe with the built addon and a MISSING rust store: data_dir_missing, store NOT created, exit 1', () => {
    // Opening a Rust store creates it, like PGLite: the read-only probe must report the missing path, not make it.
    const missing = join(home, 'no-such-dir', 'brain.rust');
    writeConfig({ engine: 'rust', database_path: missing });
    const { stdout, status } = run(['engine', 'status', '--json', '--probe'], { GBRAIN_RUST_ENGINE_ADDON: BUILT_ADDON });
    expect(status).toBe(1);
    const report = parseReport(stdout);
    expect(report.effective_engine).toBe('rust');
    expect(report.probe).toEqual({ ok: false, note: 'data_dir_missing' });
    expect(existsSync(missing)).toBe(false);
  }, 60_000);

  withAddon('--probe with the built addon and an EMPTY directory as the rust store: data_dir_missing, no store files made', () => {
    const dir = join(home, 'empty-store');
    mkdirSync(dir);
    writeConfig({ engine: 'rust', database_path: dir });
    const { stdout, status } = run(['engine', 'status', '--json', '--probe'], { GBRAIN_RUST_ENGINE_ADDON: BUILT_ADDON });
    expect(status).toBe(1);
    expect(parseReport(stdout).probe).toEqual({ ok: false, note: 'data_dir_missing' });
    expect(existsSync(join(dir, 'records.redb'))).toBe(false);
    expect(existsSync(join(dir, 'FORMAT'))).toBe(false);
  }, 60_000);

  withAddon('--probe with the built addon and an EMPTY records.redb: store_incomplete, the file stays empty, no FORMAT', () => {
    // A first open that stopped early can leave a zero-length record file; opening it would set it up as a new brain.
    const dir = join(home, 'incomplete-store');
    mkdirSync(dir);
    writeFileSync(join(dir, 'records.redb'), '');
    writeConfig({ engine: 'rust', database_path: dir });
    const { stdout, status } = run(['engine', 'status', '--json', '--probe'], { GBRAIN_RUST_ENGINE_ADDON: BUILT_ADDON });
    expect(status).toBe(1);
    expect(parseReport(stdout).probe).toEqual({ ok: false, note: 'store_incomplete' });
    expect(statSync(join(dir, 'records.redb')).size).toBe(0);
    expect(existsSync(join(dir, 'FORMAT'))).toBe(false);
  }, 60_000);

  withAddon('--probe with the built addon and a nonempty records.redb but no FORMAT: store_incomplete, nothing written', () => {
    // A first open writes FORMAT last, so a record file without FORMAT may hold no brain metadata yet; opening it
    // would make a new brain. The probe reports it and leaves the record file byte for byte, with no FORMAT made.
    const store = join(home, 'brain.rust');
    writeConfig({ engine: 'rust', database_path: store });
    const init = run(['stats', '--json'], { GBRAIN_RUST_ENGINE_ADDON: BUILT_ADDON });
    expect(init.status).toBe(0);
    rmSync(join(store, 'FORMAT'));
    const before = readFileSync(join(store, 'records.redb'));
    expect(before.length).toBeGreaterThan(0);
    const { stdout, status } = run(['engine', 'status', '--json', '--probe'], { GBRAIN_RUST_ENGINE_ADDON: BUILT_ADDON });
    expect(status).toBe(1);
    expect(parseReport(stdout).probe).toEqual({ ok: false, note: 'store_incomplete' });
    expect(readFileSync(join(store, 'records.redb')).equals(before)).toBe(true);
    expect(existsSync(join(store, 'FORMAT'))).toBe(false);
  }, 60_000);

  withAddon('--probe with the built addon and an existing rust store: ok, through a typed read (no raw SQL refusal)', () => {
    const store = join(home, 'brain.rust');
    writeConfig({ engine: 'rust', database_path: store });
    // A first probe-free command opens and creates the store; the probe then reads it.
    const init = run(['stats', '--json'], { GBRAIN_RUST_ENGINE_ADDON: BUILT_ADDON });
    expect(init.status).toBe(0);
    expect(existsSync(store)).toBe(true);
    const { stdout, status } = run(['engine', 'status', '--json', '--probe'], { GBRAIN_RUST_ENGINE_ADDON: BUILT_ADDON });
    const report = parseReport(stdout);
    expect(report.probe.ok).toBe(true);
    expect(report.probe.refusal).toBeUndefined();
    expect(status).toBe(0);
  }, 60_000);

  test('unknown token reaching the command parser: exit 2', () => {
    // A bare token passes the CLI-level flag registry and hits
    // runEngineStatus's own parseArgs, which rejects with exit 2.
    const { status, stderr } = run(['engine', 'status', 'bogus']);
    expect(status).toBe(2);
    expect(stderr).toContain('Unknown flag for engine status');
  }, 60_000);

  test('unknown --flag: intercepted by the CLI flag registry before dispatch (exit 2, usage)', () => {
    // Dash-prefixed unknown flags never reach runEngineStatus — the global
    // flag validation in cli.ts rejects them first with its own message.
    const { status, stderr } = run(['engine', 'status', '--bogus']);
    expect(status).toBe(2);
    expect(stderr).toContain('unknown flag --bogus');
  }, 60_000);
});
