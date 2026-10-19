/**
 * GBRA-133 PR 1 item 3: classic (unmanaged) incremental sync of a file it can
 * never read as a regular file inside the repo. Before: a symlink (in-repo
 * S-16, outside S-17, typechange S-21) or a mode-000 file (S-30) failed with a
 * ledger row, blocked the source's bookmark for three runs, then auto-skipped;
 * a dangling symlink (S-18), a symlink loop (S-20), a sparse-checkout hole
 * (S-27) and a committed file deleted from the working tree (S-28) were
 * dropped silently as "deleted after the pin"; a backslash filename (S-4) read
 * as a symlink escape because Bun's realpathSync returns ENOENT for it.
 *
 * Protects: on first sight each is a typed hold (file_unreadable with its
 * symlink or permission reason, absent_from_worktree with skip_worktree or
 * deleted_locally) in the classic hold store, with a fix; the healthy sibling
 * imports, the cursor reaches HEAD and no ledger row is written. The hold is
 * re-screened on every run, so an out-of-band fix (the symlink replaced by a
 * file, chmod, git restore, the sparse checkout widened) imports the file with
 * no new commit. S-4 imports. An unknown per-file error keeps the three-run
 * auto-skip. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { cliRenderContext, renderAction, type Next } from '../../src/core/agent-output.ts';
import type { ClassicFileHoldCode, ClassicFileHoldReason } from '../../src/core/classic-file-holds.ts';
import { gitHoldItem, readGitSourceHolds, type GitHoldRecord } from '../../src/core/persistence/sync-holds.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { loadSyncFailures } from '../../src/core/sync-failure-ledger.ts';
import { CASES } from './s-blockers-cases.ts';
import { md, observe, withProbeEngine, withProbeRepo, type ProbeRepo } from './s-blockers-fixture.ts';
import { pathologicalArms } from './harness.ts';
import { permsEnforced } from '../helpers/fs-perms.ts';

const blocker = (id: string) => CASES.find(c => c.id === id)!;

interface HoldCase {
  id: string;
  /** Each held path with its expected code, reason and fix (argv and its next on the CLI). */
  holds: Array<{ path: string; code: ClassicFileHoldCode; reason: ClassicFileHoldReason; argv: string[]; next: Next }>;
  /** The out-of-band fix (no commit); afterwards each slug in imports exists. */
  repair(r: ProbeRepo): void;
  imports: string[];
  skip?: string | false;
}

const exclude = ['gbrain', 'config', 'get', 'sync.exclude'];
const regular = (r: ProbeRepo, path: string, title: string) => { unlinkSync(join(r.root, path)); writeFileSync(join(r.root, path), md(title)); };

const HOLD_CASES: HoldCase[] = [
  { id: 'S-16', holds: [{ path: 'notes/link.md', code: 'file_unreadable', reason: 'symlink_in_repo', argv: exclude, next: 'tell_user_to_run' }],
    repair: r => regular(r, 'notes/link.md', 'link'), imports: ['notes/link'] },
  { id: 'S-17', holds: [{ path: 'notes/out.md', code: 'file_unreadable', reason: 'symlink_outside_root', argv: exclude, next: 'tell_user_to_run' }],
    repair: r => regular(r, 'notes/out.md', 'out'), imports: ['notes/out'] },
  { id: 'S-18', holds: [{ path: 'notes/dangling.md', code: 'file_unreadable', reason: 'symlink_dangling', argv: exclude, next: 'tell_user_to_run' }],
    repair: r => regular(r, 'notes/dangling.md', 'dangling'), imports: ['notes/dangling'] },
  { id: 'S-20', holds: [{ path: 'loop1.md', code: 'file_unreadable', reason: 'symlink_loop', argv: exclude, next: 'tell_user_to_run' },
    { path: 'loop2.md', code: 'file_unreadable', reason: 'symlink_loop', argv: exclude, next: 'tell_user_to_run' }],
    repair: r => { regular(r, 'loop1.md', 'loop one'); regular(r, 'loop2.md', 'loop two'); }, imports: ['loop1', 'loop2'] },
  { id: 'S-21', holds: [{ path: 'notes/t.md', code: 'file_unreadable', reason: 'symlink_in_repo', argv: exclude, next: 'tell_user_to_run' }],
    repair: r => regular(r, 'notes/t.md', 't restored'), imports: ['notes/t'] },
  { id: 'S-27', holds: [{ path: 'hidden/h.md', code: 'absent_from_worktree', reason: 'skip_worktree', argv: ['git', '-C', '<checkout>', 'sparse-checkout', 'add', 'hidden'], next: 'ask_user' }],
    repair: r => { r.git('sparse-checkout', 'disable'); }, imports: ['hidden/h'] },
  { id: 'S-28', holds: [{ path: 'notes/gone.md', code: 'absent_from_worktree', reason: 'deleted_locally', argv: ['git', '-C', '<checkout>', 'restore', '--', 'notes/gone.md'], next: 'ask_user' }],
    repair: r => { r.git('restore', '--', 'notes/gone.md'); }, imports: ['notes/gone'] },
  { id: 'S-30', holds: [{ path: 'notes/locked.md', code: 'file_unreadable', reason: 'permission_denied', argv: ['chmod', 'u+r', '--', '<checkout>/notes/locked.md'], next: 'tell_user_to_run' }],
    repair: r => chmodSync(join(r.root, 'notes/locked.md'), 0o644), imports: ['notes/locked'],
    skip: permsEnforced() ? false : 'file permission bits are not enforced on this host (root or a permissive filesystem)' },
];

async function holdsOf(r: ProbeRepo): Promise<GitHoldRecord[]> {
  return (await readGitSourceHolds(r.engine, { sourceIds: [r.sourceId] }))[0]?.holds ?? [];
}
const page = async (r: ProbeRepo, slug: string) => (await r.engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [r.sourceId, slug])).length > 0;
const ledger = (r: ProbeRepo) => loadSyncFailures().filter(f => f.source_id === r.sourceId).map(f => ({ path: f.path, code: f.code, state: f.state }));

/** First sync, then the case's odd input committed next to ok/healthy-1.md. */
async function seeded(r: ProbeRepo, id: string): Promise<void> {
  const c = blocker(id);
  await c.prepare?.(r);
  expect((await r.sync()).status).toBe('first_sync');
  r.write('ok/healthy-1.md', md('healthy-1'));
  await c.mutate(r);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-133 classic per-file refusals are typed holds that never gate the bookmark (${backend})`, () => {
    for (const c of HOLD_CASES) {
      test.skipIf(!!c.skip)(`${c.id} ${blocker(c.id).name}: held ${c.holds.map(h => h.code + '/' + h.reason).join(', ')}; the sibling imports, the cursor reaches HEAD, no ledger row; an out-of-band fix imports it with no new commit`,
        () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
          await seeded(r, c.id);
          const second = await observe(r, 'ok/healthy-1');
          expect({ thrown: second.thrown, status: second.status, cursorAtHead: second.cursorAtHead, healthy: second.healthy, ledger: second.ledger })
            .toEqual({ thrown: null, status: 'synced', cursorAtHead: true, healthy: true, ledger: [] });
          const held = (await holdsOf(r)).sort((a, b) => a.path.localeCompare(b.path));
          expect(held.map(hold => {
            const item = gitHoldItem(hold);
            const fix = renderAction(item.fix, cliRenderContext());
            return { path: hold.path, code: hold.code, reason: hold.meta.reason, argv: fix.argv, next: fix.next, docs: item.docs, verify: fix.verify?.argv };
          })).toEqual(c.holds.map(h => ({ ...h, docs: 'docs/guides/write-refusals.md#' + h.code + '-' + h.reason, verify: ['gbrain', 'sources', 'status', r.sourceId, '--json'] })));

          // A quiet run keeps the hold, writes no ledger row, and is never blocked.
          const third = await observe(r, 'ok/healthy-1');
          expect({ thrown: third.thrown, cursorAtHead: third.cursorAtHead, ledger: third.ledger, held: (await holdsOf(r)).map(h => h.path).sort() })
            .toEqual({ thrown: null, cursorAtHead: true, ledger: [], held: c.holds.map(h => h.path) });

          // Out-of-band fix, no commit: the re-screen imports it and clears the hold.
          c.repair(r);
          const fixed = await observe(r, 'ok/healthy-1');
          expect({ thrown: fixed.thrown, cursorAtHead: fixed.cursorAtHead, ledger: fixed.ledger, held: await holdsOf(r) })
            .toEqual({ thrown: null, cursorAtHead: true, ledger: [], held: [] });
          for (const slug of c.imports) expect({ slug, imported: await page(r, slug) }).toEqual({ slug, imported: true });
        })), 180_000);
    }

    test('S-4 a backslash filename imports (no symlink-escape refusal, no ledger row, no hold)', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      await seeded(r, 'S-4');
      const second = await observe(r, 'ok/healthy-1');
      expect({ thrown: second.thrown, status: second.status, cursorAtHead: second.cursorAtHead, healthy: second.healthy, ledger: second.ledger, holds: second.gitHolds })
        .toEqual({ thrown: null, status: 'synced', cursorAtHead: true, healthy: true, ledger: [], holds: [] });
      const rows = await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path=$2', [r.sourceId, 'notes/back\\slash.md']);
      expect(rows).toEqual([{ source_path: 'notes/back\\slash.md' }]);
    })), 180_000);

    test('S-28 a held absent file whose deletion is then committed clears, and no page is created', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      await seeded(r, 'S-28');
      await observe(r, 'ok/healthy-1');
      expect((await holdsOf(r)).map(h => h.code)).toEqual(['absent_from_worktree']);
      r.git('rm', '-q', '--cached', '--', 'notes/gone.md');
      r.git('commit', '-qm', 'delete gone');
      const after = await observe(r, 'ok/healthy-1');
      expect({ thrown: after.thrown, cursorAtHead: after.cursorAtHead, ledger: after.ledger, held: await holdsOf(r), page: await page(r, 'notes/gone') })
        .toEqual({ thrown: null, cursorAtHead: true, ledger: [], held: [], page: false });
    })), 180_000);

    test('an unknown per-file error is not a hold: it keeps the three-run auto-skip (GBRAIN_SYNC_AUTOSKIP_AFTER=3)', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      expect((await r.sync()).status).toBe('first_sync');
      r.write('ok/healthy-1.md', md('healthy-1'));
      r.write('notes/odd.md', md('odd'));
      r.commitAll('odd');
      const failing = unknownFailure(engine, 'notes/odd');
      const statuses: string[] = [];
      for (let i = 0; i < 3; i++) {
        statuses.push((await performSync(failing, { repoPath: r.root, sourceId: r.sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 })).status);
      }
      expect(statuses).toEqual(['blocked_by_failures', 'blocked_by_failures', 'synced']);
      expect(ledger(r)).toEqual([{ path: 'notes/odd.md', code: 'UNKNOWN', state: 'auto_skipped' }]);
      expect(await holdsOf(r)).toEqual([]);
      expect({ healthy: await page(r, 'ok/healthy-1'), cursorAtHead: (await r.lastCommit()) === r.head() }).toEqual({ healthy: true, cursorAtHead: true });
    })), 180_000);
  });
}

/** The engine whose page reads inside importOnePath throw an unclassified error for one slug. */
function unknownFailure(engine: BrainEngine, slug: string): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (prop === 'getPage' && typeof value === 'function') {
      return (...args: unknown[]) => new Error().stack?.includes('importOnePath') && args[0] === slug
        ? Promise.reject(new Error('an unexpected parser state in an example plugin')) : (value as Function).apply(target, args);
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}
