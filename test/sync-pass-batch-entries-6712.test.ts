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
 *
 * GBRA-135: CI still saw 116 ms on the second probe. The loops' budget counted only loop work, but the batch's
 * legacy-identity and slug-holder reads run on this thread under PGLite (8-25 ms each here at 8k new files), and the drain
 * freezes the first entry right after the batch returns (about 26 ms of CPU: it reads its blob window). A loop's last
 * stretch ran on through the next read, and the batch's last stretch through the first freeze: 55-62 ms here before the
 * fix, 32-48 ms after. Each read and the hand-off now start on a timer turn of their own. The third probe checks each seam
 * for that turn; it fails at all three seams before the fix, and at each one alone when only its pause is removed.
 */
import { afterEach, describe, expect, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import * as syncCore from '../src/core/sync.ts';
import * as syncDiscovery from '../src/core/persistence/sync-discovery.ts';
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
      if (point === 'sync:batch_entries' && !lag) { lag = watchLoopLag({ reportAtMs: MAX_LAG_MS }); window.open = inWindow(); }
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

  isolatedTest(import.meta.path, 'each batch-wide read and the first freeze start on a timer turn of their own', () => managedBrain(async ({ engine }) => {
    // A counter ticks on every timer turn (1 ms interval). The work before each seam runs 2 ms more, so a turn there always
    // ticks it: the last new file's slug before the legacy-identity read, the last legacy-page check before the slug-holder
    // read, and the batch's sort by path before the drain's first freeze (its first slug).
    let turns = 0, before = -1;
    const ticker = setInterval(() => { turns++; }, 1);
    const spin = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* the work before the seam */ } };
    const turned: Record<string, boolean> = {};
    const reached = (seam: string) => { if (before >= 0) { turned[seam] = turns > before; before = -1; } };
    const resolve = syncCore.resolveSlugForPath, adopt = syncDiscovery.adoptLegacyPage, compare = String.prototype.localeCompare, raw = engine.executeRaw;
    let slugs = 0, adopted = 0, sorting = false;
    const slugSpy = spyOn(syncCore, 'resolveSlugForPath').mockImplementation(((...args: Parameters<typeof resolve>) => {
      if (window.open && ++slugs === PATHS) { spin(2); before = turns; }
      else if (window.open && slugs === PATHS + 1) reached('first freeze');
      return resolve(...args);
    }) as typeof resolve);
    const adoptSpy = spyOn(syncDiscovery, 'adoptLegacyPage').mockImplementation(((...args: Parameters<typeof adopt>) => {
      if (window.open && ++adopted === PATHS) { spin(2); before = turns; }
      return adopt(...args);
    }) as typeof adopt);
    const compareSpy = spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, ...args: Parameters<typeof compare>) {
      if (window.open && adopted === PATHS && !sorting) { sorting = true; spin(2); before = turns; }
      return compare.apply(this, args);
    } as typeof compare);
    engine.executeRaw = function (this: BrainEngine, sql: string, params?: unknown[]) {
      if (window.open && sql.includes('source_path IS NULL OR slug=ANY')) reached('legacy-identity read');
      if (window.open && sql.includes('knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted')) reached('slug-holder read');
      return raw.call(this, sql, params);
    } as typeof raw;
    try {
      await batchBuildLag(engine, () => true);
      expect([slugs, adopted, sorting]).toEqual([PATHS + 1, PATHS, true]);
      expect(turned).toEqual({ 'legacy-identity read': true, 'slug-holder read': true, 'first freeze': true });
    } finally { clearInterval(ticker); engine.executeRaw = raw; slugSpy.mockRestore(); adoptSpy.mockRestore(); compareSpy.mockRestore(); }
  }, { setup }), 300_000);
});
