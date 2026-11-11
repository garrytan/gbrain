/**
 * #8902: policy and durability automatic publishes must scan earlier local history,
 * not only the files they just wrote. Real entry points and local bare remotes;
 * synthetic credentials only. HOME/config and file transport are process-wide.
 * A later removal does not erase an earlier secret, refusals preserve committed
 * work and never leak values, and a clean retry still publishes normally.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPolicyFile, POLICY_FILE } from '../src/core/access/policy-git.ts';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const token = 'ghp_' + 'Zt4q'.repeat(9);
let dir: string, root: string, remote: string, base: string;
let saved: Record<string, string | undefined>;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args],
  { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const remoteTip = () => git(remote, 'rev-parse', 'refs/heads/main');
const commit = (text: string, message = 'local edit') => {
  writeFileSync(join(root, 'notes.md'), text);
  git(root, 'add', 'notes.md'); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
};
const policy = () => commitPolicyFile(root, POLICY_FILE, () => 'version: 1\nrules: []\n', 'update folder policy');

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-auto-publish-')));
  saved = { HOME: process.env.HOME, GBRAIN_HOME: process.env.GBRAIN_HOME, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT };
  process.env.HOME = dir;
  process.env.GBRAIN_HOME = dir;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  remote = join(dir, 'origin.git'); root = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  commit('initial\n'); git(root, 'push', '-q', '-u', 'origin', 'main');
  base = remoteTip();
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('policy publish refuses an earlier removed secret and retains its local policy commit', async () => {
  const secretCommit = commit(`deploy ${token}\n`);
  commit('removed credential\n');
  const error = await policy().then(() => null, e => e as OperationError);
  expect(error?.code).toBe('publish_secret_found');
  expect(error?.message).toContain(secretCommit.slice(0, 7));
  expect(error?.message).toContain('notes.md:1');
  expect(JSON.stringify(error)).not.toContain(token);
  expect(remoteTip()).toBe(base);
  expect(git(root, 'show', `HEAD:${POLICY_FILE}`)).toBe('version: 1\nrules: []');
  expect(readFileSync(join(root, POLICY_FILE), 'utf8')).toBe('version: 1\nrules: []\n');
  expect(git(root, 'status', '--porcelain')).toBe('');
  // No new YAML change on retry: retained history must still refuse.
  const retry = await policy().then(() => null, e => e as OperationError);
  expect(retry?.code).toBe('publish_secret_found');
  expect(remoteTip()).toBe(base);
}, 60_000);

test('policy publish scans earlier commit messages, and its clean range still publishes', async () => {
  commit('safe contents\n', `rotate ${token}`);
  const error = await policy().then(() => null, e => e as OperationError);
  expect(error?.code).toBe('publish_secret_found');
  expect(error?.message).toContain('(commit message)');
  expect(remoteTip()).toBe(base);
  // Remove only this synthetic unpublished history, then exercise the real clean entry point.
  git(root, 'reset', '--hard', base);
  commit('clean earlier work\n');
  expect((await policy()).outcome).toBe('pushed');
  expect(remoteTip()).toBe(git(root, 'rev-parse', 'HEAD'));
}, 60_000);

test('durability scaffolding refuses earlier secret history instead of reporting a clean backup', async () => {
  commit(`deploy ${token}\n`); commit('removed credential\n');
  const report = await hardenBrainRepo({ repoPath: root, sourceId: 'wiki', installCron: false });
  expect(remoteTip()).toBe(base);
  expect(report.clean_against_origin).toBe(false);
  expect(report.steps.find(s => s.step === 'commit')).toMatchObject({ status: 'needs_attention' });
  expect(report.needs_attention.join(' ')).toContain('secret');
  expect(JSON.stringify(report)).not.toContain(token);
  expect(git(root, 'show', 'HEAD:scripts/brain-commit-push.sh')).toContain('gbrain');
}, 60_000);

test('durability scaffolding still publishes clean prior work', async () => {
  commit('clean earlier work\n');
  const report = await hardenBrainRepo({ repoPath: root, sourceId: 'wiki', installCron: false });
  expect(report.needs_attention).toEqual([]);
  expect(report.clean_against_origin).toBe(true);
  expect(remoteTip()).toBe(git(root, 'rev-parse', 'HEAD'));
}, 60_000);

test('policy publish rechecks a rewound remote rather than trusting a stale tracking ref', async () => {
  commit(`deploy ${token}\n`); commit('removed credential\n');
  git(root, 'push', '-q');
  git(remote, 'update-ref', 'refs/heads/main', base);
  const error = await policy().then(() => null, e => e as OperationError);
  expect(error?.code).toBe('publish_secret_found');
  expect(remoteTip()).toBe(base);
  expect(JSON.stringify(error)).not.toContain(token);
}, 60_000);

test('a policy write with no remote remains a local commit, not a secret-scan refusal', async () => {
  git(root, 'remote', 'remove', 'origin');
  commit(`deploy ${token}\n`);
  const result = await policy();
  expect(result.outcome).toBe('committed_local');
  expect(result.note).toContain('nothing was pushed');
  expect(remoteTip()).toBe(base);
  expect(git(root, 'show', `HEAD:${POLICY_FILE}`)).toContain('version: 1');
}, 60_000);
