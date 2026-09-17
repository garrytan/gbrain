/**
 * Regression test (b): scripts/run-unit-shard.sh exclusion symmetry.
 *
 * Pins the contract that the local fast-loop unit-shard script:
 *   1. EXCLUDES *.slow.test.ts (those run via scripts/run-slow-tests.sh).
 *   2. EXCLUDES *.serial.test.ts (those run via scripts/run-serial-tests.sh
 *      after the parallel pass).
 *   3. Includes plain *.test.ts files (the fast-loop unit set).
 *
 * Without this guard, a future refactor that drops one of the `-not -name`
 * clauses from the find expression would cause slow OR serial files to
 * run inside the parallel pass — silently undoing the quarantine and
 * re-introducing the contention flakes that motivated v0.26.4.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(): string[] {
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

describe('run-unit-shard.sh exclusion symmetry', () => {
  it('lists at least one plain *.test.ts file', () => {
    const files = dryRunList();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => /\.test\.ts$/.test(f) && !/\.(slow|serial)\.test\.ts$/.test(f))).toBe(true);
  });

  it('excludes every *.slow.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.slow\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes every *.serial.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.serial\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes the test/e2e/ subtree', () => {
    const files = dryRunList();
    const leaks = files.filter(f => f.startsWith('test/e2e/'));
    expect(leaks).toEqual([]);
  });
});

describe('run-unit-shard.sh timeout multiplier reach', () => {
  // GBRAIN_TEST_TIMEOUT_MULTIPLIER scales bun's `--timeout`, which only sets
  // the DEFAULT per-test ceiling — an explicit `test(name, fn, N)` third
  // argument overrides it and stays fixed under 4-way container contention.
  // Files that spawn the CLI through test/helpers/cli-spawn.ts are the ones
  // the multiplier exists for (a full `bun src/cli.ts` boot, often a PGLite
  // cold start), and cli-spawn's own kill timer already reaps a hung child,
  // so a hand-pinned ceiling below the runner default only hides the file
  // from the multiplier (#4659). Pins at/above the default are left alone.
  it('cli-spawn consumers pin no per-test timeout below the bunfig default', () => {
    const bunfig = readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf-8');
    const defaultMs = Number(/^timeout\s*=\s*([\d_]+)/m.exec(bunfig)![1].replace(/_/g, ''));
    const offenders: string[] = [];
    for (const file of dryRunList()) {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
      if (!src.includes('helpers/cli-spawn')) continue;
      // Trailing numeric literal (>= 4 digits) as a call's last argument.
      for (const m of src.matchAll(/,\s*(\d[\d_]{3,})\s*\)\s*;/g)) {
        const ms = Number(m[1].replace(/_/g, ''));
        if (ms < defaultMs) offenders.push(`${file}: ${m[0].trim()} (< ${defaultMs})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Exercise the real shell runner; fake only the expensive Bun test process. */
function runGroupedFixture(count: number, mode = 'pass', shard = '') {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-unit-groups-test-'));
  try {
    for (const dir of ['scripts', 'test', 'bin', 'calls']) mkdirSync(join(root, dir));
    copyFileSync(SHARD_SH, join(root, 'scripts/run-unit-shard.sh'));
    const files = Array.from({ length: count }, (_, i) => `test/case-${String(i).padStart(4, '0')}.test.ts`);
    for (const file of files) writeFileSync(join(root, file), '');
    for (const file of ['ignored.slow.test.ts', 'ignored.serial.test.ts']) writeFileSync(join(root, 'test', file), '');
    const fake = join(root, 'bin/bun');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
if [ "$1" = scripts/sharding.ts ]; then
  awk 'NR % 2 == 1'
  exit 0
fi
n=1
[ ! -f "$FAKE_CALLS/count" ] || n=$(( $(cat "$FAKE_CALLS/count") + 1 ))
echo "$n" > "$FAKE_CALLS/count"
printf '%s\\0' "$@" > "$FAKE_CALLS/$n.args"
printf '%s\\n' "\${DATABASE_URL-unset}" "\${GBRAIN_DATABASE_URL-unset}" "\${GBRAIN_HOME-unset}" "\${SHARD-unset}" "\${GBRAIN_PGLITE_SNAPSHOT-unset}" > "$FAKE_CALLS/$n.env"
files=()
for arg in "$@"; do case "$arg" in test/*.test.ts) files+=("$arg");; esac; done
if [ "$FAKE_MODE" = nested-summary ]; then
  printf ' 999 pass\\n 0 fail\\nRan 999 tests across 1 file. [1ms]\\n'
fi
for ((i=0; i<\${#files[@]}; i++)); do
  if [ "$FAKE_MODE" = missing-header ] && [ "$n" = 2 ] && [ "$i" = 0 ]; then continue; fi
  printf '%s:\\n' "\${files[i]}"
done
if [ "$n" = 2 ]; then
  [ "$FAKE_MODE" != crash-middle ] || exit 137
  [ "$FAKE_MODE" != missing-summary ] || exit 0
fi
failed=0
if [ "$FAKE_MODE" = fail-middle ] && [ "$n" = 2 ]; then failed=1; fi
passed=$(( \${#files[@]} - failed ))
reported=\${#files[@]}
if [ "$FAKE_MODE" = wrong-count ] && [ "$n" = 2 ]; then reported=$((reported - 1)); fi
printf '\\033[32m %s pass\\033[0m\\n %s fail\\nRan %s tests across %s files. [1ms]\\n' "$passed" "$failed" "\${#files[@]}" "$reported"
exit "$failed"
`);
    chmodSync(fake, 0o755);
    const result = spawnSync('bash', [join(root, 'scripts/run-unit-shard.sh'), '--max-concurrency', '3'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_CALLS: join(root, 'calls'), FAKE_MODE: mode,
        SHARD: shard, GBRAIN_TEST_TIMEOUT_MULTIPLIER: '2', GBRAIN_PGLITE_SNAPSHOT: '/example/schema-snapshot.tar',
        DATABASE_URL: 'postgres://example.invalid/test', GBRAIN_DATABASE_URL: 'postgres://example.invalid/test', GBRAIN_HOME: '/example/private-home' },
    });
    const calls = readdirSync(join(root, 'calls')).filter(f => f.endsWith('.args')).sort((a, b) => parseInt(a) - parseInt(b)).map(file => ({
      args: readFileSync(join(root, 'calls', file), 'utf8').split('\0').filter(Boolean),
      env: readFileSync(join(root, 'calls', file.replace('.args', '.env')), 'utf8').trim().split('\n'),
    }));
    return { ...result, calls, files, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('run-unit-shard.sh bounded processes', () => {
  for (const count of [1, 2, 3]) {
    it(`executes the exact ordered ${count}-file inventory with one Bun process per file`, () => {
      const result = runGroupedFixture(count);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.calls.map(c => c.args.length - 3)).toEqual(count === 1 ? [1] : count === 2 ? [1, 1] : [1, 1, 1]);
      expect(result.calls.flatMap(c => c.args.slice(3))).toEqual(result.files);
      expect(result.output).toContain(`files=${count} pass=${count} fail=0 skip=0 rc=0`);
    });
  }

  it('preserves selected order, timeout/concurrency flags and safe routing on every process', () => {
    const result = runGroupedFixture(3, 'pass', '1/2');
    expect(result.status).toBe(0);
    expect(result.calls.flatMap(c => c.args.slice(3))).toEqual(result.files.filter((_, i) => i % 2 === 0));
    for (const call of result.calls) {
      expect(call.args.slice(0, 3)).toEqual(['test', '--max-concurrency=3', '--timeout=120000']);
      expect(call.env).toEqual(['unset', 'unset', 'unset', 'unset', '/example/schema-snapshot.tar']);
    }
  });

  it('continues after a middle-group test failure and retains the failure in its aggregate', () => {
    const result = runGroupedFixture(3, 'fail-middle');
    expect(result.status).toBe(1);
    expect(result.calls.flatMap(c => c.args.slice(3))).toEqual(result.files);
    expect(result.output).toContain('groups=3 complete_groups=3 files=3 pass=2 fail=1 skip=0 rc=1');
  });

  for (const mode of ['crash-middle', 'missing-summary', 'wrong-count', 'missing-header']) {
    it(`fails closed for ${mode}, attempts later files, and never invents missing results`, () => {
      const result = runGroupedFixture(3, mode);
      expect(result.status).toBe(1);
      expect(result.calls.flatMap(c => c.args.slice(3))).toEqual(result.files);
      expect(result.output).toContain('groups=3 complete_groups=2 files=3 pass=2 fail=0 skip=0 rc=1');
      expect(result.output).toContain('group 2/3 incomplete');
      if (mode === 'crash-middle') expect(result.output).toContain('bun_rc=137');
    });
  }

  it('uses final group summaries and the parent aggregate without double-counting child Bun output', () => {
    const result = runGroupedFixture(2, 'nested-summary');
    expect(result.status).toBe(0);
    expect(result.output).toContain('groups=2 complete_groups=2 files=2 pass=2 fail=0 skip=0 rc=0');
    const parent = readFileSync(join(REPO_ROOT, 'scripts/run-unit-parallel.sh'), 'utf8');
    const countFunction = parent.slice(parent.indexOf('bun_summary_count() {'), parent.indexOf('# shard_total_files:'));
    const root = mkdtempSync(join(tmpdir(), 'gbrain-unit-counts-test-'));
    try {
      const log = join(root, 'shard.log');
      writeFileSync(log, result.output);
      const out = execFileSync('bash', ['-c', `strip_ansi() { sed 's/\x1b\\[[0-9;]*[a-zA-Z]//g' "$1"; }\n${countFunction}\nbun_summary_count pass "$1"`, 'count-test', log], { encoding: 'utf8' });
      expect(out.trim()).toBe('2');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps grouped crashes and absent final aggregates out of the parent exit-hang warn-pass lane', () => {
    const result = runGroupedFixture(3, 'missing-summary');
    const parent = readFileSync(join(REPO_ROOT, 'scripts/run-unit-parallel.sh'), 'utf8');
    const gate = parent.slice(parent.indexOf('    grouped_incomplete=0'), parent.indexOf('    if [ "$grouped_incomplete" = "0" ]'));
    expect(gate).not.toBe('');
    const root = mkdtempSync(join(tmpdir(), 'gbrain-unit-completion-test-'));
    try {
      for (const logText of [result.output, result.output.replace(/^__gbrain_unit_shard__.*\n/gm, '')]) {
        const log = join(root, 'shard.log');
        writeFileSync(log, logText);
        const out = execFileSync('bash', ['-c', `SHARD_LOG="$1"\n${gate}\nprintf '%s' "$grouped_incomplete"`, 'gate-test', log], { encoding: 'utf8' });
        expect(out).toBe('1');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
