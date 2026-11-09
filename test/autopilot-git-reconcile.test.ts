/**
 * Autopilot reconciles Git checkouts inside the daemon (so it works on PGLite, whose data directory the daemon holds),
 * without blocking it: the daemon's event loop keeps running (lease renewals, heartbeat) while a publish child pushes,
 * a refusal comes back as a log line, and a hung child is killed at its bound.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autopilotReconcile } from '../src/commands/autopilot-git-reconcile.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'autopilot-git-reconcile-')));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const realCli = join(dir, 'gbrain');
let engine: PGLiteEngine;

beforeAll(async () => {
  writeFileSync(realCli, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, '..', 'src', 'cli.ts')}' "$@"\n`);
  chmodSync(realCli, 0o755);
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

function source(name: string): { root: string; remote: string } {
  const remote = join(dir, `${name}.git`), root = join(dir, name);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes', 'a.md'), 'start\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init'); git(root, 'push', '-q', '-u', 'origin', 'main');
  return { root, remote };
}
async function only(name: string, root: string, remote: string) {
  await engine.executeRaw('DELETE FROM sources WHERE id <> $1', ['default']);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb)', [name, root, JSON.stringify({ remote_url: remote, managed_clone: true })]);
}
function wrapper(name: string, onPush: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ncase " $* " in *" --push-only "*) ${onPush};; esac\nexec '${realCli}' "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

test('the event loop keeps ticking while a publish child runs, and the publish is logged', async () => {
  const s = source('slow');
  await only('slow-source', s.root, s.remote);
  writeFileSync(join(s.root, 'notes', 'b.md'), 'stranded\n'); git(s.root, 'add', '.'); git(s.root, 'commit', '-qm', 'stranded');
  const local = git(s.root, 'rev-parse', 'HEAD');
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 50);
  const started = Date.now();
  const outcome = await withEnv({ ...identity, GBRAIN_JOB_CHILD_CLI: wrapper('slow.sh', 'sleep 2') }, () => autopilotReconcile(engine)).finally(() => clearInterval(timer));
  expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  expect(ticks).toBeGreaterThanOrEqual(25);
  expect(outcome).toEqual({ ok: true, lines: ['slow-source: published'] });
  expect(git(s.remote, 'rev-parse', 'refs/heads/main')).toBe(local);
  expect(await withEnv({ ...identity, GBRAIN_JOB_CHILD_CLI: realCli }, () => autopilotReconcile(engine))).toEqual({ ok: true, lines: [] });
}, 120_000);

test('a refusal that needs the user is reported, not thrown, and nothing is pushed', async () => {
  const s = source('secret');
  await only('secret-source', s.root, s.remote);
  const before = git(s.remote, 'rev-parse', 'refs/heads/main');
  writeFileSync(join(s.root, 'notes', 'key.md'), `token ${'ghp_' + 'Zt4q'.repeat(9)}\n`); git(s.root, 'add', '.'); git(s.root, 'commit', '-qm', 'oops');
  const outcome = await withEnv({ ...identity, GBRAIN_JOB_CHILD_CLI: realCli }, () => autopilotReconcile(engine));
  expect(outcome.ok).toBe(false);
  expect(outcome.lines).toHaveLength(1);
  expect(outcome.lines[0]).toStartWith('secret-source: needs_user publish_secret_found: ');
  expect(outcome.lines[0]).not.toContain('Zt4q');
  expect(git(s.remote, 'rev-parse', 'refs/heads/main')).toBe(before);
}, 120_000);

test('a publish child that hangs past its bound is killed and reported as retryable', async () => {
  const s = source('hang');
  await only('hang-source', s.root, s.remote);
  writeFileSync(join(s.root, 'notes', 'c.md'), 'stuck\n'); git(s.root, 'add', '.'); git(s.root, 'commit', '-qm', 'stuck');
  const started = Date.now();
  const outcome = await withEnv({ ...identity, GBRAIN_JOB_CHILD_CLI: wrapper('hang.sh', 'exec sleep 30') }, () => autopilotReconcile(engine, { childTimeoutMs: 500 }));
  expect(Date.now() - started).toBeLessThan(20_000);
  expect(outcome.ok).toBe(false);
  expect(outcome.lines[0]).toStartWith('hang-source: failed push_unconfirmed: ');
}, 120_000);
