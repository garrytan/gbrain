/**
 * #6712 PR 4b fix 2: an episode whose universe equals the one design §6's closure test compares it with (the pass's, or
 * the configured one when the pass is at the configured selection) closes without walking `T` (sync-pass-episode.ts
 * `passEpisodeClosure`): every path of `T` answers alike on both sides, so the walk could only find inclusion and cover.
 *
 * Protects:
 * - the shortcut returns exactly what the walk returns, over a tree of tracked, excluded, hidden, unsyncable (image, code),
 *   reserved skill-bundle and sub-path files, for every pair of selections (exclude, include-hidden spellings, strategy,
 *   --src-subpath spellings, working mode), both slug modes, a source at the Git root and one in a subdirectory, and
 *   both values of `configured`;
 * - the walk is skipped exactly for the pairs whose universes are equal (equal spellings included) and taken for every
 *   other pair, so a selection field the shortcut ignored would close an episode the walk keeps open.
 *
 * The fixture's tree is walked once (`walkTreeLevel`) and replayed into every closure that walks (`walk`), instead of a
 * `git ls-tree` process per pair; one episode variant's row also walks for real at every root, slug mode and `configured`,
 * and must equal the replay.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { walkTreeLevel } from '../src/core/persistence/sync-git-stream.ts';
import { episodeClosure, passEpisodeClosure } from '../src/core/persistence/sync-pass-episode.ts';
import type { PassEpisode, SyncSelection } from '../src/core/persistence/sync-pass-row.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const FILES = ['notes/a.md', 'notes/b.mdx', 'drafts/c.md', '.private/d.md', '.private/deep/e.md', 'img/f.png', 'src/g.ts', 'src/h.py', 'skills/i/SKILL.md',
  'docs/j.md', 'docs/drafts/k.md', 'docs/.private/l.md', 'docs/src/m.ts', 'docs/skills/n/SKILL.md', 'README.md'];

const all: SyncSelection = { exclude: [], includeHidden: [], strategy: null, srcSubpath: null, mode: 'committed' };
/** Each variant with its universe group: variants in one group must skip the walk against each other, all others walk. */
const VARIANTS: Array<[string, string, SyncSelection]> = [
  ['all', 'all', all], ['working', 'all', { ...all, mode: 'working' }], ['markdown', 'all', { ...all, strategy: 'markdown' }],
  ['noDrafts', 'noDrafts', { ...all, exclude: ['drafts/**'] }], ['noDocsDrafts', 'noDocsDrafts', { ...all, exclude: ['drafts/**', 'docs/drafts/**'] }],
  ['hidden', 'hidden', { ...all, includeHidden: ['.private/'] }], ['hiddenGlob', 'hidden', { ...all, includeHidden: ['.private/**'] }],
  ['code', 'code', { ...all, strategy: 'code' }], ['auto', 'auto', { ...all, strategy: 'auto' }],
  ['docs', 'docs', { ...all, srcSubpath: 'docs' }], ['docsSlash', 'docs', { ...all, srcSubpath: '/docs/' }],
];
const episode = (selection: SyncSelection): PassEpisode => ({ opened_at: '2026-01-01T00:00:00Z', selection, inherited: { noEmbed: true, noExtract: true, noSchemaPack: false, from: 'flag' } });

test('an episode closes without the walk exactly when the universes are equal, and always as the walk says', async () => {
  const gitRoot = mkdtempSync(join(tmpdir(), 'gbrain-closure-universe-'));
  try {
    git(gitRoot, 'init', '-q');
    for (const file of FILES) { mkdirSync(join(gitRoot, dirname(file)), { recursive: true }); writeFileSync(join(gitRoot, file), `${file}\n`); }
    git(gitRoot, 'add', '-A'); git(gitRoot, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'tree');
    const head = git(gitRoot, 'rev-parse', 'HEAD'), treePaths = git(gitRoot, 'ls-tree', '-r', '--name-only', head).split('\n');
    expect(treePaths.length).toBe(FILES.length);
    const listing: string[] = [];
    await walkTreeLevel(gitRoot, head, '', path => { listing.push(path); });
    expect([...listing].sort()).toEqual([...treePaths].sort());
    const walk = async (visit: (path: string) => void) => { for (const path of listing) visit(path); };
    let walks = 0, real = 0;
    installFaultHook(point => { if (point === 'sync:closure_walk') walks++; });
    const misses: unknown[] = [], tally = { skipped: 0, walked: 0, closes: 0, open: 0 };
    for (const [root, scope] of [[gitRoot, ''], [join(gitRoot, 'docs'), 'docs']] as const)
      for (const slugMode of ['git-root', 'source-root'] as const)
        for (const configured of [false, true])
          for (const [eName, eGroup, e] of VARIANTS)
            for (const [oName, oGroup, other] of VARIANTS) {
              const pass = configured ? all : other, configuredSelection = configured ? other : all;
              const before = walks;
              const input = { gitRoot, root, head, slugMode, episode: episode(e), pass, configuredSelection, configured };
              const got = await passEpisodeClosure({ ...input, walk });
              const want = episodeClosure({ episode: e, pass, configuredSelection, configured, scope, slugMode, treePaths });
              const walked = walks - before, wantWalk = (scope ? groupIn(eGroup) !== groupIn(oGroup) : eGroup !== oGroup) ? 1 : 0;
              tally[walked ? 'walked' : 'skipped']++; tally[want.closes ? 'closes' : 'open']++;
              if (JSON.stringify(got) !== JSON.stringify(want) || walked !== wantWalk) misses.push({ scope, slugMode, configured, e: eName, other: oName, got, want, walked, wantWalk });
              if (eName === 'noDocsDrafts') {
                const fresh = await passEpisodeClosure(input);
                real += walks - before - walked;
                if (JSON.stringify(fresh) !== JSON.stringify(got)) misses.push({ scope, slugMode, configured, e: eName, other: oName, replayed: got, fresh });
              }
            }
    expect(misses).toEqual([]);
    expect(real).toBeGreaterThan(0);
    expect(tally.skipped).toBeGreaterThan(0); expect(tally.walked).toBeGreaterThan(0); expect(tally.closes).toBeGreaterThan(0); expect(tally.open).toBeGreaterThan(0);
  } finally { installFaultHook(undefined); rmSync(gitRoot, { recursive: true, force: true }); }
});

/** A source rooted at `docs/`: a selection with no --src-subpath already reads `docs/`, so `all` and `docs` share a universe. */
function groupIn(group: string): string { return group === 'docs' ? 'all' : group; }
