/**
 * The served Rust parity set (multi-user lane L3): test/engine-parity/rust-served-set.tsv names the parity files that
 * pass on the Rust arm as a served client of a brain server, and scripts/run-rust-served-set.sh runs exactly that set.
 * The multi-user trunk gates every merge on it, so the manifest must stay a true list and the runner must run all of it.
 *
 * 1. Protects: the manifest is sorted, unique, names only parity files that exist, and every row out of the set says
 *    why; the runner runs exactly the `served` rows, every one even after a failure, in the route it was given, and is
 *    red on a failed file, on a file whose output does not show the multi-user arm in that route, and on a missing file.
 * 2. Fails on: a manifest row for a deleted or misspelled file, an unexplained exclusion, a runner that stops at the
 *    first failure, skips rows, ignores the route, or passes a file that ran with multi-user mode off.
 * 3. Seams: the runner is driven with a fake runner (each fixture holds its exit code on the first line and the output
 *    after it), so the cases run no parity file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'run-rust-served-set.sh');
const MANIFEST = join(ROOT, 'test', 'engine-parity', 'rust-served-set.tsv');

type Row = { file: string; status: string; reason: string };
const rows: Row[] = readFileSync(MANIFEST, 'utf8').split('\n')
  .filter(line => line !== '' && !line.startsWith('#') && !line.startsWith('file\t'))
  .map(line => { const [file = '', status = '', reason = ''] = line.split('\t'); return { file, status, reason }; });

describe('the served Rust parity set manifest', () => {
  test('rows are sorted (byte order) and unique, with a status of served or excluded', () => {
    const files = rows.map(r => r.file);
    expect(files).toEqual([...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(files).size).toBe(files.length);
    expect(rows.filter(r => r.status !== 'served' && r.status !== 'excluded')).toEqual([]);
  });

  test('every row names a parity file that exists', () => {
    expect(rows.filter(r => !/^test\/engine-parity\/[^/]+\.test\.ts$/.test(r.file) || !existsSync(join(ROOT, r.file))).map(r => r.file)).toEqual([]);
  });

  test('every excluded row names its reason; a served row carries none', () => {
    expect(rows.filter(r => r.status === 'excluded' && r.reason.trim().length < 10).map(r => r.file)).toEqual([]);
    expect(rows.filter(r => r.status === 'served' && r.reason !== '').map(r => r.file)).toEqual([]);
  });

  test('the runner lists exactly the served rows', () => {
    const r = spawnSync('bash', [SCRIPT, '--list'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(rows.filter(x => x.status === 'served').map(x => x.file));
    expect(rows.filter(x => x.status === 'served').length).toBeGreaterThan(0);
  });
});

describe('the served set runner', () => {
  let dir: string;
  let runner: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-served-set-'));
    runner = join(dir, 'runner.sh');
    // Prints the routing env it saw, then the fixture's output, and exits with the fixture's code.
    writeFileSync(runner, '#!/usr/bin/env bash\necho "env served=$GBRAIN_TEST_RUST_SERVED route=$GBRAIN_TEST_RUST_MU_ARM arm=$GBRAIN_TEST_RUST_ARM"\ncode=$(head -n 1 "$1")\ntail -n +2 "$1"\nexit "$code"\n');
    chmodSync(runner, 0o755);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Writes fixtures (name, exit code, output) and a manifest listing them (plus `extra` rows), then runs one route. */
  function run(route: string, fixtures: Array<[string, number, string]>, extra: string[] = []) {
    const lines = fixtures.map(([name, code, out]) => {
      const path = join(dir, `${name}.fixture`);
      writeFileSync(path, `${code}\n${out}\n`);
      return `${path}\tserved\t`;
    });
    const manifest = join(dir, `manifest-${Math.random().toString(36).slice(2)}.tsv`);
    writeFileSync(manifest, ['# fixture', 'file\tstatus\treason', ...lines, ...extra].join('\n') + '\n');
    const logDir = join(dir, `logs-${Math.random().toString(36).slice(2)}`);
    const r = spawnSync('bash', [SCRIPT, route], { cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, RUST_SERVED_SET_MANIFEST: manifest, RUST_SERVED_SET_RUNNER: runner, RUST_SERVED_SET_JOBS: '2', RUST_SERVED_SET_LOG_DIR: logDir } });
    const summary = readFileSync(join(logDir, 'summary.tsv'), 'utf8').split('\n').filter(Boolean).map(l => l.split('\t')).sort();
    return { status: r.status, out: r.stdout + r.stderr, summary, logDir };
  }

  test('green when every file passes in the given route; the route reaches each file', () => {
    const r = run('config', [['a', 0, '[rust-mu-config arm] a: 3 equal'], ['b', 0, '[rust-mu-config arm] b: 1 equal']]);
    expect(r.status).toBe(0);
    expect(r.summary.map(([, rc, mode]) => `${rc}/${mode}`)).toEqual(['0/yes', '0/yes']);
    expect(r.out).toContain('ran 2 of 2 files, 0 red');
    expect(readFileSync(join(r.logDir, `${join(dir, 'a.fixture').replace(/\//g, '_')}.log`), 'utf8')).toContain('env served=1 route=config arm=1');
  });

  test('a failed file is red, and every later file still runs', () => {
    const r = run('env', [['c', 1, '[rust-mu-env arm] c: 0 equal'], ['d', 0, '[rust-mu-env arm] d: 2 equal'], ['e', 0, '[rust-mu-env arm] e: 1 equal']]);
    expect(r.status).toBe(1);
    expect(r.summary.length).toBe(3);
    expect(r.out).toContain('failed on the env route');
  });

  test('a file that passed without the multi-user arm of its route is red', () => {
    const r = run('env', [['f', 0, '[rust arm] f: 2 equal'], ['g', 0, '[rust-mu-config arm] g: 2 equal']]);
    expect(r.status).toBe(1);
    expect(r.summary.map(([, , mode]) => mode)).toEqual(['no', 'no']);
  });

  test('a missing file is red; excluded rows never run', () => {
    const r = run('env', [['h', 0, '[rust-mu-env arm] h: 1 equal']], [`${join(dir, 'gone.fixture')}\tserved\t`, `${join(dir, 'skipped.fixture')}\texcluded\tnamed reason for the test`]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('does not exist');
    expect(r.summary.length).toBe(2);
  });

  test('a route other than env or config is refused', () => {
    expect(spawnSync('bash', [SCRIPT, 'pglite'], { cwd: ROOT, encoding: 'utf8' }).status).toBe(2);
  });
});
