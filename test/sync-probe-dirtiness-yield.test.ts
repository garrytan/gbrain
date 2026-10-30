/**
 * GBRA-133 PR 2b (search during a sync): a first sync's discovery dirtiness probe (sync-git-stream.ts `probeDirtiness`)
 * read and hashed each candidate file in one stretch of up to 64 files, because it asked the loop budget per entry
 * (`due()` reads the clock every 64 entries). A file read is not an entry's worth of work: at 10k pages the stretch held
 * timers for 1.2-1.3 s and every concurrent search waited. It now asks `over()`, the clock, before each file.
 *
 * Forced probe (deterministic): every file read costs 4 ms of thread CPU (a seam on `readSyncFile`), 64 files. Asked
 * per entry, the probe runs all 64 in one stretch (about 256 ms); asked per file, no stretch passes the bound.
 */
import { afterEach, expect, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as discovery from '../src/core/persistence/sync-discovery.ts';
import { probeDirtiness, readIndexLevel, readTreeLevel } from '../src/core/persistence/sync-git-stream.ts';
import { spinCpuMs, watchLoopLag } from './helpers/cpu-time.ts';
import { isolatedTest } from './helpers/isolated-test.ts';

const MAX_LAG_MS = 100;
const FILES = 64;
const READ_CPU_MS = 4;

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

isolatedTest(import.meta.path, 'the dirtiness probe yields between file reads; no stretch of reads passes the bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-probe-yield-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    mkdirSync(join(root, 'notes'), { recursive: true }); git('init', '-q');
    for (let i = 0; i < FILES; i++) writeFileSync(join(root, `notes/n${i}.md`), `---\ntitle: n${i}\n---\n\nNote ${i}.\n`);
    git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
    const head = git('rev-parse', 'HEAD');
    const tree = await readTreeLevel(root, head, '');
    const index = await readIndexLevel(root);
    const read = discovery.readSyncFile;
    let reads = 0;
    spies.push(spyOn(discovery, 'readSyncFile').mockImplementation(((...args: Parameters<typeof read>) => { reads++; spinCpuMs(READ_CPU_MS); return read(...args); }) as typeof read));
    const lag = watchLoopLag({ reportAtMs: MAX_LAG_MS });
    let probed: Awaited<ReturnType<typeof probeDirtiness>>, maxLag = 0;
    try { probed = await probeDirtiness(root, root, [...tree.keys()], tree, index); }
    finally { ({ maxLag } = lag.stop()); }
    expect(reads).toBe(FILES);
    expect(probed!.size).toBe(FILES);
    expect([...probed!.values()].every(probe => probe.dp === 'clean')).toBe(true);
    expect(Math.round(maxLag)).toBeLessThan(MAX_LAG_MS);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
