/**
 * test/postgres-unit-arms.txt is the one list persistence-validation's
 * unit-postgres-arms job, the race hunt and the lane guard read. Its shards
 * must cover every row exactly once, and the weight miner must read the
 * job's per-file group timestamps.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mineArmWeights, parseArmsList, readArmsList } from '../../scripts/postgres-unit-arms.ts';

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
});
