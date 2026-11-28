import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = join(import.meta.dir, '../..');
const GUARD = join(repo, 'scripts/check-weight-coverage.ts');

/** A guard root with `files` (paths named as `*.test.ts`, written as fixtures) and the four weight maps. */
function run(files: string[], maps: Record<string, Record<string, number>>, event?: string) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-weight-coverage-'));
  try {
    const put = (path: string, body: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    for (const file of files) put(file.replace(/\.test\.ts$/, '.test.fixture.ts'), '// fixture\n');
    for (const map of ['scripts/test-weights.json', 'scripts/serial-weights.json', 'scripts/e2e-weights.json', 'scripts/ubicloud/weights.json']) {
      put(map, JSON.stringify(maps[map] ?? {}));
    }
    const summary = join(root, 'summary.md');
    const env: Record<string, string> = { ...process.env as Record<string, string>, GBRAIN_GUARD_ROOT: root, GITHUB_STEP_SUMMARY: summary };
    delete env.GITHUB_EVENT_NAME;
    if (event) env.GITHUB_EVENT_NAME = event;
    const result = spawnSync(process.execPath, ['--no-env-file', GUARD], { encoding: 'utf8', env });
    let written = '';
    try { written = readFileSync(summary, 'utf8'); } catch {}
    return { ...result, summary: written };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const unit = Array.from({ length: 20 }, (_, i) => `test/u${i}.test.ts`);
const weighted = Object.fromEntries(unit.map(f => [f, 1]));

describe('check-weight-coverage', () => {
  test('a fully weighted tree passes on every event', () => {
    for (const event of [undefined, 'pull_request', 'push', 'schedule']) {
      const r = run(unit, { 'scripts/test-weights.json': weighted }, event);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('check-weight-coverage: OK');
    }
  });

  test('an entry naming a deleted file fails on a pull request and names the fix', () => {
    const r = run(unit, { 'scripts/test-weights.json': { ...weighted, 'test/deleted.test.ts': 5 } }, 'pull_request');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('scripts/test-weights.json: 1 entry names a file that no longer exists');
    expect(r.stderr).toContain('test/deleted.test.ts');
    expect(r.stderr).toContain('Fix: delete that entry from scripts/test-weights.json');
    expect(r.stderr).toContain('Docs: docs/TESTING.md#keeping-ci-partitions-balanced');
  });

  test('a dead ubicloud entry fails', () => {
    const r = run(unit, { 'scripts/test-weights.json': weighted, 'scripts/ubicloud/weights.json': { 'serial:test/gone.serial.test.ts': 1 } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('serial:test/gone.serial.test.ts');
  });

  test('an unweighted share above the bound warns on pull requests with the miner command', () => {
    const partial = Object.fromEntries(unit.slice(0, 18).map(f => [f, 1]));
    const r = run(unit, { 'scripts/test-weights.json': partial }, 'pull_request');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('unit: 2 of 20 files (10.0%) have no weight in scripts/test-weights.json, above the 5% bound');
    expect(r.stdout).toContain('Fix: bun run weights:mine --lane unit --latest 5 --coverage-only');
    expect(r.summary).toContain('Shard weight coverage');
  });

  test('the same share fails the scheduled run', () => {
    const partial = Object.fromEntries(unit.slice(0, 18).map(f => [f, 1]));
    const r = run(unit, { 'scripts/test-weights.json': partial }, 'schedule');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unit: 2 of 20 files (10.0%)');
  });

  test('serial and E2E use a 10% bound and the full-profile E2E miner', () => {
    const serial = Array.from({ length: 10 }, (_, i) => `test/s${i}.serial.test.ts`);
    const e2e = Array.from({ length: 10 }, (_, i) => `test/e2e/e${i}.test.ts`);
    const maps = {
      'scripts/test-weights.json': weighted,
      'scripts/serial-weights.json': Object.fromEntries(serial.slice(1).map(f => [f, 1])),
      'scripts/e2e-weights.json': Object.fromEntries(e2e.slice(2).map(f => [f, 1])),
    };
    const r = run([...unit, ...serial, ...e2e], maps, 'schedule');
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('serial:');
    expect(r.stderr).toContain('e2e: 2 of 10 files (20.0%)');
    expect(r.stderr).toContain('--lane e2e --e2e-profile full --run');
  });

  test('the committed weight maps name only existing files', () => {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    delete env.GITHUB_EVENT_NAME;
    delete env.GBRAIN_GUARD_ROOT;
    delete env.GITHUB_STEP_SUMMARY;
    const r = spawnSync(process.execPath, ['--no-env-file', GUARD], { encoding: 'utf8', env, cwd: repo });
    expect(r.status, r.stderr).toBe(0);
  });
});
