/**
 * #6712 PR 4b fix 1: one pass run computes the episode closure (design §6) once per key (sync-pass-episode.ts
 * `passClosureMemo`). A writeback round's fold offer and its checkpoint both stamp at the run's pinned head, so they share
 * one `ls-tree` walk; any change to what the closure depends on walks again. Since GBRA-108 option A a writeback folds its
 * stamp into its import (one stamp per round, no checkpoint request), so its round computes the closure once.
 *
 * Protects:
 * - a writeback one-file commit stamps exactly once, folded into its import (no separate stamp request), records the import
 *   in `converged.writeback`, and walks the tree once (`sync:closure_walk`) when its episode's universe differs from the
 *   pass's, and not at all when they are equal (fix 2, test/sync-pass-closure-universe-6712.test.ts);
 * - each closure input (head, slug mode, the episode's and the pass's selections, `configured`, the configured selection)
 *   is part of the key: changing any one walks again and returns what a fresh walk returns.
 *
 * PGLite here; Postgres through test/e2e/sync-pass-closure-memo-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { passClosureMemo, passEpisodeClosure } from '../src/core/persistence/sync-pass-episode.ts';
import { MANAGED_SYNC_PASS_OP, type PassEpisode, type SyncSelection } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b']) writeFileSync(join(root, `notes/${slug}.md`), `---\ntype: concept\ntitle: notes/${slug}\n---\n\nThe body of notes/${slug}.\n`);
  commit(root, 'notes');
};
const countWalks = () => { const seen = { walks: 0 }; installFaultHook(point => { if (point === 'sync:closure_walk') seen.walks++; }); return seen; };

afterEach(() => installFaultHook(undefined));

test('each closure input is part of the key: a change walks again and matches a fresh walk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-closure-memo-'));
  try {
    mkdirSync(join(root, 'notes'), { recursive: true }); mkdirSync(join(root, 'drafts'), { recursive: true }); git(root, 'init', '-q');
    writeFileSync(join(root, 'notes/a.md'), 'a\n'); writeFileSync(join(root, 'drafts/b.md'), 'b\n'); commit(root, 'one');
    const first = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'drafts/c.md'), 'c\n'); commit(root, 'two');
    const second = git(root, 'rev-parse', 'HEAD');
    const all: SyncSelection = { exclude: [], includeHidden: [], strategy: null, srcSubpath: null, mode: 'committed' };
    const noDrafts: SyncSelection = { ...all, exclude: ['drafts/**'] }, noNotes: SyncSelection = { ...all, exclude: ['notes/**'] };
    const episode = (selection: SyncSelection): PassEpisode => ({ opened_at: '2026-01-01T00:00:00Z', selection, inherited: { noEmbed: true, noExtract: true, noSchemaPack: false, from: 'flag' } });
    // Every step keeps the episode's universe apart from the one it is compared with, so each closure walks (fix 2 skips equal ones).
    const base = { gitRoot: root, root, head: first, slugMode: 'git-root' as 'git-root' | 'source-root', episode: episode(noDrafts), pass: all, configuredSelection: all, configured: false };
    const steps: Array<[string, typeof base]> = [
      ['same key', base], ['same key again', base],
      ['head', { ...base, head: second }],
      ['episode selection', { ...base, head: second, episode: episode(noNotes) }],
      ['pass selection', { ...base, head: second, episode: episode(noNotes), pass: noDrafts }],
      ['configured selection', { ...base, head: second, episode: episode(noNotes), pass: noDrafts, configuredSelection: noDrafts }],
      ['configured', { ...base, head: second, episode: episode(noNotes), pass: noDrafts, configuredSelection: noDrafts, configured: true }],
      ['slug mode', { ...base, head: second, episode: episode(noNotes), pass: noDrafts, configuredSelection: noDrafts, configured: true, slugMode: 'source-root' }],
    ];
    const memo = passClosureMemo(), seen = countWalks(), walks: Record<string, number> = {};
    for (const [label, input] of steps) {
      const before = seen.walks, closure = await memo(input);
      walks[label] = seen.walks - before;
      installFaultHook(undefined); const fresh = await passEpisodeClosure(input); installFaultHook(point => { if (point === 'sync:closure_walk') seen.walks++; });
      expect({ label, closure }).toEqual({ label, closure: fresh });
    }
    expect(walks).toEqual({ 'same key': 1, 'same key again': 0, head: 1, 'episode selection': 1, 'pass selection': 1, 'configured selection': 1, configured: 1, 'slug mode': 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#6712 PR 4b episode closure memo (${backend})`, () => {
    test('a writeback one-file commit under a carried wider episode stamps once, folded, and walks the tree once', () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const wider: PassEpisode = { opened_at: '2026-01-01T00:00:00Z', selection: { exclude: [], includeHidden: ['.hidden/**'], strategy: null, srcSubpath: null, mode: 'committed' },
        inherited: { noEmbed: true, noExtract: true, noSchemaPack: false, from: 'flag' } };
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array(jsonb_set(completed_keys->0, '{obligations,episode}', $2::text::jsonb, true)) WHERE op=$1`,
        [MANAGED_SYNC_PASS_OP, JSON.stringify(wider)]);
      writeFileSync(join(root, 'notes/a.md'), '---\ntitle: notes/a\n---\nA committed change of notes/a.\n'); commit(root, 'change a, not canonical');
      const seen = countWalks(), before = await lastSequence(engine);
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      await expectFoldedWriteback(engine, before);
      expect(seen.walks).toBe(1);
      expect((await engine.executeRaw<{ e: unknown }>("SELECT completed_keys->0->'obligations'->'episode' AS e FROM op_checkpoints WHERE op=$1", [MANAGED_SYNC_PASS_OP]))[0]?.e ?? null).toBeNull();
    }, { ...(databaseUrl ? { databaseUrl } : {}), setup }), 120_000);

    test('a writeback one-file commit whose episode shares the pass\'s universe stamps once, folded, and walks no tree (fix 2)', () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeFileSync(join(root, 'notes/a.md'), '---\ntitle: notes/a\n---\nA committed change of notes/a.\n'); commit(root, 'change a, not canonical');
      const seen = countWalks(), before = await lastSequence(engine);
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      await expectFoldedWriteback(engine, before);
      expect(seen.walks).toBe(0);
    }, { ...(databaseUrl ? { databaseUrl } : {}), setup }), 120_000);
  });
}

async function lastSequence(engine: BrainEngine): Promise<number> {
  return Number((await engine.executeRaw<{ s: number }>('SELECT COALESCE(max(sequence),0) AS s FROM persistence_requests'))[0]!.s);
}

/** The pass after `after` stamped exactly once, folded into the writeback's import, and its converged state lists that import. */
async function expectFoldedWriteback(engine: BrainEngine, after: number): Promise<void> {
  const stamped = await engine.executeRaw<{ id: string; kind: string; state: string; stamp: string | null; skipped: string | null; written: boolean | null }>(
    `SELECT id::text AS id, intent->>'kind' AS kind, state, outcome->>'pass_stamp' AS stamp, outcome->>'pass_stamp_skipped' AS skipped,
      (outcome->'persistence'->>'file_written')::boolean AS written FROM persistence_requests WHERE sequence > $1 AND intent ? 'stamp' ORDER BY sequence`, [after]);
  expect(stamped.map(({ id, ...row }) => row)).toEqual([{ kind: 'managed_sync_import', state: 'committed', stamp: 'folded', skipped: null, written: true }]);
  const [pass] = await engine.executeRaw<{ writeback: string[] | null }>("SELECT completed_keys->0->'obligations'->'converged'->'writeback' AS writeback FROM op_checkpoints WHERE op=$1", [MANAGED_SYNC_PASS_OP]);
  expect(pass!.writeback).toEqual([stamped[0]!.id]);
}
