/**
 * #6083 / W2.9: on a managed canonical worktree, `gbrain sources push` refuses
 * by design (the persistence coordinator commits and pushes it as Git
 * effects), so nothing may keep recommending it or re-recording its refusal.
 *
 * 1. Protects: backup coverage never counts gbrain's own `.gbrain-owner.json`
 *    as dirt, classifies a root with no origin as `no_remote` even after a
 *    recorded refusal, and gives a managed root the read-only writer-status
 *    fix; doctor `bootstrap_push_health` lets a tree that matches its real
 *    origin supersede a recorded push failure; the managed guard's refusal
 *    record carries a machine `code`.
 * 2. Fails when: any of those surfaces names the refused `sources push` for a
 *    managed root, the stamp reads as unpushed work, or a stale refusal warns
 *    forever on a tree with nothing to push.
 * 3. The hook call sites (no detached push on a managed root) are pinned in
 *    hook-command.serial.test.ts.
 *
 * SERIAL: mutates GBRAIN_HOME. Run with GIT_CONFIG_NOSYSTEM=1 on machines whose
 * system git config rewrites github.com URLs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessBackupRepository } from '../src/core/backup/repository.ts';
import { pushStatusPathForRoot, workspacePush } from '../src/core/workspace-push.ts';
import { bootstrapDoctorChecks } from '../src/commands/doctor/bootstrap-checks.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

let tmp: string;
let oldHome: string | undefined;
const now = new Date('2026-10-06T12:00:00Z');
const WRITER_STATUS = ['gbrain', 'sources', 'writer', 'status'];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-managed-push-'));
  oldHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = oldHome;
  rmSync(tmp, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function repository(opts: { origin?: boolean } = {}): Promise<string> {
  const root = join(tmp, 'ws');
  mkdirSync(root);
  await makeGitFixture(root);
  git(root, 'branch', '-M', 'main');
  writeFileSync(join(root, 'note.md'), '# Fixture memory\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  if (opts.origin !== false) {
    const remote = join(tmp, 'ws.git');
    git(tmp, 'init', '--bare', '-b', 'main', remote);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-u', 'origin', 'main');
  }
  return root;
}
const manage = (root: string) => writeFileSync(join(root, '.gbrain-owner.json'), '{}\n');
function recordRefusal(root: string): void {
  const p = pushStatusPathForRoot(root);
  mkdirSync(join(tmp, '.gbrain', 'bootstrap'), { recursive: true });
  writeFileSync(p, JSON.stringify({ ts: now.toISOString(), ok: false, repoRoot: root,
    reason: 'writer_coordinator_required: This path belongs to the managed canonical worktree.' }) + '\n');
}

describe('backup coverage on a managed worktree (#6083)', () => {
  test('the ownership stamp is not dirt: a stamp-only tree matching origin verifies', async () => {
    const root = await repository();
    manage(root);
    const a = await assessBackupRepository(root, 'bootstrap_workspace', root, now, { remaining: 4 });
    expect(a.state).toBe('ok');
    expect(a.verification?.state).toBe('verified');
  });

  test('no origin remote is no_remote even after a recorded refusal', async () => {
    const root = await repository({ origin: false });
    manage(root);
    recordRefusal(root);
    const a = await assessBackupRepository(root, 'bootstrap_workspace', root, now, { remaining: 4 });
    expect(a.state).toBe('no_remote');
    expect(a.detail).toContain('git remote add origin');
    expect(a.fix_argv ?? []).not.toContain('push');
  });

  test('a dirty managed root with a recorded refusal gets the writer-status fix, never sources push', async () => {
    const root = await repository();
    manage(root);
    writeFileSync(join(root, 'unpublished.md'), 'edit\n');
    recordRefusal(root);
    const a = await assessBackupRepository(root, 'bootstrap_workspace', root, now);
    expect(a.fix_argv?.slice(0, 4)).toEqual(WRITER_STATUS);
    expect(a.fix_argv).toContain('--probe');
  });
});

describe('doctor bootstrap_push_health (#6083)', () => {
  test('a recorded failure on a tree that matches its origin is superseded: ok, nothing to push', async () => {
    const root = await repository();
    recordRefusal(root);
    const checks = await withEnv({ GBRAIN_HOME: tmp }, () => bootstrapDoctorChecks(null));
    const c = checks.find((x) => x.name === 'bootstrap_push_health');
    expect(c?.status).toBe('ok');
    expect(c?.message).toContain('nothing to push');
  });

  test('a recorded failure with unpushed work still warns', async () => {
    const root = await repository();
    writeFileSync(join(root, 'more.md'), 'unpushed\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'local');
    recordRefusal(root);
    const checks = await withEnv({ GBRAIN_HOME: tmp }, () => bootstrapDoctorChecks(null));
    expect(checks.find((x) => x.name === 'bootstrap_push_health')?.status).toBe('warn');
  });
});

describe('the managed guard refusal record (#6083)', () => {
  test('carries code writer_coordinator_required', async () => {
    const root = await repository();
    manage(root);
    await expect(workspacePush({ dir: root })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    const record = JSON.parse(readFileSync(pushStatusPathForRoot(root), 'utf8'));
    expect(record.ok).toBe(false);
    expect(record.code).toBe('writer_coordinator_required');
  });
});
