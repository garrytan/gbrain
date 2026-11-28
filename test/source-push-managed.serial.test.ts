/**
 * Protects the CLI's managed-owner boundary and exact committed-history transport.
 * A bulk workspace push, a HEAD-only scan, or a live-ref push breaks these assertions.
 * Existing automatic-publisher tests do not exercise this command; no production test seam is needed.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSources } from '../src/commands/sources.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { acquireWorktree, claimWorktree, type WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { acquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { recordCommit } from '../src/core/git/commit-ledger.ts';
import { SCAN_MAX_FILE_BYTES } from '../src/core/secret-scan.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const secret = 'gh' + 'p_' + 'Zt4q'.repeat(9);
let engine: PGLiteEngine, version: string;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const current = await engine.getConfig('version');
  if (!current) throw new Error('missing installed schema version');
  version = current;
}, 120_000);
beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', version); });
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'protocol.file.allow=always', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}
interface Fixture { home: string; work: string; remote: string; binding: WorktreeBinding }
async function fixture(run: (f: Fixture) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'managed-sources-push-'));
  try {
    await withEnv({ HOME: home, GBRAIN_HOME: home, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const remote = join(home, 'remote.git'), work = join(home, 'work');
      git(home, 'init', '--bare', '-q', '-b', 'main', remote); git(home, 'clone', '-q', remote, work);
      git(work, 'config', 'user.name', 'Example'); git(work, 'config', 'user.email', 'example@example.invalid');
      writeFileSync(join(work, 'page.md'), 'published\n'); git(work, 'add', 'page.md');
      git(work, 'commit', '-qm', 'initial'); git(work, 'push', '-qu', 'origin', 'main');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('managed','managed',$1)", [work]);
      const binding = await claimWorktree(engine, 'managed', work);
      await registerLocalWriter(engine, 'cli'); await activatePersistence(engine, { confirmQuiesced: true });
      try { await run({ home, work, remote, binding }); }
      finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
async function push(...args: string[]) {
  const output: string[] = [], errors: string[] = [];
  const oldExit = process.exit, oldLog = console.log, oldError = console.error;
  let code = 0;
  process.exit = ((n?: number) => { throw new Exit(n ?? 0); }) as typeof process.exit;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(' '));
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(' '));
  try { await runSources(engine, ['push', ...args, '--json']); }
  catch (error) { if (error instanceof Exit) code = error.code; else throw error; }
  finally { process.exit = oldExit; console.log = oldLog; console.error = oldError; }
  return { code, result: JSON.parse(output.join('\n')), errors: errors.join('\n') };
}
function commit(f: Fixture, file: string, content: string | Buffer): string {
  writeFileSync(join(f.work, file), content); git(f.work, 'add', '-f', file); git(f.work, 'commit', '-qm', `change ${file}`);
  return git(f.work, 'rev-parse', 'HEAD');
}
function snapshot(f: Fixture) {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(f.work, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(rel, entry.name);
      if (entry.isDirectory()) walk(path); else files[path] = readFileSync(join(f.work, path)).toString('base64');
    }
  };
  walk('');
  return { files, index: readFileSync(join(f.work, '.git', 'index')).toString('base64'), head: git(f.work, 'rev-parse', 'HEAD') };
}
const remoteHead = (f: Fixture) => git(f.remote, 'rev-parse', 'refs/heads/main');

test('pushes only committed HEAD; dirty index, untracked secrets and hooks stay untouched', () => fixture(async f => {
  const head = commit(f, 'committed.md', 'safe committed bytes\n');
  const hookDir = join(f.home, 'hooks'); mkdirSync(hookDir);
  const hookMarker = join(f.home, 'hook-ran');
  for (const name of ['pre-push', 'post-commit']) {
    const file = join(hookDir, name); writeFileSync(file, `#!/bin/sh\necho ran > '${hookMarker}'\nexit 1\n`); chmodSync(file, 0o700);
  }
  git(f.work, 'config', 'core.hooksPath', hookDir);
  writeFileSync(join(f.work, 'page.md'), secret); writeFileSync(join(f.work, 'staged.md'), secret);
  git(f.work, 'add', 'staged.md'); writeFileSync(join(f.work, 'staged.md'), `${secret} dirty`);
  writeFileSync(join(f.work, 'untracked.md'), secret);
  const before = snapshot(f);
  expect(await push('managed')).toMatchObject({ code: 0, result: { status: 'pushed', managed: true, committed: false, head } });
  expect(remoteHead(f)).toBe(head); expect(snapshot(f)).toEqual(before); expect(existsSync(hookMarker)).toBe(false);
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'main')).toBe('committed.md\npage.md');
}), 60_000);

test('a removed binary secret and a deny path in unpublished history cannot be hidden by clean HEAD', () => fixture(async f => {
  const remote = remoteHead(f);
  commit(f, 'image.bin', Buffer.from(`\0binary\0${secret}\n`));
  git(f.work, 'rm', '-q', 'image.bin'); git(f.work, 'commit', '-qm', 'remove binary');
  let before = snapshot(f), result = await push('--path', f.work);
  expect(result).toMatchObject({ code: 5, result: { code: 'blocked_secrets' } });
  expect(result.result.reason).toContain('image.bin'); expect(JSON.stringify(result)).not.toContain(secret);
  expect(remoteHead(f)).toBe(remote); expect(snapshot(f)).toEqual(before);
  // Replace the unpublished history with a separate deny-path add/remove history.
  git(f.work, 'reset', '--hard', '-q', remote);
  commit(f, '.env', 'ordinary content\n'); git(f.work, 'rm', '-q', '.env'); git(f.work, 'commit', '-qm', 'remove deny path');
  before = snapshot(f); result = await push('managed');
  expect(result).toMatchObject({ code: 5, result: { code: 'blocked_tracked_deny' } });
  expect(result.result.reason).toContain('.env'); expect(remoteHead(f)).toBe(remote); expect(snapshot(f)).toEqual(before);
}), 60_000);

test('page-write ledger exemptions do not bypass the explicit managed scan; automatic publisher remains separate', () => fixture(async f => {
  const remote = remoteHead(f), head = commit(f, 'page2.md', `credential ${secret}\n`);
  recordCommit(f.work, { sha: head, writer: 'effect', verified: true });
  const before = snapshot(f), result = await push('managed');
  expect(result).toMatchObject({ code: 5, result: { code: 'blocked_secrets' } });
  expect(JSON.stringify(result)).not.toContain(secret); expect(snapshot(f)).toEqual(before); expect(remoteHead(f)).toBe(remote);
}), 60_000);

test('commit-message secrets and a first push scan the complete history', () => fixture(async f => {
  const remote = remoteHead(f);
  writeFileSync(join(f.work, 'ok.md'), 'safe\n'); git(f.work, 'add', 'ok.md'); git(f.work, 'commit', '-qm', `credential ${secret}`);
  git(f.work, 'config', 'branch.main.merge', 'refs/heads/new-branch');
  const before = snapshot(f), result = await push('managed');
  expect(result).toMatchObject({ code: 5, result: { code: 'publish_secret_found' } });
  expect(result.result.reason).toContain('(commit message)'); expect(JSON.stringify(result)).not.toContain(secret);
  expect(remoteHead(f)).toBe(remote); expect(git(f.remote, 'branch', '--list', 'new-branch')).toBe(''); expect(snapshot(f)).toEqual(before);
}), 60_000);

test('replace refs and grafts cannot hide an unpublished historical secret', () => fixture(async f => {
  const base = remoteHead(f);
  commit(f, 'secret.md', secret);
  const head = commit(f, 'secret.md', 'removed from the latest tree\n');
  git(f.work, 'replace', '--graft', head, base);
  writeFileSync(join(f.work, '.git', 'info', 'grafts'), `${head} ${base}\n`);
  const before = snapshot(f), result = await push('managed');
  expect(result).toMatchObject({ code: 5, result: { code: 'blocked_secrets' } });
  expect(result.result.reason).toContain('secret.md'); expect(JSON.stringify(result)).not.toContain(secret);
  expect(remoteHead(f)).toBe(base); expect(snapshot(f)).toEqual(before);
}), 60_000);

test('a branch without a tracking remote does not commit or invent a destination', () => fixture(async f => {
  git(f.work, 'branch', '--unset-upstream');
  writeFileSync(join(f.work, 'page.md'), 'local dirty bytes\n');
  const before = snapshot(f), remote = remoteHead(f);
  expect(await push('managed')).toMatchObject({ code: 0, result: { status: 'skipped', reason: 'no_tracking_remote', committed: false } });
  expect(snapshot(f)).toEqual(before); expect(remoteHead(f)).toBe(remote);
}), 60_000);

test('a merge cannot hide an intermediate secret or deny path', () => fixture(async f => {
  const remote = remoteHead(f);
  git(f.work, 'checkout', '-qb', 'side');
  commit(f, '.env', 'safe-looking denied path\n');
  git(f.work, 'rm', '-q', '.env'); git(f.work, 'commit', '-qm', 'remove denied path');
  git(f.work, 'checkout', '-q', 'main'); commit(f, 'main.md', 'main side\n');
  git(f.work, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side');
  const before = snapshot(f);
  expect(await push('managed')).toMatchObject({ code: 5, result: { code: 'blocked_tracked_deny' } });
  expect(remoteHead(f)).toBe(remote); expect(snapshot(f)).toEqual(before);
}), 60_000);

test('a remote that advances refuses rather than importing or merging its work', () => fixture(async f => {
  commit(f, 'ours.md', 'ours\n');
  const other = join(f.home, 'other'); git(f.home, 'clone', '-q', f.remote, other);
  git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(other, 'theirs.md'), 'theirs\n'); git(other, 'add', 'theirs.md');
  git(other, 'commit', '-qm', 'remote'); git(other, 'push', '-q', 'origin', 'main');
  const remote = remoteHead(f), before = snapshot(f), result = await push('managed');
  expect(result).toMatchObject({ code: 1, result: { code: 'push_unconfirmed' } });
  expect(remoteHead(f)).toBe(remote); expect(snapshot(f)).toEqual(before); expect(existsSync(join(f.work, 'theirs.md'))).toBe(false);
}), 60_000);

test('a binding path that no longer matches the source cannot authorize a push', () => fixture(async f => {
  commit(f, 'pending.md', 'pending\n');
  const remote = remoteHead(f), before = snapshot(f);
  await engine.executeRaw("UPDATE persistence_source_bindings SET relative_path='different' WHERE source_id='managed'");
  expect(await push('managed')).toMatchObject({ code: 1, result: { code: 'owner_unavailable' } });
  expect(remoteHead(f)).toBe(remote); expect(snapshot(f)).toEqual(before);
}), 60_000);

test('owner and publish locks exclude the retry; draining and foreign ownership refuse', () => fixture(async f => {
  commit(f, 'waiting.md', 'safe\n'); const remote = remoteHead(f), before = snapshot(f);
  const lock = await acquireWorktree(f.binding, 0);
  expect(lock).not.toBeNull();
  try { expect(await push('managed')).toMatchObject({ code: 0, result: { status: 'skipped_in_flight' } }); }
  finally { await lock!.release(); }
  const publish = await acquireNativeLock(join(f.work, '.git', 'brain-publish.lock'), { timeoutMs: 0 });
  expect(publish).not.toBeNull();
  try { expect(await push('managed')).toMatchObject({ code: 0, result: { status: 'skipped', reason: 'publish_in_flight' } }); }
  finally { await publish!.release(); }
  await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
  expect(await push('managed')).toMatchObject({ code: 1, result: { code: 'owner_unavailable' } });
  await engine.executeRaw("UPDATE persistence_worktrees SET state='active',owner_host_id=gen_random_uuid() WHERE id=$1::uuid", [f.binding.worktree_id]);
  expect(await push('managed')).toMatchObject({ code: 1, result: { code: 'owner_unavailable' } });
  expect(remoteHead(f)).toBe(remote); expect(snapshot(f)).toEqual(before);
}), 60_000);

test('managed options, stale source identity and oversized blobs refuse without touching the checkout', () => fixture(async f => {
  const remote = remoteHead(f);
  commit(f, 'large.bin', ''); truncateSync(join(f.work, 'large.bin'), SCAN_MAX_FILE_BYTES + 1);
  git(f.work, 'add', 'large.bin'); git(f.work, 'commit', '-qm', 'large');
  const before = snapshot(f);
  for (const args of [['--branch', 'other'], ['--message', 'test'], ['--allow-unverified-remote']]) {
    expect(await push('managed', ...args)).toMatchObject({ code: 1, result: { code: 'invalid_params' } });
  }
  expect(await push('managed')).toMatchObject({ code: 5, result: { code: 'publish_scan_unreadable' } });
  await engine.executeRaw('UPDATE persistence_source_bindings SET source_incarnation=gen_random_uuid() WHERE source_id=$1', ['managed']);
  expect(await push('managed')).toMatchObject({ code: 1, result: { code: 'owner_unavailable' } });
  expect(remoteHead(f)).toBe(remote); expect(snapshot(f)).toEqual(before);
}), 90_000);

test('the scanned object id is pushed even if another writer moves HEAD just before transport', () => fixture(async f => {
  const safe = commit(f, 'safe.md', 'safe\n');
  const dangerous = commit(f, 'later.md', secret);
  git(f.work, 'reset', '--hard', '-q', safe);
  const bin = join(f.home, 'bin'); mkdirSync(bin);
  const actual = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in *" push "*) '${actual}' -C '${f.work}' update-ref HEAD '${dangerous}' '${safe}' ;; esac\nexec '${actual}' "$@"\n`);
  chmodSync(wrapper, 0o700);
  const result = await withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => push('managed'));
  expect(result).toMatchObject({ code: 0, result: { status: 'pushed', head: safe } });
  expect(git(f.work, 'rev-parse', 'HEAD')).toBe(dangerous); expect(remoteHead(f)).toBe(safe);
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('later.md');
}), 60_000);
