/**
 * scripts/ci-typecheck.sh runs test.yml's tsc step. When tsc aborts (exit
 * above 128: V8's heap-limit abort is 134), it deletes the restored
 * tsbuildinfo and runs once more from cold. Every other status, a type error
 * (1 or 2) above all, ends the step at once with no retry. These cases pin
 * the retry to aborts only, and keep an aborted or timed-out run from saving
 * its stale state.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'ci-typecheck.sh');
const BUILDINFO = 'node_modules/.cache/gbrain-typecheck.tsbuildinfo';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A stand-in for `bun run typecheck`: logs whether the buildinfo was present,
// then ends the way the next line of $FIXTURE_PLAN says: an exit code, a
// signal name (the process kills itself with it), or "hang".
const FAKE_TSC = String.raw`#!/usr/bin/env bash
n=$(( $(wc -l < "$FIXTURE_LOG") + 1 ))
if [ -f node_modules/.cache/gbrain-typecheck.tsbuildinfo ]; then echo warm >> "$FIXTURE_LOG"; else echo cold >> "$FIXTURE_LOG"; fi
step=$(sed -n "$n"p "$FIXTURE_PLAN")
case "$step" in
  ABRT|KILL) kill -s "$step" $$ ;;
  hang) sleep 30 ;;
  *) exit "$step" ;;
esac
`;

function run(plan: string[], seconds = '20') {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-ci-typecheck-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/.cache'), { recursive: true });
  writeFileSync(join(root, BUILDINFO), 'restored from another head');
  writeFileSync(join(root, 'tsc'), FAKE_TSC);
  chmodSync(join(root, 'tsc'), 0o755);
  writeFileSync(join(root, 'plan'), plan.join('\n') + '\n');
  writeFileSync(join(root, 'log'), '');
  writeFileSync(join(root, 'output'), '');
  const r = Bun.spawnSync(['bash', SCRIPT, join(root, 'tsc')], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      FIXTURE_PLAN: join(root, 'plan'),
      FIXTURE_LOG: join(root, 'log'),
      GITHUB_OUTPUT: join(root, 'output'),
      GBRAIN_TYPECHECK_ATTEMPT_SECONDS: seconds,
    },
  });
  return {
    status: r.exitCode,
    stdout: r.stdout.toString(),
    attempts: readFileSync(join(root, 'log'), 'utf8').split('\n').filter(Boolean),
    output: readFileSync(join(root, 'output'), 'utf8').trim(),
    buildinfoLeft: existsSync(join(root, BUILDINFO)),
  };
}

describe('scripts/ci-typecheck.sh', () => {
  test('a clean incremental run is one attempt and saves its state', () => {
    const r = run(['0']);
    expect(r).toMatchObject({ status: 0, attempts: ['warm'], output: 'state_written=true', buildinfoLeft: true });
  });

  test('a type error (tsc exit 1 or 2) fails at once, with no retry, and saves its state', () => {
    for (const code of ['1', '2']) {
      const r = run([code, '0']);
      expect(r).toMatchObject({ status: Number(code), attempts: ['warm'], output: 'state_written=true', buildinfoLeft: true });
      expect(r.stdout).not.toContain('typecheck aborted');
    }
  });

  test('no exit status from 1 to 128 is retried', () => {
    for (const code of ['3', '64', '127', '128']) {
      expect(run([code, '0']).attempts).toEqual(['warm']);
    }
  });

  test('an abort (exit 134) deletes the restored buildinfo and runs once more from cold', () => {
    const r = run(['134', '0']);
    expect(r).toMatchObject({ status: 0, attempts: ['warm', 'cold'], output: 'state_written=true' });
    expect(r.stdout).toContain('::warning title=typecheck aborted::');
  });

  test('a death by signal is an abort too', () => {
    for (const signal of ['ABRT', 'KILL']) {
      const r = run([signal, '0']);
      expect(r).toMatchObject({ status: 0, attempts: ['warm', 'cold'] });
    }
  });

  test('a type error on the cold run fails the step, and nothing runs a third time', () => {
    const r = run(['134', '2', '0']);
    expect(r).toMatchObject({ status: 2, attempts: ['warm', 'cold'], output: 'state_written=true' });
  });

  test('a second abort fails the step after two attempts and saves nothing', () => {
    const r = run(['134', '134', '0']);
    expect(r).toMatchObject({ status: 134, attempts: ['warm', 'cold'], output: 'state_written=false' });
    expect(r.stdout).toContain('::error title=typecheck aborted twice::');
  });

  test('an attempt past its time limit is not retried and saves nothing', () => {
    const r = run(['hang', '0'], '1');
    expect(r).toMatchObject({ status: 124, attempts: ['warm'], output: 'state_written=false', buildinfoLeft: true });
  });
});
