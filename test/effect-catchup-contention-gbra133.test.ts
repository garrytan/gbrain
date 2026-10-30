/**
 * GBRA-133: a catch-up of Git effects could never finish while writers in other processes took turns on the canonical
 * worktree. Every take of the native lock is a poll, so a process that gives the lock back and takes it again at once
 * won every race against an effect worker that tried once per claim; thousands of effects cycled on `writer_busy`
 * (retried every 250 ms, never parked) and none committed.
 *
 * Now a waiting effect worker leaves a marker other processes yield to after a grace (worktree-lease.ts), `writer_busy`
 * backs off per busy streak (effect-journal.ts `retryBusyEffect`), and doctor `parked_effects` and writer status name a
 * backlog that has waited over 10 minutes (effect-catchup.ts).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { readStalledCatchups } from '../src/core/persistence/effect-catchup.ts';
import { checkParkedEffects } from '../src/commands/doctor/checks/parked-effects.ts';
import { bindSource, createGitCoalescingFixture, effectSql, gitStates, harden, pass, pauseGitEffects, release, seed } from './helpers/git-coalescing-fixture.ts';

const { makeRepo, withBrain, dispose } = createGitCoalescingFixture('catchup');
afterAll(dispose);

const busyRows = (engine: BrainEngine) => engine.executeRaw<{ state: string; error_code: string | null; busy_retries: number | null; busy_since: string | null; wait_ms: number }>(
  `SELECT state,error_code,(data->>'busy_retries')::int AS busy_retries,data->>'busy_since' AS busy_since,
     GREATEST(0, EXTRACT(EPOCH FROM (next_attempt_at-now()))*1000)::int AS wait_ms FROM persistence_effects WHERE kind='git' ORDER BY id`);

/** Starts the contender in another process and resolves once it holds the lock for the first time. */
async function contend(engine: BrainEngine, home: string, source: string) {
  const binding = await getWorktreeBinding(engine, source, localHostId());
  const stop = join(home, 'contender.stop'), stats = join(home, 'contender.json');
  const child = spawn(process.execPath, [join(import.meta.dir, 'fixtures', 'worktree-contender.ts'), JSON.stringify(binding), stop, stats],
    { env: { ...process.env, GBRAIN_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
    child.on('exit', code => reject(new Error(`the contender exited (${code}) before it held the lock`)));
  });
  return async () => {
    writeFileSync(stop, '');
    await new Promise(resolve => child.exitCode === null ? child.on('exit', resolve) : resolve(null));
    return existsSync(stats) ? JSON.parse(readFileSync(stats, 'utf8')) as { held: number; refused: number } : { held: 0, refused: 0 };
  };
}

describe('GBRA-133 Git effect catch-up under cross-process worktree contention', () => {
  test('a catch-up finishes while another process keeps taking the worktree lock, and that process keeps getting turns', () => withBrain('pglite', async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), 150));
    const stop = await contend(engine, home, 'default');
    let stats: { held: number; refused: number };
    const deadline = Date.now() + 60_000;
    try {
      while (Date.now() < deadline && (await gitStates(engine)).committed !== 150) { await release(engine); await pass(engine); }
    } finally { stats = await stop(); }
    expect(await gitStates(engine)).toEqual({ committed: 150 });
    expect(repo.pushes()).toBeGreaterThan(0);
    // The other writer was held back only for the effect worker's turns, never shut out.
    expect(stats.held).toBeGreaterThan(5);
  }), 180_000);

  test('writer_busy backs off per busy streak, records when the streak began, and a stalled backlog is named', () => withBrain('pglite', async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    await pauseGitEffects(engine, () => seed(ctx('default'), 3));
    // The contender stops yielding: it holds the lock for good, so every effect pass is refused.
    const binding = await getWorktreeBinding(engine, 'default', localHostId());
    const { acquireNativeLock } = await import('../src/core/persistence/native-lock.ts');
    const held = (await acquireNativeLock(binding!.coordination_path!, { timeoutMs: 5_000 }))!;
    try {
      const waits: number[] = [];
      let firstSince: Array<string | null> = [];
      for (let round = 1; round <= 3; round++) {
        await release(engine);
        const started = Date.now();
        await pass(engine);
        // One pass waits for a busy root once, not once per effect group.
        expect(Date.now() - started).toBeLessThan(15_000);
        const rows = await busyRows(engine);
        expect(rows.every(row => row.state === 'queued' && row.error_code === 'writer_busy' && row.busy_retries === round)).toBe(true);
        waits.push(Math.max(...rows.map(row => row.wait_ms)));
        if (round === 1) firstSince = rows.map(row => row.busy_since);
      }
      expect(waits[1]).toBeGreaterThan(waits[0]!);
      expect(waits[2]).toBeGreaterThan(waits[1]!);
      // Each effect's streak keeps the instant it began.
      expect((await busyRows(engine)).map(row => row.busy_since)).toEqual(firstSince);
      expect(firstSince.every(since => since !== null)).toBe(true);
      expect(await readStalledCatchups(engine)).toEqual([]);

      // The streak began 11 minutes ago: the backlog is not progressing.
      await effectSql(engine, `UPDATE persistence_effects SET data=data||jsonb_build_object('busy_since', (now()-interval '11 minutes')::text) WHERE kind='git'`);
      expect(await readStalledCatchups(engine)).toMatchObject([{ source_id: 'default', stalled_effects: 3, busy_effects: 3, busy_retries: 3,
        fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json'] } }]);
      const doctor = await checkParkedEffects(engine);
      expect(doctor.status).toBe('warn');
      expect(doctor.message).toContain('Catch-up not progressing: default 3 effect(s) have waited on a busy canonical worktree');
      expect(doctor.details).toMatchObject({ parked_effects: 0, stalled_catchups: [{ source_id: 'default', stalled_effects: 3 }] });
    } finally { await held.release(); }

    // Once the worktree is free the backlog commits and its busy streak no longer counts. The committed effects keep no busy
    // bookkeeping: an effect's data is part of its request's receipt bytes, which must not depend on how often it met contention.
    await release(engine);
    await pass(engine);
    expect(await gitStates(engine)).toEqual({ committed: 3 });
    expect(await readStalledCatchups(engine)).toEqual([]);
    expect(await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE kind='git' AND (data ? 'busy_retries' OR data ? 'busy_since' OR data ? 'busy_at')")).toEqual([{ n: 0 }]);
  }), 180_000);
});
