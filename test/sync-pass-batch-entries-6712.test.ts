/**
 * GBRA-133 PR 2b (search during a sync): a pass's batch build (sync-pass-run.ts `batchEntries`) counted each import
 * winner's same-blob twins by filtering every new origin, once per winner: quadratic in a first sync's new files (at 10k,
 * about 10^8 compares and a 1.1-1.4 s stretch that held every concurrent search). Twins are counted once per blob now,
 * and a moved page is looked up by blob instead of by a scan of the leaving pages.
 *
 * Forced probe: a first sync of ${PATHS} new files sharing one blob (each has every other as a twin). The stretch from the
 * batch build's start to the first freeze is timed on the thread's CPU; the run is aborted there, so nothing is imported.
 *
 * Its linear work still ran as one stretch with no timer turn: about 62 ms of thread CPU on a dev box and 98-125 ms on a
 * loaded 16-vCPU CI VM, against the 100 ms bound. Its loops now yield as a level's own loops do (sync-yield.ts). The second
 * probe makes each new file's slug cost SLUG_CPU_MS of CPU, so a build that does not yield holds timers well past the
 * bound on any machine (451 ms here before the fix).
 */
import { afterEach, describe, expect, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import * as syncCore from '../src/core/sync.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { watchLoopLag } from './helpers/cpu-time.ts';
import { isolatedTest } from './helpers/isolated-test.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const PATHS = 8_000;
const MAX_LAG_MS = 100;
const SLUG_CPU_MS = 0.05;

const git = (root: string, args: string[], input?: string) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 26 }).trim();
const setup = ({ root }: { root: string }) => {
  git(root, ['init', '-q']);
  const blob = git(root, ['hash-object', '-w', '--stdin'], '---\ntitle: Note\n---\n\nSynthetic note.\n');
  const lines: string[] = [];
  for (let i = 0; i < PATHS; i++) lines.push(`100644 ${blob}\tnotes/d${i % 100}/note-${i}.md`);
  git(root, ['update-index', '--add', '--index-info'], lines.join('\n') + '\n');
  git(root, ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'many notes']);
};

afterEach(() => installFaultHook(undefined));

describe('GBRA-133 PR 2b: a first sync builds its batch in linear time', () => {
  /** The most thread CPU the sync ran between two timer turns, from the batch build's start to the first freeze. */
  const batchBuildLag = async (engine: BrainEngine, inWindow: () => boolean = () => false) => {
    let lag: ReturnType<typeof watchLoopLag> | undefined, maxLag: number | undefined;
    const stop = new AbortController();
    window.open = false;
    installFaultHook(async point => {
      if (point === 'sync:batch_entries' && !lag) { lag = watchLoopLag(); window.open = inWindow(); }
      if (point === 'sync:after_freeze' && lag && maxLag === undefined) { window.open = false; maxLag = lag.stop().maxLag; stop.abort(); }
    });
    await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, signal: stop.signal }).catch(() => undefined);
    installFaultHook(undefined);
    window.open = false;
    if (lag && maxLag === undefined) lag.stop();
    return maxLag;
  };
  const window = { open: false };

  isolatedTest(import.meta.path, `the batch build of ${PATHS} new same-blob files never blocks a timer for ${MAX_LAG_MS} ms`, () => managedBrain(async ({ engine }) => {
    const maxLag = await batchBuildLag(engine);
    expect(maxLag).toBeDefined();
    expect(Math.round(maxLag!)).toBeLessThan(MAX_LAG_MS);
  }, { setup }), 300_000);

  isolatedTest(import.meta.path, `with ${SLUG_CPU_MS} ms of CPU per new file's slug, the batch build still yields within ${MAX_LAG_MS} ms`, () => managedBrain(async ({ engine }) => {
    const resolve = syncCore.resolveSlugForPath;
    let slowed = 0;
    const spy = spyOn(syncCore, 'resolveSlugForPath').mockImplementation(((...args: Parameters<typeof resolve>) => {
      // A wall-clock spin: thread CPU advances in ~4 ms steps on some hosts, too coarse for a per-call cost.
      if (window.open) { slowed++; const end = performance.now() + SLUG_CPU_MS; while (performance.now() < end) { /* the slug's cost */ } }
      return resolve(...args);
    }) as typeof resolve);
    try {
      const maxLag = await batchBuildLag(engine, () => true);
      expect(slowed).toBeGreaterThanOrEqual(PATHS);
      expect(maxLag).toBeDefined();
      expect(Math.round(maxLag!)).toBeLessThan(MAX_LAG_MS);
    } finally { spy.mockRestore(); }
  }, { setup }), 300_000);
});
