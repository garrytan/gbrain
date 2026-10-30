/**
 * #6712 PR 4b: a level's Git reads and its `I⋈P` read share one loop budget (sync-yield.ts `turnYield`). The two reads
 * overlap, and each used to yield on its own clock only, so a Git chunk and a fetch result could run back to back in one
 * turn: at #6858 shape and 5 ms RTT that held timers for 116-138 ms. With one budget, work that finds the turn already
 * spent waits a turn first.
 *
 * Forced probe (deterministic): the first `I⋈P` result waits at `sync:level_result` until the index read's first chunk
 * is being visited, which the seam makes a 60 ms stretch of Git work (`sync:level_chunk`), so the result resumes in that
 * chunk's turn; its take then costs 60 ms (`sync:level_take`). One budget: the take waits a turn, so no stretch passes
 * the bound. Each read on its own budget, the take runs right after the chunk, about 120 ms.
 *
 * PGLite here (its keyset read takes the same turn); Postgres through test/e2e/sync-pass-shared-budget-6712-postgres.test.ts.
 *
 * Forced probe (deterministic, no database): a Git read whose every chunk waits a turn still returns every record. Bun
 * closes the stream before a held chunk settles, so a read that did not wait for its last chunk returned the index
 * without it, and a delta sync froze a deletion of a committed file (page_identity_changed).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readIndexLevel } from '../src/core/persistence/sync-git-stream.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { spinCpuMs, watchLoopLag } from './helpers/cpu-time.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

/** The ruling's bound on a stretch that keeps timers from running (test/sync-pass-loop-lag-6712.test.ts). */
const MAX_LAG_MS = 100;
/** Each side's forced stretch: under the bound alone, over it back to back. */
const STRETCH_MS = 60;
const NOTES = 40;

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < NOTES; i++) writeFileSync(join(root, `notes/n${i}.md`), `---\ntype: concept\ntitle: notes/n${i}\n---\n\nNote ${i}.\n`);
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
};

afterEach(() => installFaultHook(undefined));

test('a Git read whose chunks each wait a turn returns every record before it resolves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-shared-budget-'));
  try {
    setup({ root });
    const shared = { due: () => false, over: () => true, pause: () => new Promise<void>(resolve => setTimeout(resolve, 30)) };
    expect((await readIndexLevel(root, shared)).size).toBe(NOTES);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;

  describe(`#6712 PR 4b: a level's Git and I⋈P reads share one loop budget (${backend})`, () => {
    test('a fetch result that lands in a Git chunk\'s turn waits a turn before its take; no stretch passes the bound', () => managedBrain(async ({ engine }) => {
      expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
      // The consumer the sync started is not part of the level: its timer's query would run in the turn the take resumes in.
      await disposePersistenceConsumer(engine);
      const context = await resolveManagedSyncContext(engine, { sourceId: 'default', noPull: true, dryRun: true });
      let open: () => void = () => {};
      const chunk = new Promise<void>(resolve => { open = resolve; });
      const seen = { chunk: false, result: false, take: false };
      installFaultHook(async (point, detail) => {
        if (point === 'sync:level_chunk' && detail.read === 'ls-files' && !seen.chunk) { seen.chunk = true; open(); spinCpuMs(STRETCH_MS); }
        if (point === 'sync:level_result' && !seen.result) { seen.result = true; await Promise.race([chunk, new Promise(resolve => setTimeout(resolve, 10_000))]); }
        if (point === 'sync:level_take' && !seen.take) { seen.take = true; spinCpuMs(STRETCH_MS); }
      });
      // Lag as the thread's own CPU between timer runs: the stretches the read holds, not what a loaded VM adds.
      let level: Awaited<ReturnType<typeof readShadowLevel>>;
      let maxLag = 0;
      const lag = watchLoopLag({ reportAtMs: MAX_LAG_MS });
      try {
        level = await readShadowLevel(engine, { sourceId: 'default', context });
      } finally {
        maxLag = lag.stop().maxLag;
        installFaultHook(undefined);
      }
      expect(seen).toEqual({ chunk: true, result: true, take: true });
      expect(level!.paths.length).toBe(NOTES);
      expect(Math.round(maxLag)).toBeGreaterThanOrEqual(STRETCH_MS - 5);
      expect(Math.round(maxLag)).toBeLessThan(MAX_LAG_MS);
    }, { ...(databaseUrl ? { databaseUrl } : {}), setup }), 120_000);
  });
}
