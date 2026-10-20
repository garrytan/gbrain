/**
 * scripts/test-shard-pack.sh runs UNIT_SHARDS_PER_JOB unit shards at once on
 * one test.yml runner. Each shard must keep its own coverage dir, receipt dir,
 * timing capture and console, the shards must really run concurrently, and
 * the job must fail when any shard fails.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A stand-in for scripts/test-shard.sh: writes into the dirs it was handed,
// then waits until every shard of the pack has started (so a sequential run
// fails with 97), and exits with FIXTURE_EXIT_<shard>.
const FAKE_SHARD = String.raw`#!/usr/bin/env bash
set -euo pipefail
s=$1
mkdir -p "$COVERAGE_DIR" "$GBRAIN_TEST_RECEIPT_DIR"
echo "lane shard-$s" > "$COVERAGE_DIR/lane-manifest.json"
echo "receipt $s of $2" > "$GBRAIN_TEST_RECEIPT_DIR/unit.receipt"
echo "start $s"
touch "$FIXTURE_SYNC/$s"
for _ in $(seq 1 200); do
  [ "$(ls "$FIXTURE_SYNC" | wc -l)" -ge "$FIXTURE_EXPECT" ] && break
  sleep 0.05
done
[ "$(ls "$FIXTURE_SYNC" | wc -l)" -ge "$FIXTURE_EXPECT" ] || { echo "shard $s ran alone"; exit 97; }
echo "middle $s"
sleep 0.1
echo "end $s"
exit "$(printenv "FIXTURE_EXIT_$s" || echo 0)"
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-shard-pack-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  for (const file of ['scripts/test-shard-pack.sh', 'scripts/capture-test-log.ts']) copyFileSync(join(REPO, file), join(root, file));
  writeFileSync(join(root, 'scripts/test-shard.sh'), FAKE_SHARD);
  chmodSync(join(root, 'scripts/test-shard.sh'), 0o755);
  mkdirSync(join(root, 'sync'));
  return root;
}

function pack(root: string, args: string[], env: Record<string, string> = {}) {
  const out = join(root, 'out');
  const r = Bun.spawnSync(['bash', join(root, 'scripts/test-shard-pack.sh'), ...args], {
    cwd: root,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      GBRAIN_SHARD_PACK_DIR: out,
      FIXTURE_SYNC: join(root, 'sync'),
      FIXTURE_EXPECT: String(args.length - 1),
      ...env,
    },
    timeout: 30_000,
  });
  return { out, code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe('scripts/test-shard-pack.sh', () => {
  test('runs the shards at once, each with its own coverage, receipts, timing capture and console', () => {
    const root = fixture();
    const r = pack(root, ['18', '3', '4']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    for (const s of ['3', '4']) {
      expect(readFileSync(join(r.out, s, 'coverage/lane-manifest.json'), 'utf8')).toBe(`lane shard-${s}\n`);
      expect(readFileSync(join(r.out, s, 'receipts/unit.receipt'), 'utf8')).toBe(`receipt ${s} of 18\n`);
      const capture = readFileSync(join(r.out, s, 'unit.log'), 'utf8').trimEnd().split('\n');
      expect(capture.every(line => line.startsWith(`test (${s})\tcapture\t`))).toBe(true);
      expect(capture.at(-1)).toEndWith('##[gbrain-capture-complete] exit=0');
      const block = `=== unit shard ${s}/18 exited 0 ===\nstart ${s}\nmiddle ${s}\nend ${s}\n=== end of unit shard ${s}/18 ===\n`;
      expect(r.stdout).toContain(block);
    }
    expect(r.stdout).not.toContain('::error');
  });

  test('fails with the first failing shard\'s code, names it, and still lets the other shard finish', () => {
    const root = fixture();
    const r = pack(root, ['18', '5', '6'], { FIXTURE_EXIT_6: '3' });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('=== unit shard 5/18 exited 0 ===');
    expect(r.stdout).toContain('=== unit shard 6/18 exited 3 ===');
    expect(r.stdout).toContain('::error title=unit shard 6/18 failed::exit 3; reproduce with: bash scripts/test-shard.sh 6 18');
    expect(r.stdout).not.toContain('unit shard 5/18 failed');
    expect(readFileSync(join(r.out, '5', 'unit.log'), 'utf8').trimEnd()).toEndWith('##[gbrain-capture-complete] exit=0');
    expect(existsSync(join(r.out, '6', 'receipts/unit.receipt'))).toBe(true);
  });

  test('every failing shard gets its own error line', () => {
    const root = fixture();
    const r = pack(root, ['18', '7', '8'], { FIXTURE_EXIT_7: '1', FIXTURE_EXIT_8: '1' });
    expect(r.code).toBe(1);
    for (const s of ['7', '8']) expect(r.stdout).toContain(`::error title=unit shard ${s}/18 failed::`);
  });

  test('refuses a shard outside the partition and a missing output directory', () => {
    const root = fixture();
    const outside = pack(root, ['18', '18', '19']);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain('shard index 19 out of range 1..18');
    const noDir = pack(root, ['18', '1', '2'], { GBRAIN_SHARD_PACK_DIR: '' });
    expect(noDir.code).not.toBe(0);
    expect(noDir.stderr).toContain('GBRAIN_SHARD_PACK_DIR');
  });
});
