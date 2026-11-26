/**
 * The Rust multi-user access self-check lane (scripts/ci-rust-multiuser-selfcheck.sh, run by
 * .github/workflows/rust-multiuser-selfcheck.yml) is the evidence that admits keys other than the brain owner's
 * (design note M2, ruling A1). It must run every parity file of its shard even after one fails, and it must go red
 * on a failed file, on any access_self_check_mismatch and on any fence_missing, so a green run means the whole suite
 * ran clean. The workflow must run it on every push to the multi-user trunk, for both shards, with the mode on.
 *
 * The script is driven with a fake runner: each fixture file holds its exit code on the first line and the output to
 * print after it, so a case seeds a mismatch, a fence_missing or a failure without running the parity suite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'ci-rust-multiuser-selfcheck.sh');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'rust-multiuser-selfcheck.yml');
let dir: string;
let runner: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-selfcheck-lane-'));
  runner = join(dir, 'runner.sh');
  writeFileSync(runner, '#!/usr/bin/env bash\ncode=$(head -n 1 "$1")\ntail -n +2 "$1"\nexit "$code"\n');
  chmodSync(runner, 0o755);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** Writes fixture files (name -> [exit code, output]) and runs one shard over them in that order. */
function run(fixtures: Array<[string, number, string]>, shard = 1, shards = 1) {
  const files = fixtures.map(([name, code, out]) => {
    const path = join(dir, `${name}.fixture`);
    writeFileSync(path, `${code}\n${out}\n`);
    return path;
  });
  const log = join(dir, `log-${shard}-${Math.random().toString(36).slice(2)}.txt`);
  const r = spawnSync('bash', [SCRIPT, String(shard), String(shards)], {
    cwd: ROOT, encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', SELFCHECK_FILES: files.join('\n'), SELFCHECK_RUNNER: runner, SELFCHECK_LOG: log },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, log: readFileSync(log, 'utf8') };
}

describe('the self-check lane script', () => {
  test('a clean shard is green and says how many files it ran', () => {
    const r = run([['a', 0, 'file-a ran'], ['b', 0, 'file-b ran'], ['c', 0, 'file-c ran']], 1, 2);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ran 2 of 3 files');
    expect(r.log).toContain('file-a ran');
    expect(r.log).toContain('file-c ran');
    expect(r.log).not.toContain('file-b ran');
  });

  test('a failed file does not stop the shard: every later file runs, and the run is red naming the failure', () => {
    const r = run([['first-red', 1, 'first-red ran'], ['later', 0, 'later ran'], ['last', 0, 'last ran']]);
    expect(r.status).toBe(1);
    expect(r.log).toContain('later ran');
    expect(r.log).toContain('last ran');
    expect(r.out).toContain('ran 3 of 3 files');
    expect(r.out).toContain('first-red.fixture');
  });

  test('a mismatch after a failed file is still found and named', () => {
    const r = run([['red', 1, 'red ran'], ['seeded', 0, 'error: access_self_check_mismatch member=getPage']]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('access_self_check_mismatch');
    expect(r.out).toContain('seeded.fixture');
  });

  test('a seeded mismatch in a file that passes turns the run red', () => {
    const r = run([['ok', 0, 'ok ran'], ['seeded', 0, 'access_self_check_mismatch member=listPages']]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('seeded.fixture');
  });

  test('a fence_missing in a file that passes turns the run red', () => {
    const r = run([['ok', 0, 'ok ran'], ['fence', 0, 'refused: fence_missing for listFacts']]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('fence_missing');
    expect(r.out).toContain('fence.fixture');
  });

  test('the two shards together run every file exactly once', () => {
    const fixtures = Array.from({ length: 7 }, (_, i) => [`f${i}`, 0, `marker-f${i}`] as [string, number, string]);
    const logs = [run(fixtures, 1, 2).log, run(fixtures, 2, 2).log].join('\n');
    for (let i = 0; i < 7; i++) expect(logs.split(`marker-f${i}`).length - 1).toBe(1);
  });
});

describe('the self-check workflow', () => {
  const wf = yaml.load(readFileSync(WORKFLOW, 'utf8')) as {
    on: { push?: { branches?: string[]; paths?: unknown; 'paths-ignore'?: unknown } };
    jobs: Record<string, { 'timeout-minutes'?: number; strategy?: { matrix?: { shard?: number[] } }; steps: Array<{ name?: string; run?: string; env?: Record<string, string>; if?: string }> }>;
  };
  const job = wf.jobs.parity!;

  test('runs on every push to the multi-user trunk, with no path filter that could skip one', () => {
    expect(Object.keys(wf.on)).toEqual(['push']);
    expect(wf.on.push?.branches).toEqual(['rust-engine/multiuser']);
    expect(wf.on.push?.paths).toBeUndefined();
    expect(wf.on.push?.['paths-ignore']).toBeUndefined();
  });

  test('runs the lane script on both shards with the mode on, after the mode proof', () => {
    expect(job.strategy?.matrix?.shard).toEqual([1, 2]);
    const names = job.steps.map(s => s.name ?? '');
    const proof = job.steps.findIndex(s => (s.run ?? '').includes('test/rust-access-selfcheck-mode.serial.test.ts'));
    const lane = job.steps.findIndex(s => (s.run ?? '').includes('scripts/ci-rust-multiuser-selfcheck.sh'));
    expect({ proof: proof >= 0, lane: lane >= 0, order: proof < lane }).toEqual({ proof: true, lane: true, order: true });
    expect(job.steps[lane]!.if).toBeUndefined();
    expect(job.steps[lane]!.run).toContain('"$SHARD" "$SHARDS"');
    expect(job.steps[lane]!.env).toMatchObject({
      GBRAIN_TEST_KEEP_AMBIENT_ENV: '1', GBRAIN_RUST_MULTIUSER: '1', GBRAIN_RUST_ACCESS_SELF_CHECK: '1',
      GBRAIN_TEST_RUST_ADDON_REQUIRED: '1', GBRAIN_TEST_RUST_ARM: '1', SHARDS: '2',
    });
    expect(names.length).toBeGreaterThan(0);
  });

  test('gives a shard time to run its whole half of the suite', () => {
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(90);
  });
});
