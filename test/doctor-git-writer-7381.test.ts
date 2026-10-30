/**
 * #7381 (GBRA-180): `checkout_lagging`, `dirty_age` and
 * `commits_outside_source_root` read each unmanaged source checkout with an
 * upstream: behind the last fetch for over an hour, write-through files or
 * staged files waiting over 30 minutes, unpushed commits outside the roots.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { gitWriterEntry, CHECKOUT_LAG_WARN_MS } from '../src/commands/doctor/checks/git-writer.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { commitAndPush, commitPathsLocked } from '../src/core/git/commit-push.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-git-writer-'));
const HOUR = 3_600_000;

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).toString().trim();
}
function checkout(name: string): { bare: string; work: string } {
  const bare = join(dir, `${name}.git`), work = join(dir, name);
  git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, ['clone', '-q', bare, work]);
  git(work, ['config', 'user.email', 'example@example.invalid']);
  git(work, ['config', 'user.name', 'Example']);
  mkdirSync(join(work, 'brain'));
  writeFileSync(join(work, 'brain', 'note.md'), 'first\n');
  writeFileSync(join(work, 'other.md'), 'not the brain\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'first']); git(work, ['push', '-q', '-u', 'origin', 'main']);
  return { bare, work };
}
const run = async () => Object.fromEntries(((await gitWriterEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext)) as Check[]).map(c => [c.name, c]));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test('registered and categorized', () => {
  for (const name of ['checkout_lagging', 'dirty_age', 'commits_outside_source_root', 'quarantined_changes']) {
    expect(DOCTOR_CHECK_REGISTRY.some(entry => entry.emits.includes(name))).toBe(true);
    expect(categorizeCheck(name)).toBe('brain');
  }
});

test('a clean checkout is ok on all four; each problem warns with its fix', async () => {
  const { bare, work } = checkout('one');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('notes','notes',$1)", [join(work, 'brain')]);
  let checks = await run();
  for (const name of ['checkout_lagging', 'dirty_age', 'commits_outside_source_root', 'quarantined_changes']) expect(checks[name]?.status).toBe('ok');

  // Behind: another clone pushed a commit two hours ago and this checkout fetched but never advanced.
  const other = join(dir, 'other-clone');
  git(dir, ['clone', '-q', bare, other]);
  git(other, ['config', 'user.email', 'example@example.invalid']); git(other, ['config', 'user.name', 'Example']);
  writeFileSync(join(other, 'brain', 'remote.md'), 'remote\n');
  const old = new Date(Date.now() - 2 * HOUR).toISOString();
  git(other, ['add', '-A']); git(other, ['commit', '-q', '-m', 'remote'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old }); git(other, ['push', '-q']);
  git(work, ['fetch', '-q']);
  checks = await run();
  expect(checks.checkout_lagging).toMatchObject({ status: 'warn', details: { checkouts: [expect.objectContaining({ behind: 1 })] } });
  expect(checks.checkout_lagging!.fix!.argv).toEqual(['gbrain', 'git', 'commit-push', '--pull', '--path', work]);
  expect(CHECKOUT_LAG_WARN_MS).toBe(HOUR);
  git(work, ['merge', '-q', '--ff-only', '@{u}']);

  // Pending write-through: the lock was held past the short wait, 40 minutes ago.
  const lock = join(work, '.git', 'brain-commit.lock');
  writeFileSync(lock, '');
  const holder = spawn('flock', ['-o', lock, 'sleep', '20'], { stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 300));
    writeFileSync(join(work, 'brain', 'note.md'), 'page write\n');
    expect(() => commitPathsLocked(join(work, 'brain'), [join(work, 'brain', 'note.md')], 'gbrain: write-through note', { lockWaitMs: 100 })).toThrow();
  } finally { holder.kill('SIGKILL'); }
  const ledger = join(work, '.git', 'brain-writethrough-pending.log');
  writeFileSync(ledger, `${new Date(Date.now() - 40 * 60_000).toISOString()}\t"brain/note.md"\n`);
  checks = await run();
  expect(checks.dirty_age).toMatchObject({ status: 'warn', details: { checkouts: [expect.objectContaining({ pending_count: 1 })] } });
  expect(checks.dirty_age!.fix!.argv).toEqual(['gbrain', 'git', 'commit-push', '--pending', '--path', work]);
  git(work, ['add', 'brain/note.md']); git(work, ['commit', '-q', '-m', 'committed by hand']);
  rmSync(ledger);

  // Staged for over 30 minutes by another writer.
  writeFileSync(join(work, 'brain', 'staged.md'), 'staged\n');
  git(work, ['add', 'brain/staged.md']);
  const stale = (Date.now() - HOUR) / 1000; utimesSync(join(work, 'brain', 'staged.md'), stale, stale);
  checks = await run();
  expect(checks.dirty_age).toMatchObject({ status: 'warn', fix: { ask_user: true, actor: 'user' } });
  git(work, ['restore', '--staged', 'brain/staged.md']);

  // An unpushed commit (made around gbrain) that changes a file outside the source root.
  writeFileSync(join(work, 'other.md'), 'swept\n');
  git(work, ['commit', '-q', '-am', 'cron: swept']);
  checks = await run();
  const outside = checks.commits_outside_source_root!;
  const found = (outside.details as { checkouts: Array<{ roots: string[]; configured: boolean; commits: Array<{ paths: string[] }> }> }).checkouts;
  expect(found.map(f => ({ roots: f.roots, configured: f.configured, paths: f.commits.map(x => x.paths) }))).toEqual([{ roots: ['brain'], configured: false, paths: [['other.md']] }]);
  expect(outside).toMatchObject({ status: 'warn', fix: { ask_user: true } });
  expect(checks.commits_outside_source_root!.message).toContain('gbrain sources harden');
  git(work, ['reset', '-q', '--hard', '@{u}']);

  // A conflict the opt-in quarantine parked: the remote's version published, this machine's under a ref.
  git(other, ['pull', '-q']);
  writeFileSync(join(other, 'brain', 'remote.md'), 'remote edit\n');
  git(other, ['commit', '-q', '-am', 'remote edit']); git(other, ['push', '-q']);
  git(work, ['config', 'gbrain.quarantine', 'true']);
  writeFileSync(join(work, 'brain', 'remote.md'), 'local edit\n');
  const pushed = commitAndPush({ repo: work, paths: ['brain/remote.md'], message: 'local edit', cwd: work });
  checks = await run();
  expect(checks.quarantined_changes).toMatchObject({ status: 'warn', fix: { ask_user: true, argv: ['git', '-C', work, 'update-ref', '-d', pushed.quarantined!.ref] } });
  expect(checks.quarantined_changes!.message).toContain('brain/remote.md');
  git(work, ['update-ref', '-d', pushed.quarantined!.ref]);
  checks = await run();
  expect(checks.quarantined_changes!.status).toBe('ok');
}, 60_000);
