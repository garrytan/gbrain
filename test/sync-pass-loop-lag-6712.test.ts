/**
 * #6712 PR 4b ruling 4: a pass must not starve the event loop. A 600k-path round classified, mapped and sorted in one
 * synchronous stretch of seconds (6-8 s at 600k), so the persistence consumer's idle probe missed its deadline and every
 * timer waited. The level read now yields between stretches (sync-yield.ts).
 *
 * Authoring gate: (1) protects the bound on the longest stretch a level read keeps timers from running; (2) a loop over
 * the level's paths (the tree copy, the page map, the domain, the classification, the sort, the dirtiness probe) that runs
 * to the end without yielding fails here; (3) the timing benches report the lag but gate nothing; (4) no seam: a real
 * managed brain and a real Git level of ${PATHS} paths, read as a pass's round reads it.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const PATHS = 60_000;
/** The ruling's bound: no stretch of a level read blocks timers for more than about this long. */
const MAX_LAG_MS = 100;

const git = (root: string, args: string[], input?: string) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 28 }).trim();

/** A commit of `PATHS` Markdown paths sharing one blob, written to the index and the object store only (no files on disk). */
const setup = ({ root }: { root: string }) => {
  git(root, ['init', '-q']);
  const blob = git(root, ['hash-object', '-w', '--stdin'], '---\ntitle: Note\n---\n\nSynthetic note.\n');
  const lines: string[] = [];
  for (let i = 0; i < PATHS; i++) lines.push(`100644 ${blob}\tnotes/d${i % 300}/note-${i}.md`);
  git(root, ['update-index', '--add', '--index-info'], lines.join('\n') + '\n');
  git(root, ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'many notes']);
};

describe('#6712 PR 4b ruling 4: a level read yields to the event loop', () => {
  test(`reading and classifying a ${PATHS}-path level never blocks a timer for ${MAX_LAG_MS} ms`, () => managedBrain(async ({ engine }) => {
    // A pass resolves its context once, before its rounds; each round's level read is what this times.
    const context = await resolveManagedSyncContext(engine, { sourceId: 'default', noPull: true, dryRun: true });
    let last = performance.now(), maxLag = 0, ticks = 0;
    const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 5); last = now; ticks++; }, 5);
    let level: Awaited<ReturnType<typeof readShadowLevel>>;
    try {
      last = performance.now();
      level = await readShadowLevel(engine, { sourceId: 'default', context });
    } finally {
      // The stretch that ends the read counts too: the timer never got to fire after it.
      maxLag = Math.max(maxLag, performance.now() - last - 5);
      clearInterval(timer);
    }
    expect(level!.paths.length).toBe(PATHS);
    expect(ticks).toBeGreaterThan(0);
    expect(Math.round(maxLag)).toBeLessThan(MAX_LAG_MS);
  }, { setup }), 300_000);
});
