import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { drainManagedSync } from '../src/core/persistence/sync-drain.ts';
import { readDrainHolder } from '../src/core/persistence/sync-lease.ts';
import { readGitHoldRetryPaths } from '../src/core/persistence/sync-holds.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

// #7327: a managed pass that only re-screens holds. A requested re-screen (`sources retry-held`) of more holds than one
// job's deadline covers used to restart from zero on every pass: the pass consumed the retry rows only after a whole
// batch drained, so each deadline stop left all of them due and the next pass re-screened every one again, writing no
// pass row meanwhile, so a follower judged the holder stalled. Both fail on the base.

const N = 240, STOP_AFTER = 60;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8' }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const holdCount = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM op_checkpoints WHERE op='sync-hold' AND fingerprint LIKE 'default:%'"))[0]!.n);

/** One pass that stops once it has screened `stopAfter` entries (a job deadline mid-batch), sampling the holder's progress. */
async function pass(engine: BrainEngine, stopAfter?: number) {
  const abort = new AbortController();
  let screened = 0;
  const samples: Array<Promise<string | null>> = [];
  const onProgress = (event: { phase: string }) => {
    if (event.phase !== 'managed_sync.page_committed') return;
    screened++;
    if (screened === 5 || screened === Math.floor((stopAfter ?? N) * 0.8)) samples.push(readDrainHolder(engine, 'default').then(holder => holder?.progress?.last_progress_at ?? null));
    if (stopAfter && screened >= stopAfter) abort.abort(new Error('job deadline'));
  };
  const result: SyncResult = await drainManagedSync(engine, { ...OPTS, signal: abort.signal, onProgress } as Parameters<typeof drainManagedSync>[1], false);
  return { result, progress: await Promise.all(samples) };
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`#7327 [${backend}]: a re-screen of held symlinks cut short by deadlines resumes, converges with its holds, and shows progress`, () => managedBrain(async ({ engine, root }) => {
    mkdirSync(join(root, 'linked'));
    for (let i = 0; i < N; i++) symlinkSync(`/nonexistent-other-checkout/x${i}.md`, join(root, `linked/s${i}.md`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'symlinks');
    expect((await pass(engine)).result.status).toBe('first_sync');
    expect(await holdCount(engine)).toBe(N);
    expect((await pass(engine)).result.status).toBe('up_to_date');

    expect((await retryHeld(engine, 'default')).scheduled).toBe(N);
    const candidates: number[] = [];
    let last: SyncResult | null = null;
    for (let i = 0; i < Math.ceil(N / STOP_AFTER) + 2; i++) {
      const { result, progress } = await pass(engine, STOP_AFTER);
      last = result;
      candidates.push(result.pass!.candidates);
      if (result.status === 'synced') break;
      expect(result.pass).toMatchObject({ kind: 'full', outcome: 'resumable', stop_reason: 'timeout' });
      // The holder's progress moves while it screens holds, so a follower never reads it as stalled.
      expect(progress).toHaveLength(2);
      expect(Date.parse(progress[1]!)).toBeGreaterThan(Date.parse(progress[0]!));
    }
    expect(candidates[0]).toBe(N);
    for (let i = 1; i < candidates.length; i++) expect(candidates[i]!).toBeLessThan(candidates[i - 1]!);
    expect(last?.status).toBe('synced');
    expect(await readGitHoldRetryPaths(engine, 'default', (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'"))[0]!.incarnation)).toEqual([]);
    expect(await holdCount(engine)).toBe(N);
    expect((await pass(engine)).result.status).toBe('up_to_date');
  }, { databaseUrl, setup: ({ root }) => {
    mkdirSync(join(root, 'notes')); git(root, 'init', '-q');
    writeFileSync(join(root, 'notes/a.md'), '---\ntype: concept\ntitle: A\n---\n\nAn observation about acme-example.\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init');
  } }), 300_000);
}
