import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { getBackupStatus } from '../src/core/backup/coverage.ts';
import { __setBackupStatusPathForTests, loadBackupStatus, saveBackupStatus } from '../src/core/backup/status-file.ts';
import { checkBackupCoverage } from '../src/commands/doctor/checks/backup-coverage.ts';
import { BACKUP_REMOTE_PROBE_CAP } from '../src/core/backup/repository.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

let tmp: string; let oldHome: string | undefined;
const now = new Date('2026-09-22T12:00:00Z');
const verified = { localGitProbes: true, verifyRemoteRefs: true, now };
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'w17-backup-')); oldHome = process.env.GBRAIN_HOME; process.env.GBRAIN_HOME = tmp; __setBackupStatusPathForTests(join(tmp, 'status.json')); });
afterEach(() => { if (oldHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldHome; __setBackupStatusPathForTests(null); rmSync(tmp, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repository(name: string) {
  const root = join(tmp, name); const remote = join(tmp, `${name}.git`);
  mkdirSync(root); await makeGitFixture(root); git(root, 'branch', '-M', 'main');
  writeFileSync(join(root, 'note.md'), '# x\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'f');
  git(tmp, 'init', '--bare', '-b', 'main', remote); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-u', 'origin', 'main');
  return root;
}
const engine = (roots: string[]) => ({ kind: 'pglite', executeRaw: async (sql: string) => sql.includes('FROM pages') ? [{ n: 1 }]
  : roots.map((root, i) => ({ id: `fixture-${i}`, name: 'fixture', local_path: root, archived: false, config: {} })) }) as unknown as BrainEngine;
function spyLsRemote() {
  const run = childProcess.execFile; const commands: string[][] = [];
  const probe = spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], o: unknown, cb: unknown) => { if (args.includes('ls-remote')) commands.push(args); return (run as Function)(file, args, o, cb); }) as typeof childProcess.execFile);
  return { commands, restore: () => probe.mockRestore() };
}

test('#6614 ordinary (non-forced) checks continue budget_exhausted roots inside the hour', async () => {
  const roots = await Promise.all(Array.from({ length: BACKUP_REMOTE_PROBE_CAP + 2 }, (_, i) => repository(`r${i}`)));
  const first = await getBackupStatus(engine(roots), verified);
  expect(first.assets.filter(a => a.verification?.state === 'budget_exhausted')).toHaveLength(2);
  const spy = spyLsRemote();
  try {
    const second = await getBackupStatus(engine(roots), { ...verified, now: new Date(now.getTime() + 60_000) });
    expect(second.totals.recoverable_repos).toBe(roots.length);
    expect(spy.commands.length).toBeGreaterThan(0);
    const before = spy.commands.length;
    const third = await getBackupStatus(engine(roots), { ...verified, now: new Date(now.getTime() + 180_000) });
    expect(spy.commands.length).toBe(before);
    expect(third.totals.recoverable_repos).toBe(roots.length);
  } finally { spy.restore(); }
}, 30_000);

test('continuation is throttled and never retries real remote failures', async () => {
  const roots = await Promise.all(Array.from({ length: BACKUP_REMOTE_PROBE_CAP + 2 }, (_, i) => repository(`t${i}`)));
  await getBackupStatus(engine(roots), verified);
  const spy = spyLsRemote();
  try {
    await getBackupStatus(engine(roots), { ...verified, now: new Date(now.getTime() + 30_000) });
    expect(spy.commands).toHaveLength(0);
  } finally { spy.restore(); }

  const root = await repository('broken');
  git(root, 'remote', 'set-url', 'origin', join(tmp, 'missing.git'));
  const failed = await getBackupStatus(engine([root]), { ...verified, forceRefresh: true });
  expect(failed.assets[0].verification?.state).toBe('unavailable');
  const retry = spyLsRemote();
  try {
    await getBackupStatus(engine([root]), { ...verified, now: new Date(now.getTime() + 120_000) });
    expect(retry.commands).toHaveLength(0);
  } finally { retry.restore(); }
}, 30_000);

test('#6687 doctor relabels a retained verified row stale and never re-probes while remote_check_at is fresh', async () => {
  const root = await repository('one');
  saveBackupStatus(await getBackupStatus(engine([root]), { ...verified, forceRefresh: true }));
  const s = loadBackupStatus()!;
  // a later sweep kept this verified row (budget ran out) but stamped the sweep clock 40 min later
  saveBackupStatus({ ...s, remote_check_at: new Date(now.getTime() + 40 * 60_000).toISOString(), checked_at: new Date(now.getTime() + 40 * 60_000).toISOString() });
  const spy = spyLsRemote();
  try {
    const at = new Date(now.getTime() + 65 * 60_000);
    const check = await checkBackupCoverage(engine([root]), { localOnly: true, now: at });
    expect(spy.commands.length).toBeGreaterThan(0);
    expect(check.status).toBe('ok');
  } finally { spy.restore(); }
}, 30_000);
