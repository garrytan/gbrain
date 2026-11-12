/**
 * #8902: four pushes from an unmanaged checkout publish every local commit the remote lacks, so each scans that range,
 * not only what it just wrote: the access-policy commit, the durability-scaffolding commit, `gbrain sources push` and the
 * first push of `gbrain bootstrap repo`. The policy commit and sources push keep the commit and report the refusal
 * (committed_not_pushed, blocked_history; GST-2456); the other two throw it. Real git against local bare remotes (bootstrap's remote must be a GitHub URL,
 * so its gh calls and its push are faked and recorded); synthetic credentials only. HOME, GBRAIN_HOME and the file
 * transport switch are process-wide.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPolicyFile, POLICY_FILE } from '../src/core/access/policy-git.ts';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';
import { createPrivateRepo, type ExecRunner, type RepoReceipt } from '../src/core/bootstrap/repo.ts';
import { writeManifest, writeReceipt } from '../src/core/bootstrap/format.ts';
import { defaultRunner } from '../src/core/repo-visibility.ts';
import { workspacePush, type WorkspacePushResult } from '../src/core/workspace-push.ts';
import { SCAN_ALLOW_FILENAME } from '../src/core/secret-scan.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const T = 60_000;
const TOKEN = 'ghp_' + 'Qx7v'.repeat(9);
let dir: string, root: string, remote: string, base: string;
let saved: Record<string, string | undefined>;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args],
  { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const remoteTip = () => git(remote, 'rev-parse', 'refs/heads/main');
const plainCommit = (file: string, text: string, message = 'script edit') => {
  writeFileSync(join(root, file), text);
  git(root, 'add', file); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
};
/** A credential committed by a script and removed by its next commit: only the history holds it. */
const removedSecret = () => { const sha = plainCommit('notes.md', `deploy ${TOKEN}\n`); plainCommit('notes.md', 'removed\n'); return sha; };
const refusal = (p: Promise<unknown>) => p.then(() => null, e => e as OperationError);
const expectRedactedRefusal = (error: OperationError | null, code = 'publish_secret_found') => {
  expect(error).toBeInstanceOf(OperationError);
  expect(error?.code).toBe(code);
  expect(JSON.stringify({ message: error?.message, suggestion: error?.suggestion, detail: error?.detail })).not.toContain(TOKEN);
};
const policy = () => commitPolicyFile(root, POLICY_FILE, () => 'version: 1\nrules: []\n', 'update folder policy');
const sourcesPush = () => workspacePush({ dir: root, branch: 'main', allowUnverifiedRemote: true });
/** A policy commit the range scan refused: committed here, reported committed_not_pushed with the refusal (never a value) in its note. */
const keptLocal = async (p: ReturnType<typeof policy>, code = 'publish_secret_found') => {
  const receipt = await p;
  expect(receipt.outcome).toBe('committed_not_pushed');
  expect(receipt.commit).toBe(git(root, 'rev-parse', 'HEAD'));
  expect(receipt.note).toContain(code);
  expect(JSON.stringify(receipt)).not.toContain(TOKEN);
  return receipt;
};
/** A sources push the range scan refused: a blocked_history result naming the refusal, never a value. */
const blocked = async (p: Promise<WorkspacePushResult>, code = 'publish_secret_found') => {
  const result = await p;
  expect(result).toMatchObject({ ok: false, status: 'blocked_history', code });
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  return result;
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-8902-')));
  saved = { HOME: process.env.HOME, GBRAIN_HOME: process.env.GBRAIN_HOME, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT };
  process.env.HOME = dir;
  process.env.GBRAIN_HOME = dir;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  remote = join(dir, 'origin.git'); root = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', remote, root], { stdio: 'ignore', env: process.env });
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  plainCommit('README.md', 'initial\n', 'initial'); git(root, 'push', '-q', '-u', 'origin', 'main');
  base = remoteTip();
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('access-policy commit', () => {
  test('refuses a credential an earlier commit added and a later one removed; keeps the policy commit local', async () => {
    const secret = removedSecret();
    const receipt = await keptLocal(policy());
    expect(receipt.note).toContain(`notes.md:1`);
    expect(receipt.note).toContain(secret.slice(0, 7));
    expect(remoteTip()).toBe(base);
    expect(git(root, 'show', `HEAD:${POLICY_FILE}`)).toBe('version: 1\nrules: []');
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, T);

  test('refuses a credential in an earlier commit message', async () => {
    plainCommit('notes.md', 'safe\n', `rotate ${TOKEN}`);
    expect((await keptLocal(policy())).note).toContain('(commit message)');
    expect(remoteTip()).toBe(base);
  }, T);

  test('on a remote that has no such branch yet, scans the whole history: clean publishes, a secret refuses', async () => {
    const fresh = join(dir, 'fresh.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', fresh]);
    git(root, 'remote', 'set-url', 'origin', fresh);
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect((await policy()).outcome).toBe('pushed');
    expect(git(fresh, 'rev-parse', 'refs/heads/main')).toBe(git(root, 'rev-parse', 'HEAD'));
    const other = join(dir, 'other.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', other]);
    git(root, 'remote', 'set-url', 'origin', other);
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
    git(root, 'commit', '-q', '--amend', '-m', `policy ${TOKEN}`);
    await keptLocal(commitPolicyFile(root, POLICY_FILE, () => 'version: 1\nrules: [] # again\n', 'policy again'));
    expect(() => git(other, 'rev-parse', '--verify', 'refs/heads/main')).toThrow();
  }, T);

  test('a clean history still publishes, and a checkout without a remote still commits locally', async () => {
    plainCommit('notes.md', 'clean earlier work\n');
    expect((await policy()).outcome).toBe('pushed');
    expect(remoteTip()).toBe(git(root, 'rev-parse', 'HEAD'));
    git(root, 'remote', 'remove', 'origin');
    plainCommit('notes.md', `deploy ${TOKEN}\n`);
    const local = await commitPolicyFile(root, POLICY_FILE, () => 'version: 1\nrules: [] # local\n', 'local policy');
    expect(local.outcome).toBe('committed_local');
  }, T);
});

describe('durability scaffolding commit', () => {
  test('refuses earlier secret history instead of reporting the repo clean against origin', async () => {
    removedSecret();
    const report = await hardenBrainRepo({ repoPath: root, sourceId: 'wiki', installCron: false });
    expect(remoteTip()).toBe(base);
    expect(report.clean_against_origin).toBe(false);
    expect(report.steps.find(s => s.step === 'commit')?.detail).toContain('publish_secret_found');
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  }, T);

  test('refuses a credential in an earlier commit message', async () => {
    plainCommit('notes.md', 'safe\n', `rotate ${TOKEN}`);
    const report = await hardenBrainRepo({ repoPath: root, sourceId: 'wiki', installCron: false });
    expect(remoteTip()).toBe(base);
    expect(report.steps.find(s => s.step === 'commit')?.detail).toContain('publish_secret_found');
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  }, T);

  test('clean prior work still publishes with the scaffolding', async () => {
    plainCommit('notes.md', 'clean earlier work\n');
    const report = await hardenBrainRepo({ repoPath: root, sourceId: 'wiki', installCron: false });
    expect(report.needs_attention).toEqual([]);
    expect(report.clean_against_origin).toBe(true);
    expect(remoteTip()).toBe(git(root, 'rev-parse', 'HEAD'));
  }, T);
});

describe('gbrain sources push', () => {
  test('with nothing new to commit, refuses the earlier commits it would push and keeps them local', async () => {
    const head = (removedSecret(), git(root, 'rev-parse', 'HEAD'));
    await blocked(sourcesPush());
    expect(remoteTip()).toBe(base);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  }, T);

  test('refuses when it also commits new clean work, and keeps that commit', async () => {
    removedSecret();
    writeFileSync(join(root, 'page.md'), 'new page\n');
    await blocked(sourcesPush());
    expect(remoteTip()).toBe(base);
    expect(git(root, 'show', 'HEAD:page.md')).toBe('new page');
  }, T);

  test('refuses a credential in an earlier commit message', async () => {
    plainCommit('notes.md', 'safe\n', `rotate ${TOKEN}`);
    expect((await blocked(sourcesPush())).reason).toContain('(commit message)');
    expect(remoteTip()).toBe(base);
  }, T);

  test('an allowlist edit it commits itself still publishes; one a script committed refuses', async () => {
    plainCommit('notes.md', `key ${TOKEN}\n`);
    const first = await blocked(sourcesPush());
    const fingerprint = (JSON.parse(String(first.detail)) as { findings: Array<{ fingerprint: string }> }).findings[0]!.fingerprint;
    writeFileSync(join(root, SCAN_ALLOW_FILENAME), `${fingerprint}\n`);
    expect((await sourcesPush()).status).toBe('pushed');
    expect(remoteTip()).toBe(git(root, 'rev-parse', 'HEAD'));
    const published = remoteTip();
    plainCommit(SCAN_ALLOW_FILENAME, `${fingerprint}\n**/*.env\n`);
    expect((await blocked(sourcesPush())).reason).toContain(SCAN_ALLOW_FILENAME);
    expect(remoteTip()).toBe(published);
  }, T);

  test('commits a rewound remote dropped are scanned again, not trusted from the tracking ref', async () => {
    removedSecret();
    git(root, 'push', '-q');
    git(remote, 'update-ref', 'refs/heads/main', base);
    await blocked(sourcesPush());
    expect(remoteTip()).toBe(base);
  }, T);

  test('a clean history still pushes', async () => {
    plainCommit('notes.md', 'clean earlier work\n');
    const result = await sourcesPush();
    expect(result.status).toBe('pushed');
    expect(remoteTip()).toBe(git(root, 'rev-parse', 'HEAD'));
  }, T);
});

describe('gbrain bootstrap repo, first push after the remote branch is gone', () => {
  const url = 'https://github.com/alice-example/agent-workspace';
  let pushes: string[][];
  const runner: ExecRunner = async argv => {
    const joined = argv.join(' ');
    if (argv[0] === 'gh') {
      if (joined.includes('--version')) return { code: 0, stdout: 'gh version 2.97.0 (2026-07-31)\n', stderr: '' };
      if (joined.includes('api user')) return { code: 0, stdout: '{"login":"alice-example","id":1}\n', stderr: '' };
      if (joined.includes('--jq .private')) return { code: 0, stdout: 'true\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }
    if (argv.includes('push')) { pushes.push(argv); return { code: 0, stdout: '', stderr: '' }; }
    if (argv.includes('ls-remote')) return { code: 0, stdout: '', stderr: '' };
    if (joined.endsWith('remote get-url origin')) return { code: 0, stdout: `${url}\n`, stderr: '' };
    return defaultRunner(argv);
  };
  const bootstrap = () => createPrivateRepo(root, { runner, gbrainHomeDir: join(dir, 'gbrain-home') });

  beforeEach(() => {
    pushes = [];
    git(root, 'remote', 'set-url', 'origin', url);
    writeManifest(root, { format_version: 1, initialized: true, agent_name: 'Example Agent', created_by: '0.0.0-test', created_at: '2026-01-01T00:00:00.000Z', source_id: 'workspace' });
    writeFileSync(join(root, 'GITHUB.md'), `Backed up to **${url}**.\n`);
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'render');
    mkdirSync(join(dir, 'gbrain-home', 'bootstrap'), { recursive: true });
    writeReceipt(join(dir, 'gbrain-home'), { receipt_version: 1, workspace_dir: root, source_id: 'workspace', agent_name: 'Example Agent',
      created_at: '2026-01-01T00:00:00.000Z', created_by: '0.0.0-test', brain_created_by_bootstrap: false, created_paths: [], registrations: [], repo_url: url } as RepoReceipt);
  });

  test('refuses a credential anywhere in the history and never pushes', async () => {
    removedSecret();
    expectRedactedRefusal(await refusal(bootstrap()));
    expect(pushes).toEqual([]);
  }, T);

  test('refuses a credential in an earlier commit message and never pushes', async () => {
    plainCommit('notes.md', 'safe\n', `rotate ${TOKEN}`);
    const error = await refusal(bootstrap());
    expectRedactedRefusal(error);
    expect(error?.message).toContain('(commit message)');
    expect(pushes).toEqual([]);
  }, T);

  test('on a detached HEAD, scans the branch it pushes, not HEAD', async () => {
    removedSecret();
    git(root, 'checkout', '-q', '--detach', 'HEAD~2');
    expectRedactedRefusal(await refusal(bootstrap()));
    expect(pushes).toEqual([]);
  }, T);

  test('a clean history still completes the first push', async () => {
    plainCommit('notes.md', 'clean earlier work\n');
    expect((await bootstrap()).reused).toBe(true);
    expect(pushes).toEqual([['git', '-C', root, 'push', '-u', 'origin', 'main', '--no-follow-tags', '--recurse-submodules=no']]);
    expect(readFileSync(join(root, 'GITHUB.md'), 'utf8')).toContain(url);
  }, T);
});
