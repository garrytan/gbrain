/**
 * #6712 PR 4b lane C: three readers that read a cursor now read the pass (design v3.2 §3.7).
 *
 * Protects:
 * - `sync unblock --apply` prints the plain sync that continues the source with the open episode's opt-outs
 *   (`passResumeArgs`), so a scheduled re-screen does not drop the `--no-embed --no-extract` the episode carries;
 * - a drain that ends on a pass result reports `drain.remaining` from that pass (`result.pass.remaining`), not from a
 *   cursor the pass never returns;
 * - a delegated sync's progress-aware deadline extends while the owner's passes settle paths (`result.pass.settled`),
 *   as it did while a cursor index advanced.
 * Synthetic content only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncResult } from '../src/commands/sync.ts';
import { DelegatedSyncDeadline } from '../src/commands/sync-persistence-delegate.ts';
import { registerRunDeadline } from '../src/core/forward-progress.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { runDrain } from '../src/core/persistence/sync-drain.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { unblockSync } from '../src/core/persistence/sync-status.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\nThe committed body of ${title} at acme-example.\n`;
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`));
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
};
const base: SyncResult = { status: 'partial', reason: 'writer_yield', fromCommit: null, toCommit: 'b', added: 1, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
const passResult = (settled: number, remaining: number): SyncResult => ({ ...base,
  pass: { pass_id: 'pass-example', kind: 'full', round: 1, outcome: 'partial', stop_reason: 'writer_yield', candidates: settled + remaining, settled, remaining, not_converged_streak: 0 } as SyncResult['pass'] });

afterEach(() => registerRunDeadline(null));

describe('#6712 PR 4b lane C: cursor readers on the pass', () => {
  test('sync unblock --apply prints the sync that keeps the open episode\'s opt-outs', () => managedBrain(async ({ engine, root }) => {
    const partial = await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true }, { maxPages: 1, maxMs: 1000 });
    expect(partial.status).toBe('partial');
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    await writeGitHold(engine, { source_id: 'default', incarnation: source!.incarnation, path: 'notes/c.md', source_path: 'notes/c.md', slug: 'notes/c', page_id: null,
      code: 'worktree_dirty', message: 'notes/c.md had uncommitted edits when the pass read it.', upstream_version: sha256(note('notes/c')),
      observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: 1, blob_oid: git(root, 'rev-parse', 'HEAD:notes/c.md') } });
    const outcome = await unblockSync(engine, 'default', { apply: true });
    expect(outcome.applied.map(entry => [entry.path, entry.action])).toEqual([['notes/c.md', 'retry_when_clean']]);
    expect(outcome.next?.argv).toEqual(['gbrain', 'sync', '--source', 'default', '--no-pull', '--no-embed', '--no-extract']);
  }, { setup }), 180_000);

  test('a drain stopped on a pass result reports that pass\'s remaining paths', async () => {
    const stop = new AbortController();
    const result = await runDrain({ pass: async () => { stop.abort(); return passResult(4, 6); }, signal: stop.signal, pauseMs: 1 });
    expect(result.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'deadline', passes: 1, remaining: 6 });
  });

  test('a delegated deadline extends while the owner\'s passes settle paths, and stops once they settle none', async () => {
    const lines: string[] = [];
    // A 600 ms deadline with a 400 ms progress window: a slice that settles paths at 450 ms carries the run past 600 ms (to 850 ms).
    const deadline = new DelegatedSyncDeadline(600, 400, line => lines.push(line));
    try {
      await new Promise(resolve => setTimeout(resolve, 450));
      deadline.noteSlice(passResult(3, 5));
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(deadline.stop.signal.aborted).toBe(false);
      expect(lines.join('\n')).toContain('still progressing');
      deadline.noteSlice(passResult(0, 5));
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(deadline.stop.signal.aborted).toBe(true);
    } finally { deadline.dispose(); }
  });
});
