/**
 * test/postgres-unit-arms.txt is the one list persistence-validation's
 * unit-postgres-arms job, the race hunt and the lane guard read. Its shards
 * must cover every row exactly once, each shard's two workers must finish
 * inside the step, and the weight miner must read the runner's per-file
 * durations.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARM_SHARD_BUDGET_MS, ARM_SHARDS, ARM_STEP_TIMEOUT_MS, ARM_TEST_COMMAND, ARM_WORKERS,
  armMakespan, armShards, armWeights, mineArmWeights, parseArmsList, readArmsList,
} from '../../scripts/postgres-unit-arms.ts';
import { computeQuantile } from '../../scripts/sharding.ts';

const REPO = join(import.meta.dir, '..', '..');
const cli = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts', 'postgres-unit-arms.ts'), ...args], { encoding: 'utf8', cwd: REPO });

describe('postgres-unit-arms list', () => {
  test('the committed list parses cleanly', () => {
    const list = readArmsList(REPO);
    expect(list.errors).toEqual([]);
    expect(list.files.length).toBeGreaterThan(50);
  });

  test('the two CI shards cover every listed file exactly once', () => {
    const all = cli('list').stdout.trim().split('\n');
    const shards = [1, 2].map(n => cli('shard', String(n), '2').stdout.trim().split('\n'));
    expect([...shards[0]!, ...shards[1]!].sort()).toEqual([...all].sort());
    expect(shards[0]!.filter(f => shards[1]!.includes(f))).toEqual([]);
    expect(shards.every(s => s.length > 0)).toBe(true);
  });

  test('the workflow runs ARM_SHARDS shards of ARM_WORKERS workers, each with its own PostgreSQL service, inside the ARM_STEP_TIMEOUT_MS step timeout', () => {
    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'persistence-validation.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('  unit-postgres-arms:'), workflow.indexOf('\n  invariants:'));
    const shards = Array.from({ length: ARM_SHARDS }, (_, i) => i + 1);
    expect(job).toContain(`shard: [${shards.join(', ')}]`);
    expect(job).toContain(`Unit-lane PostgreSQL arms \${{ matrix.shard }}/${ARM_SHARDS}`);
    expect(job).toContain(`run: bun scripts/postgres-unit-arms.ts run \${{ matrix.shard }} ${ARM_SHARDS}\n`);
    expect(job).toMatch(new RegExp(`- name: Require PostgreSQL arms of unit-lane suites\\n\\s+timeout-minutes: ${ARM_STEP_TIMEOUT_MS / 60_000}\\n`));
    const ports = [...job.matchAll(/ports: \['(\d+):5432'\]/g)].map(m => m[1]);
    const urls = [...job.matchAll(/postgres:\/\/gbrain_test:gbrain_test@127\.0\.0\.1:(\d+)\/gbrain_test/g)].map(m => m[1]);
    expect(ports.length).toBe(ARM_WORKERS);
    expect(new Set(ports).size).toBe(ARM_WORKERS);
    expect(urls).toEqual(ports);
  });

  test('every CI shard\'s two-worker makespan fits the step twice over, with a minute to spare, in both arm modes', () => {
    const files = readArmsList(REPO).files;
    expect(2 * ARM_SHARD_BUDGET_MS + 60_000).toBe(ARM_STEP_TIMEOUT_MS);
    for (const postgresOnly of [false, true]) {
      const weights = armWeights(REPO, postgresOnly);
      const p75 = computeQuantile(files.filter(f => weights.has(f)).map(f => weights.get(f)!), 0.75);
      const makespans = armShards(REPO, files, ARM_SHARDS, postgresOnly).map(shard => armMakespan(shard, f => weights.get(f) ?? p75));
      expect({ postgresOnly, over: makespans.filter(ms => ms > ARM_SHARD_BUDGET_MS).map(Math.round) }).toEqual({ postgresOnly, over: [] });
    }
  });

  test('the job runs both arms: the unit shards skip *.slow.test.ts, so it is the only GitHub lane for the PGLite side of listed slow suites', () => {
    const slow = readArmsList(REPO).files.filter(f => f.endsWith('.slow.test.ts'));
    expect(slow.length).toBeGreaterThan(0);
    expect(readFileSync(join(REPO, 'scripts', 'run-unit-shard.sh'), 'utf8')).toContain("-not -name '*.slow.test.ts'");
    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'persistence-validation.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('  unit-postgres-arms:'), workflow.indexOf('\n  invariants:'));
    expect(job).not.toContain('--postgres-only');
  });

  test('a shard\'s makespan is the busiest worker when each takes the next heaviest file as it frees up', () => {
    const w: Record<string, number> = { 'test/a.test.ts': 50, 'test/b.test.ts': 40, 'test/c.test.ts': 30, 'test/d.test.ts': 20, 'test/e.test.ts': 10 };
    expect(armMakespan(Object.keys(w), f => w[f]!, 2)).toBe(80);
    expect(armMakespan(Object.keys(w), f => w[f]!, 1)).toBe(150);
  });

  test('no listed file is machine-exclusive: two files share each runner', () => {
    const exclusive = spawnSync('bash', ['scripts/run-serial-tests.sh', '--dry-run-list-exclusive'], { encoding: 'utf8', cwd: REPO }).stdout.trim().split('\n').filter(Boolean);
    expect(exclusive.length).toBeGreaterThan(0);
    expect(readArmsList(REPO).files.filter(f => exclusive.includes(f))).toEqual([]);
  });

  test('ci:ubicloud\'s pg-arms lane runs each file with the workflow runner\'s own command', () => {
    const command = ARM_TEST_COMMAND.join(' ');
    expect(command).toBe('bun --no-env-file test --timeout=120000');
    const item = readFileSync(join(REPO, 'scripts', 'ubicloud', 'ci-item.sh'), 'utf8');
    const lane = item.slice(item.indexOf('    pg-arms)'), item.indexOf(';;', item.indexOf('    pg-arms)')));
    expect(lane).toContain(`${command} "$1"`);
    expect(lane).toContain('GBRAIN_TEST_ALLOW_DATABASE_URL=1');
    expect(lane).toContain('-u GBRAIN_TEST_TIMEOUT_MULTIPLIER');
  });

  test('comments and blank lines are ignored; a new path is a one-line edit', () => {
    expect(parseArmsList('# header\n\ntest/a.test.ts\ntest/b/c.serial.test.ts\n')).toEqual({ files: ['test/a.test.ts', 'test/b/c.serial.test.ts'], errors: [] });
  });

  test('a bad shard request prints usage', () => {
    const r = cli('shard', '3', '2');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: bun scripts/postgres-unit-arms.ts shard <n> <m>');
  });

  test('the miner measures each file from its group to the next group or endgroup', () => {
    const log = [
      '2026-10-05T18:44:13.0000000Z ##[group]test/a.test.ts',
      '2026-10-05T18:44:13.0100000Z ##[group]test/a.test.ts:',
      '2026-10-05T18:44:20.0000000Z (pass) a',
      '2026-10-05T18:44:23.0000000Z ##[group]test/b.serial.test.ts',
      '2026-10-05T18:44:24.5000000Z ##[endgroup]',
    ].join('\n');
    expect(Object.fromEntries(mineArmWeights([log]))).toEqual({ 'test/a.test.ts': 10000, 'test/b.serial.test.ts': 1500 });
  });

  test('a log with ARM_FILE lines is mined from those alone, since its groups print at flush time', () => {
    const log = [
      '2026-10-05T18:50:00.0000000Z ##[group]test/a.test.ts',
      '2026-10-05T18:50:00.0100000Z (pass) a',
      '2026-10-05T18:50:00.0200000Z ARM_FILE file=test/a.test.ts worker=0 ms=41000 rc=0',
      '2026-10-05T18:50:00.0300000Z ##[endgroup]',
      '2026-10-05T18:50:00.0400000Z ##[group]test/b.serial.test.ts',
      '2026-10-05T18:50:00.0500000Z ARM_FILE file=test/b.serial.test.ts worker=1 ms=7500 rc=1',
      '2026-10-05T18:50:00.0600000Z ##[endgroup]',
    ].join('\n');
    expect(Object.fromEntries(mineArmWeights([log]))).toEqual({ 'test/a.test.ts': 41000, 'test/b.serial.test.ts': 7500 });
  });

  test('a file timed in several logs weighs its median, so one slow runner does not set it', () => {
    const log = (seconds: number) => [
      `2026-10-05T18:44:00.0000000Z ##[group]test/a.test.ts`,
      `2026-10-05T18:44:${String(seconds).padStart(2, '0')}.0000000Z ##[endgroup]`,
    ].join('\n');
    expect(mineArmWeights([log(10), log(50), log(12)]).get('test/a.test.ts')).toBe(12000);
    expect(mineArmWeights([log(10), log(50), log(12), log(14)]).get('test/a.test.ts')).toBe(13000);
  });
});

describe('postgres-unit-arms run', () => {
  /** A copy of the runner in a scratch repo whose listed files only report what they saw and sleep. */
  function scratchRepo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-arms-run-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    for (const name of ['postgres-unit-arms.ts', 'sharding.ts']) copyFileSync(join(REPO, 'scripts', name), join(root, 'scripts', name));
    writeFileSync(join(root, 'scripts', 'postgres-arm-weights.json'), JSON.stringify(Object.fromEntries(Object.keys(files).map((f, i) => [f, 1000 * (i + 1)]))));
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test', 'postgres-unit-arms.txt'), `${Object.keys(files).sort().join('\n')}\n`);
    for (const [file, body] of Object.entries(files)) writeFileSync(join(root, file), body);
    return root;
  }
  const probe = (name: string, extra = '') => `import { test, expect } from 'bun:test';
test('${name}', async () => {
  console.log('saw ' + JSON.stringify({ url: process.env.DATABASE_URL, backend: process.env.GBRAIN_TEST_BACKEND ?? '', receipts: process.env.GBRAIN_TEST_RECEIPT_DIR ?? '' }));
  await Bun.sleep(1500);
  ${extra}
});
`;

  test('two workers run files at once against their own URLs, print each file whole in queue order and write a receipt per file', () => {
    const root = scratchRepo({
      'test/a.test.ts': probe('a'),
      'test/b.test.ts': probe('b'),
      'test/c.serial.test.ts': probe('c', "expect('c').toBe('fails');"),
    });
    try {
      const receipts = join(root, 'receipts');
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [join(root, 'scripts', 'postgres-unit-arms.ts'), 'run', '1', '1', '--postgres-only'], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, GBRAIN_ARM_DATABASE_URLS: 'postgres://one/db postgres://two/db', GBRAIN_TEST_RECEIPT_DIR: receipts, GBRAIN_TEST_RECEIPT_LANE: 'pg-arms-bun-test', GITHUB_SHA: 'abc' },
      });
      const wall = Date.now() - t0;
      expect(r.status).toBe(1);
      const groups = [...r.stdout.matchAll(/::group::(\S+)\n([\s\S]*?)ARM_FILE file=(\S+) worker=(\d) ms=(\d+) rc=(\d+)\n::endgroup::/g)];
      expect(groups.map(g => g[1])).toEqual(['test/c.serial.test.ts', 'test/b.test.ts', 'test/a.test.ts']);
      expect(groups.every(g => g[1] === g[3])).toBe(true);
      expect(groups.map(g => g[6])).toEqual(['1', '0', '0']);
      const saw = groups.map(g => JSON.parse(/saw (\{.*\})/.exec(g[2]!)![1]!));
      expect(new Set(saw.map(s => s.url))).toEqual(new Set(['postgres://one/db', 'postgres://two/db']));
      expect(saw.map(s => s.url)).toEqual(groups.map(g => (g[4] === '0' ? 'postgres://one/db' : 'postgres://two/db')));
      expect(saw.every(s => s.backend === 'postgres' && s.receipts === '')).toBe(true);
      expect(wall).toBeLessThan(groups.reduce((ms, g) => ms + Number(g[5]), 0));
      expect(r.stdout).toContain('::error file=test/c.serial.test.ts::PostgreSQL arm failed. Reproduce: DATABASE_URL=<pgvector test database> GBRAIN_TEST_ALLOW_DATABASE_URL=1 GBRAIN_TEST_BACKEND=postgres bun --no-env-file test --timeout=120000 test/c.serial.test.ts');
      const ids = readdirSync(receipts).filter(n => n.endsWith('.receipt')).map(n => n.slice(0, -'.receipt'.length)).sort();
      expect(ids).toEqual(['pg-arms-bun-test--s1-a.test--primary', 'pg-arms-bun-test--s1-b.test--primary', 'pg-arms-bun-test--s1-c.serial.test--primary']);
      for (const id of ids) {
        const meta = readFileSync(join(receipts, `${id}.receipt`), 'utf8');
        expect(meta).toContain('lane=pg-arms-bun-test\n');
        expect(meta).toContain('shard=1\nof=1\narm=postgres\n');
        expect(meta).toMatch(/\nexit=[01]\n$/);
        expect(readFileSync(join(receipts, `${id}.files`), 'utf8').trim().split('\n')).toHaveLength(1);
        expect(readFileSync(join(receipts, `${id}.junit.xml`), 'utf8')).toContain('<testcase');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('without --postgres-only the files keep both arms, and no URL is a usage error', () => {
    const root = scratchRepo({ 'test/a.test.ts': probe('a') });
    try {
      const run = (urls: string) => spawnSync(process.execPath, [join(root, 'scripts', 'postgres-unit-arms.ts'), 'run', '1', '1'], { cwd: root, encoding: 'utf8', env: { ...process.env, GBRAIN_ARM_DATABASE_URLS: urls, GBRAIN_TEST_BACKEND: '' } });
      const ok = run('postgres://one/db');
      expect(ok.status).toBe(0);
      expect(JSON.parse(/saw (\{.*\})/.exec(ok.stdout)![1]!).backend).toBe('');
      const none = run('');
      expect(none.status).toBe(2);
      expect(none.stderr).toContain('GBRAIN_ARM_DATABASE_URLS is empty');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
