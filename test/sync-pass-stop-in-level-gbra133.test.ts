/**
 * GBRA-133 (600k soak): a managed pass whose job deadline passed, or whose drain lease lapsed, kept reading and classifying
 * the whole level (including its Git history walk) before it looked at either: a 30 s first slice stopped at 215 s, and a
 * pass that lost its lease ran on for minutes. The level read now checks the pass is still active at every pause of its
 * loops and while the origin history walk runs, so it stops at the next pause; the walk itself keeps running for the next
 * pass to join or reuse.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { __resetHistoryIndexesForTest } from '../src/core/persistence/sync-origin-evidence.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { loopYield, progressYield, whileActive } from '../src/core/persistence/sync-yield.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, args: string[], input?: string) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
const page = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\nA note about ${title}.\n`;
const stop = (flag: { stopped: boolean }) => () => { if (flag.stopped) throw new DOMException('stopped', 'AbortError'); };

describe('GBRA-133: a stopped pass stops its level read', () => {
  test('progressYield checks the pass at every pause', async () => {
    const flag = { stopped: false };
    const step = progressYield(loopYield(), { assertActive: stop(flag) });
    await step.pause();
    flag.stopped = true;
    await expect(step.pause()).rejects.toThrow('stopped');
  });

  test('whileActive ends with the stop while the work keeps running, and returns the work when the pass stays active', async () => {
    const flag = { stopped: false };
    let finished = false;
    const work = Bun.sleep(400).then(() => { finished = true; return 'evidence'; });
    const started = performance.now();
    setTimeout(() => { flag.stopped = true; }, 50);
    await expect(whileActive(work, stop(flag), 20)).rejects.toThrow('stopped');
    expect(performance.now() - started).toBeLessThan(300);
    expect(finished).toBe(false);
    expect(await work).toBe('evidence');
    expect(await whileActive(Bun.sleep(30).then(() => 'kept'), stop({ stopped: false }), 10)).toBe('kept');
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`GBRA-133 [${backend}]: a pass stopped while its level is read never finishes the read`, () => managedBrain(async ({ engine, root }) => {
    const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
    expect((await performManagedSync(engine, OPTS)).status).toMatch(/^(first_sync|synced)$/);
    // A file the page lost: the next level read walks the history for its origin evidence.
    unlinkSync(join(root, 'b.md')); git(root, ['commit', '-qam', 'remove b']);
    __resetHistoryIndexesForTest();
    const controller = new AbortController();
    const points: string[] = [];
    installFaultHook(async point => {
      points.push(point);
      if (point === 'sync:round_start') controller.abort(new DOMException('deadline', 'AbortError'));
    });
    const result = await performManagedSync(engine, { ...OPTS, signal: controller.signal }).catch(error => error).finally(() => installFaultHook(undefined));
    expect(points).toContain('sync:round_start');
    expect(points).not.toContain('sync:level_read');
    expect(result instanceof Error ? result.name : result.status).toMatch(/^(AbortError|partial)$/);
  }, { databaseUrl, setup: ({ root }) => {
    git(root, ['init', '-q']);
    for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.md`), page(name));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'pages']);
  } }), 120_000);
}
