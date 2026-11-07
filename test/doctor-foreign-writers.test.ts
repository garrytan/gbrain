/**
 * PR B Part 4: doctor `foreign_writers`. One repository gets seven commit kinds (door, commit-push, in-memory merge, plain
 * git commit, --amend, plumbing commit-tree + update-ref, and a hooks-path bypass under the enforce guard); only plain,
 * amend, bypass and plumbing are flagged, while effect-worker, replay, bootstrap and sync auto-init commits, an upstream
 * fast-forward and the merge are not. Real git repositories in temp dirs, in-memory PGLite.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { foreignWritersEntry, classifyReflogMessage, type ForeignCommit } from '../src/commands/doctor/checks/foreign-writers.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { commitAndPush, commitPathsLocked, notePending } from '../src/core/git/commit-push.ts';
import { installOwnerGuard } from '../src/core/git/commit-guard.ts';
import { ledgerFiles, readLedger, recordIntent } from '../src/core/git/commit-ledger.ts';
import { commitThroughDoor } from '../src/core/persistence/git-door.ts';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';
import { createSyncBaselineCommit } from '../src/core/sync-git.ts';
import { defaultRunner, ensureWorkspaceCommit } from '../src/core/bootstrap/repo.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-foreign-writers-'));
const ID = { GIT_AUTHOR_NAME: 'Alice Example', GIT_AUTHOR_EMAIL: 'alice-example@example.invalid', GIT_COMMITTER_NAME: 'Alice Example', GIT_COMMITTER_EMAIL: 'alice-example@example.invalid' };

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ID, ...env } }).toString().trim();
}
function write(root: string, rel: string, body: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function identity(root: string): void {
  git(root, ['config', 'user.email', ID.GIT_AUTHOR_EMAIL]);
  git(root, ['config', 'user.name', ID.GIT_AUTHOR_NAME]);
  git(root, ['config', 'commit.gpgsign', 'false']);
}
let n = 0;
function checkout(): { bare: string; work: string; other: string } {
  const tag = n++;
  const bare = join(dir, `origin-${tag}.git`), work = join(dir, `work-${tag}`), other = join(dir, `other-${tag}`);
  git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, ['clone', '-q', bare, work]);
  identity(work);
  write(work, 'notes/seed.md', 'seed\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'seed']); git(work, ['push', '-q', '-u', 'origin', 'main']);
  git(dir, ['clone', '-q', bare, other]);
  identity(other);
  return { bare, work, other };
}
async function register(id: string, path: string): Promise<void> {
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, path]);
}
const run = async (): Promise<Check> => ((await foreignWritersEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext)) as Check[])[0]!;
const head = (root: string) => git(root, ['rev-parse', 'HEAD']);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => { await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'"); });

test('registered and categorized', () => {
  expect(DOCTOR_CHECK_REGISTRY.some(entry => entry.emits.includes('foreign_writers'))).toBe(true);
  expect(categorizeCheck('foreign_writers')).toBe('brain');
});

test('reflog messages classify into porcelain kinds, exclusions and other ref moves', () => {
  expect(classifyReflogMessage('commit: x')).toBe('plain');
  expect(classifyReflogMessage('commit (initial): x')).toBe('plain');
  expect(classifyReflogMessage('commit (amend): x')).toBe('amend');
  expect(classifyReflogMessage('commit (merge): x')).toBe('excluded');
  for (const m of ['cherry-pick: x', 'revert: Revert "x"', 'rebase (pick): x', 'rebase -i (squash): x', 'pull --rebase (pick): x', 'am: x']) expect(classifyReflogMessage(m)).toBe('rewrite');
  for (const m of ['merge origin/main: Fast-forward', 'pull: Fast-forward', 'reset: moving to HEAD~1', 'checkout: moving from a to b', 'branch: Created from HEAD', 'clone: from x', 'rebase (finish): returning to refs/heads/main']) expect(classifyReflogMessage(m)).toBe('excluded');
  expect(classifyReflogMessage('')).toBe('other');
  expect(classifyReflogMessage('gbrain: custom move')).toBe('other');
});

test('seven commit kinds: only plain, amend, the guard bypass and plumbing are foreign', async () => {
  const { work, other } = checkout();
  await register('notes', join(work, 'notes'));

  write(work, 'notes/door.md', 'door\n');
  const door = await commitThroughDoor(work, [{ path: join(work, 'notes/door.md'), planned: createHash('sha256').update('door\n').digest('hex') }]);
  expect(door).toBe(head(work));
  write(work, 'notes/push.md', 'push\n');
  const pushed = commitPathsLocked(work, ['notes/push.md'], 'commit-push page', { lockWaitMs: 1000 });

  write(work, 'notes/plain.md', 'plain\n');
  git(work, ['add', 'notes/plain.md']); git(work, ['commit', '-q', '-m', 'plain commit']);
  const plain = head(work);
  git(work, ['commit', '-q', '--amend', '-m', 'plain commit, amended']);
  const amend = head(work);

  installOwnerGuard(work, 'enforce');
  write(work, 'notes/effect.md', 'effect\n');
  const effect = (await commitGitTargets(join(work, 'notes'), ['effect.md'])).get('effect.md');
  expect(effect).toEqual({ git: 'committed' });
  const effectSha = head(work);
  write(work, 'notes/push2.md', 'push two\n');
  commitPathsLocked(work, ['notes/push2.md'], 'commit-push under the enforce guard', { lockWaitMs: 1000 });

  // Replay + in-memory merge: the remote already has a local commit's patch, so the local commits replay onto it.
  write(work, 'notes/same.md', 'same patch\n');
  commitPathsLocked(work, ['notes/same.md'], 'same patch here', { lockWaitMs: 1000 });
  write(other, 'notes/same.md', 'same patch\n');
  git(other, ['add', '-A']); git(other, ['commit', '-q', '-m', 'same patch there']); git(other, ['push', '-q']);
  write(work, 'notes/after.md', 'after\n');
  commitPathsLocked(work, ['notes/after.md'], 'after the patch', { lockWaitMs: 1000 });
  const published = commitAndPush({ repo: work, pushOnly: true });
  expect(published.checkout).toBe('advanced');
  const ledger = readLedger(join(work, '.git'));
  expect(ledger.some(r => r.e === 'commit' && r.writer === 'replay')).toBe(true);
  const merge = ledger.find((r): r is Extract<typeof r, { e: 'commit' }> => r.e === 'commit' && r.writer === 'merge');
  expect(merge && git(work, ['log', '--no-walk', '--format=%P', merge.sha]).split(' ').length).toBe(2);

  // Upstream fast-forward of a commit made minutes ago on another clone.
  git(other, ['pull', '-q', '--ff-only']);
  write(other, 'notes/upstream.md', 'upstream\n');
  git(other, ['add', '-A']); git(other, ['commit', '-q', '-m', 'upstream work']); git(other, ['push', '-q']);
  git(work, ['fetch', '-q']); git(work, ['merge', '-q', '--ff-only', '@{u}']);

  // The enforce guard refuses --no-verify; a hooks-path override bypasses every hook.
  write(work, 'notes/bypass.md', 'bypass\n');
  git(work, ['add', 'notes/bypass.md']);
  const before = head(work);
  expect(() => git(work, ['commit', '-q', '--no-verify', '-m', 'refused'])).toThrow(/gbrain commit guard/);
  expect(head(work)).toBe(before);
  await new Promise(r => setTimeout(r, 1100));
  git(work, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'hooks off']);
  const bypass = head(work);

  const tree = git(work, ['rev-parse', 'HEAD^{tree}']);
  const plumbing = git(work, ['commit-tree', tree, '-p', 'HEAD', '-m', 'plumbing']);
  git(work, ['update-ref', 'refs/heads/main', plumbing]);

  const check = await run();
  expect(check.status).toBe('fail');
  const foreign = (check.details!.foreign as ForeignCommit[]);
  const bySha = Object.fromEntries(foreign.map(c => [c.sha, c]));
  expect(new Set(Object.keys(bySha))).toEqual(new Set([plain, amend, bypass, plumbing]));
  expect(bySha[plain]).toMatchObject({ kind: 'plain', guard_bypassed: false });
  expect(bySha[amend]!.kind).toBe('amend');
  expect(bySha[bypass]).toMatchObject({ kind: 'plain', guard_bypassed: true });
  expect(bySha[plumbing]!.kind).toBe('plumbing');
  for (const sha of [door!, pushed!, effectSha]) expect(bySha[sha]).toBeUndefined();
  expect(check.message).toContain('was not made by gbrain; route that writer through gbrain git commit-push or a page write');
  expect(check.message).toContain('plain (guard bypassed)');
  expect(check.fix).toMatchObject({ ask_user: true });
  expect((check.details!.window as Array<{ uncovered: number }>)[0]!.uncovered).toBeGreaterThan(0);
}, 120_000);

test('bootstrap and sync auto-init commits are ledgered, not foreign', async () => {
  const synced = join(dir, `auto-init-${n++}`);
  mkdirSync(synced);
  git(synced, ['init', '-q', '-b', 'main']);
  write(synced, 'note.md', 'auto\n');
  createSyncBaselineCommit(synced);
  const boot = join(dir, `bootstrap-${n++}`);
  mkdirSync(boot);
  git(boot, ['init', '-q', '-b', 'main']);
  identity(boot);
  write(boot, 'SOUL.md', 'an agent workspace\n');
  await ensureWorkspaceCommit(defaultRunner, boot);
  await register('auto', synced);
  await register('boot', boot);
  expect(readLedger(join(synced, '.git')).some(r => r.e === 'commit' && r.writer === 'sync_init')).toBe(true);
  expect(readLedger(join(boot, '.git')).some(r => r.e === 'commit' && r.writer === 'bootstrap')).toBe(true);
  const check = await run();
  expect(check.details!.foreign).toEqual([]);
  expect(check.status).toBe('ok');
}, 60_000);

test('commits before the ledger starts are uncovered, never foreign', async () => {
  const { work } = checkout();
  write(work, 'notes/early.md', 'early\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'before gbrain']);
  await register('early', join(work, 'notes'));
  let check = await run();
  expect(check.status).toBe('ok');
  expect(check.message).toContain('has no ledger');
  await new Promise(r => setTimeout(r, 1100));
  write(work, 'notes/later.md', 'later\n');
  commitPathsLocked(work, ['notes/later.md'], 'gbrain starts the ledger', { lockWaitMs: 1000 });
  check = await run();
  expect(check.status).toBe('ok');
  expect((check.details!.window as Array<{ uncovered: number; from: string | null }>)[0]!.uncovered).toBeGreaterThan(0);
}, 60_000);

test('an open intent matching a commit is unconfirmed (warn) and never written back', async () => {
  const { work } = checkout();
  await register('crash', join(work, 'notes'));
  write(work, 'notes/a.md', 'a\n');
  commitPathsLocked(work, ['notes/a.md'], 'start the ledger', { lockWaitMs: 1000 });
  recordIntent(work, { writer: 'commit_push', head_before: head(work), message: 'crashed before the ledger line' });
  write(work, 'notes/b.md', 'b\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'crashed before the ledger line']);
  const sha = head(work);
  const before = readLedger(join(work, '.git')).length;
  const check = await run();
  expect(check.status).toBe('warn');
  expect((check.details!.unconfirmed as ForeignCommit[]).map(c => c.sha)).toEqual([sha]);
  expect(check.details!.foreign).toEqual([]);
  expect(readLedger(join(work, '.git')).length).toBe(before);
  // A different message is not covered by the intent.
  recordIntent(work, { writer: 'commit_push', head_before: head(work), message: 'one message' });
  write(work, 'notes/c.md', 'c\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'another message']);
  expect((await run()).status).toBe('fail');
}, 60_000);

test('an intent its own commit line completed never covers a later commit with the same parent and message', async () => {
  const { work } = checkout();
  await register('reused', join(work, 'notes'));
  write(work, 'notes/a.md', 'a\n');
  commitPathsLocked(work, ['notes/a.md'], 'start the ledger', { lockWaitMs: 1000 });
  const parent = head(work);
  write(work, 'notes/b.md', 'b\n');
  commitPathsLocked(work, ['notes/b.md'], 'same message', { lockWaitMs: 1000 });
  git(work, ['reset', '-q', '--hard', parent]);
  write(work, 'notes/c.md', 'c\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'same message']);
  const sha = head(work);
  const check = await run();
  expect(check.status).toBe('fail');
  expect((check.details!.foreign as ForeignCommit[]).map(c => c.sha)).toContain(sha);
  expect(check.details!.unconfirmed).toEqual([]);
}, 60_000);

test('a git status that fails leaves the scan partial, which warns instead of reading ok', async () => {
  const { work } = checkout();
  await register('unreadable', join(work, 'notes'));
  write(work, 'notes/a.md', 'a\n');
  commitPathsLocked(work, ['notes/a.md'], 'start the ledger', { lockWaitMs: 1000 });
  expect((await run()).status).toBe('ok');
  writeFileSync(join(work, '.git', 'index'), 'not an index');
  const check = await run();
  expect(check.details!.partial).toBe(true);
  expect(check.status).toBe('warn');
  expect(check.message).toContain('the scan did not finish');
  expect(check.message).toContain(`git status failed in ${work}`);
}, 60_000);

test('after rotation the ledgered commits in commit-ledger.1.jsonl still count', async () => {
  const { work } = checkout();
  await register('rotated', join(work, 'notes'));
  write(work, 'notes/a.md', 'a\n');
  commitPathsLocked(work, ['notes/a.md'], 'ledgered before rotation', { lockWaitMs: 1000 });
  const files = ledgerFiles(join(work, '.git'));
  renameSync(files.current, files.rotated);
  write(work, 'notes/b.md', 'b\n');
  commitPathsLocked(work, ['notes/b.md'], 'ledgered after rotation', { lockWaitMs: 1000 });
  expect(readFileSync(files.current, 'utf8')).not.toContain('"e":"start"');
  const check = await run();
  expect(check.status).toBe('ok');
  expect(check.details!.foreign).toEqual([]);
}, 60_000);

test('a commit in a linked worktree is read from its own HEAD log', async () => {
  const { work } = checkout();
  await register('main', join(work, 'notes'));
  write(work, 'notes/a.md', 'a\n');
  commitPathsLocked(work, ['notes/a.md'], 'start the ledger', { lockWaitMs: 1000 });
  await new Promise(r => setTimeout(r, 1100));
  const linked = join(dir, `linked-${n++}`);
  git(work, ['worktree', 'add', '-q', '--detach', linked]);
  write(linked, 'notes/side.md', 'side\n');
  git(linked, ['add', '-A']); git(linked, ['commit', '-q', '-m', 'detached side commit']);
  const sha = head(linked);
  const check = await run();
  expect(check.status).toBe('fail');
  const found = (check.details!.foreign as ForeignCommit[]).find(c => c.sha === sha)!;
  expect(found.ref).toMatch(/^worktrees\/.+\/HEAD$/);
  expect(found.checkout).toBe(git(linked, ['rev-parse', '--show-toplevel']));
}, 60_000);

test('dirty page files: old ones warn; a pending git effect and a write-through pending path are left out', async () => {
  const { work } = checkout();
  await register('dirty', join(work, 'notes'));
  const old = (Date.now() - 2 * 3_600_000) / 1000;
  for (const name of ['stray.md', 'effect.md', 'pending.md']) { write(work, `notes/${name}`, `${name}\n`); utimesSync(join(work, 'notes', name), old, old); }
  appendFileSync(join(work, 'notes/seed.md'), 'edited\n');
  utimesSync(join(work, 'notes/seed.md'), old, old);
  write(work, 'outside.md', 'not under the source root\n');
  utimesSync(join(work, 'outside.md'), old, old);
  notePending(work, ['notes/pending.md']);
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='dirty'");
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    const [request] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
      intent_bytes,terminal_reservation) VALUES ('local_cli','test',$1::uuid,'put_page','dirty',$2::uuid,'effect','x','{}'::jsonb,0,0) RETURNING id::text`, [randomUUID(), incarnation]);
    await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,state,source_id,source_incarnation) VALUES ($1::uuid,'git',$2::text::jsonb,'queued','dirty',$3::uuid)`,
      [request!.id, JSON.stringify({ relative_path: 'effect.md', slug: 'effect' }), incarnation]);
  });
  const check = await run();
  expect(check.status).toBe('warn');
  const paths = (check.details!.dirty as Array<{ path: string; state: string; age_ms: number }>).map(d => d.path).sort();
  expect(paths).toEqual(['notes/seed.md', 'notes/stray.md']);
  expect(check.details!.dirty_count).toBe(2);
  expect(check.message).toContain('notes/stray.md (untracked, 2h)');
}, 60_000);

test('repo-less: no source checkout is a Git repository, so the check is not applicable', async () => {
  const plain = mkdtempSync(join(dir, 'plain-'));
  write(plain, 'note.md', 'no git here\n');
  await register('plain', plain);
  const check = await run();
  expect(check).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'not_applicable' });
});

test('the scan reads git without optional locks: a stat-dirty index is left as it was, so a concurrent commit never meets index.lock', async () => {
  const { work } = checkout();
  await register('locks', work);
  const future = new Date(Date.now() + 3_600_000);
  utimesSync(join(work, 'notes/seed.md'), future, future);
  const before = readFileSync(join(work, '.git/index'));
  await run();
  expect(readFileSync(join(work, '.git/index')).equals(before)).toBe(true);
});


test('GST-1623: a foreign commit carrying a gbrain- trailer is named as possibly an older gbrain without the commit ledger, and still fails', async () => {
  const { work } = checkout();
  await register('older', join(work, 'notes'));
  write(work, 'notes/a.md', 'a\n');
  commitPathsLocked(work, ['notes/a.md'], 'start the ledger', { lockWaitMs: 1000 });
  write(work, 'notes/b.md', 'b\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'gbrain: repair a page', '-m', 'gbrain-repair: frontmatter_slug_conflict deterministic high']);
  const trailed = head(work);
  write(work, 'notes/c.md', 'c\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'plain commit']);
  const check = await run();
  expect(check.status).toBe('fail');
  const bySha = Object.fromEntries((check.details!.foreign as ForeignCommit[]).map(c => [c.sha, c]));
  expect(bySha[trailed]).toMatchObject({ gbrain_trailer: true });
  expect(bySha[head(work)]).toMatchObject({ gbrain_trailer: false });
  expect(check.message).toContain('an older gbrain without the commit ledger');
}, 60_000);

test('GST-1623: a root whose git probe fails, and a scan where every root fails, warn as partial instead of not_applicable', async () => {
  const { work } = checkout();
  await register('broken', join(work, 'notes'));
  writeFileSync(join(work, '.git', 'HEAD'), 'not a ref\n');
  const check = await run();
  expect(check.status).toBe('warn');
  expect(check.readiness_state).not.toBe('not_applicable');
  expect(check.details!.partial).toBe(true);
  expect((check.details!.partial_reasons as string[]).join(' ')).toContain(join(work, 'notes'));
  expect(check.message).toContain('could not be read as a Git checkout');
}, 60_000);

test('GST-1623: roots past the scan cap leave the scan partial, never not_applicable', async () => {
  const plain = mkdtempSync(join(dir, 'capped-'));
  for (let i = 0; i < 51; i++) { mkdirSync(join(plain, `r${String(i).padStart(2, '0')}`)); await register(`capped-${String(i).padStart(2, '0')}`, join(plain, `r${String(i).padStart(2, '0')}`)); }
  const check = await run();
  expect(check.status).toBe('warn');
  expect(check.details!.partial).toBe(true);
  expect(check.message).toContain('past the 50-root scan cap');
}, 60_000);

test('GST-1623: an unreadable commit ledger warns as partial instead of reading as an empty ledger', async () => {
  const { work } = checkout();
  await register('ledger', join(work, 'notes'));
  write(work, 'notes/a.md', 'a\n');
  commitPathsLocked(work, ['notes/a.md'], 'start the ledger', { lockWaitMs: 1000 });
  const files = ledgerFiles(join(work, '.git'));
  rmSync(files.current); mkdirSync(files.current);
  const check = await run();
  expect(check.status).toBe('warn');
  expect(check.details!.partial).toBe(true);
  expect(check.message).toContain('commit ledger');
  expect(check.message).toContain('could not be read');
}, 60_000);

