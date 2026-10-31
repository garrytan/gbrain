/**
 * #7436: the pending-import check (a page write onto a file that differs from the database) ran Git synchronously, up
 * to 30 s per call, so a slow checkout froze the owner process (its lease renewals and every other preparation) while
 * one page was prepared, and the stall line blamed the last statement (`waiting_on=db last_sql=SELECT_sources`).
 * Git now runs as an awaited child process, and the step's stamp says `waiting_on=git` while it runs. A production
 * preparation also kept running for minutes after its deadline and its terminal receipt: the deadline (the preparation's
 * abort signal) now kills the Git process group, SIGTERM then SIGKILL after a grace, and the preparation stops there.
 * A `git` shim on PATH that sleeps before each call stands in for the slow checkout. Managed PGLite brain, no providers.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { enterClaimStep, startClaimPhase, type WaitingOn } from '../src/core/persistence/claim-phase.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { GIT_KILL_GRACE_MS } from '../src/core/persistence/pending-import.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

const slug = 'people/alice-example';
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };


async function pendingImportPage(engine: BrainEngine, ctx: Parameters<typeof submitPageMutation>[0], root: string) {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: '---\ntype: person\ntitle: Alice\n---\n\nBody.\n' } });
  const file = join(root, `${slug}.md`);
  writeFileSync(file, readFileSync(file, 'utf8').replace('Body.', 'Body.\n\nAnother agent added this line through Git.'));
  git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'agent commit not yet imported');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  const [binding] = await engine.executeRaw<{ worktree_id: string }>("SELECT worktree_id FROM persistence_source_bindings WHERE source_id='default'");
  return { snapshot, row: { source_id: 'default', worktree_id: binding!.worktree_id, slug } };
}
function gitShim(script: (realGit: string) => string): string {
  const shims = mkdtempSync(join(tmpdir(), 'gbrain-slow-git-'));
  writeFileSync(join(shims, 'git'), script(Bun.which('git')!));
  chmodSync(join(shims, 'git'), 0o755);
  return shims;
}
/** A pid that is gone or a zombie (an orphaned grandchild waits to be reaped by whatever adopted it). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const stat = `/proc/${pid}/stat`;
  return !existsSync(stat) || !/^\d+ \(.*\) Z /.test(readFileSync(stat, 'utf8'));
}

describe('#7436 pending-import Git check during page preparation', () => {
  test.skipIf(process.platform === 'win32')('keeps the event loop running and stamps waiting_on=git while Git runs', () => managedBrain(async ({ engine, ctx, root }) => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: '---\ntype: person\ntitle: Alice\n---\n\nBody.\n' } });
    const file = join(root, `${slug}.md`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('Body.', 'Body.\n\nAnother agent added this line through Git.'));
    git(root, 'add', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'agent commit not yet imported');
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    const [binding] = await engine.executeRaw<{ worktree_id: string }>("SELECT worktree_id FROM persistence_source_bindings WHERE source_id='default'");
    const realGit = Bun.which('git')!;
    const shims = mkdtempSync(join(tmpdir(), 'gbrain-slow-git-'));
    writeFileSync(join(shims, 'git'), `#!/bin/sh\nsleep 0.4\nPATH='${process.env.PATH}' exec "${realGit}" "$@"\n`);
    chmodSync(join(shims, 'git'), 0o755);
    const clock = startClaimPhase();
    enterClaimStep(clock, 'link_resolution', undefined, 'db');
    let ticks = 0;
    const seen = new Set<WaitingOn>();
    const timer = setInterval(() => { ticks++; seen.add(clock.waitingOn); }, 20);
    try {
      const outcome = await withEnv({ PATH: `${shims}:${process.env.PATH}` }, () =>
        prepareFileTarget(engine, { source_id: 'default', worktree_id: binding!.worktree_id, slug }, snapshot, 'replacement\n', undefined, { clock })
          .then(() => null, (error: { reason?: string }) => error));
      expect(outcome?.reason).toBe('pending_import');
    } finally { clearInterval(timer); rmSync(shims, { recursive: true, force: true }); }
    // At least two shimmed Git calls (0.8 s): a synchronous spawn let the 20 ms timer run at most once in that time.
    expect(ticks).toBeGreaterThanOrEqual(10);
    expect(seen.has('git')).toBe(true);
    expect(clock.waitingOn).toBe('db');
    expect(clock.step).toBe('link_resolution');
  }, { setup }), 120_000);

  test.skipIf(process.platform === 'win32')('the preparation deadline kills the Git process group and the preparation stops', () => managedBrain(async ({ engine, ctx, root }) => {
    const { snapshot, row } = await pendingImportPage(engine, ctx, root);
    const pids = join(mkdtempSync(join(tmpdir(), 'gbrain-git-pids-')), 'pids');
    // hash-object ignores SIGTERM and leaves a grandchild that does too, both outliving any deadline: only the group SIGKILL ends them.
    const shims = gitShim(realGit => `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "hash-object" ]; then trap '' TERM; sleep 120 & echo "$PPID $$ $!" >> ${pids}; wait; fi; done\nPATH='${process.env.PATH}' exec "${realGit}" "$@"\n`);
    const deadline = new AbortController();
    const clock = startClaimPhase(Date.now(), deadline.signal);
    enterClaimStep(clock, 'link_resolution', undefined, 'db');
    let callsAfterAbort = 0;
    const watched = new Proxy(engine, { get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? (...args: unknown[]) => { if (deadline.signal.aborted) callsAfterAbort++; return value.apply(target, args); } : value;
    } }) as BrainEngine;
    try {
      const outcome = withEnv({ PATH: `${shims}:${process.env.PATH}` }, () =>
        prepareFileTarget(watched, row, snapshot, 'replacement\n', undefined, { clock }).then(() => null, (error: unknown) => error));
      // Background Git effects of the seed write may run the shim too: the check's own command is the one this process spawned.
      const ours = () => existsSync(pids) ? readFileSync(pids, 'utf8').trim().split('\n').map(line => line.split(' ').map(Number)).find(([parent]) => parent === process.pid) : undefined;
      while (!ours()) await Bun.sleep(20);
      const [, child, grandchild] = ours()!;
      const reason = Object.assign(new Error('preparation deadline'), { code: 'deadline_exceeded' });
      const abortedAt = Date.now();
      deadline.abort(reason);
      expect(await outcome).toBe(reason);
      expect(Date.now() - abortedAt).toBeLessThan(1_000);
      // SIGTERM was ignored, so both are still there until the grace ends.
      expect([alive(child!), alive(grandchild!)]).toEqual([true, true]);
      while ((alive(child!) || alive(grandchild!)) && Date.now() - abortedAt < GIT_KILL_GRACE_MS + 3_000) await Bun.sleep(50);
      expect([alive(child!), alive(grandchild!)]).toEqual([false, false]);
      expect(Date.now() - abortedAt).toBeLessThan(GIT_KILL_GRACE_MS + 3_000);
      expect(callsAfterAbort).toBe(0);
      expect(clock.waitingOn).toBe('db');
    } finally { rmSync(shims, { recursive: true, force: true }); rmSync(dirname(pids), { recursive: true, force: true }); }
  }, { setup }), 120_000);
});
