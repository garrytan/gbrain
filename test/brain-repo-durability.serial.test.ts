/**
 * brain-repo-durability core (v0.42.44): hardenBrainRepo / unhardenBrainRepo /
 * acceptPat. Real git against a local bare remote. HOME + GBRAIN_HOME are
 * redirected to a tmp dir; installCron:false so the suite never touches launchd.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  hardenBrainRepo, unhardenBrainRepo, acceptPat,
} from '../src/core/brain-repo-durability.ts';

const PAT = 'ghp_TESTSECRETTOKEN0123456789abcdef';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}
function commitCount(work: string): number {
  return parseInt(git(work, 'rev-list', '--count', 'HEAD'), 10);
}
/** git config read that returns '' instead of throwing when the key is unset. */
function cfg(work: string, key: string): string {
  try { return git(work, 'config', '--local', '--get', key); } catch { return ''; }
}

let root: string;
let work: string;
let bare: string;
let oldHome: string | undefined;
let oldGbrainHome: string | undefined;

function makePair(): void {
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }
}

async function harden(extra: Record<string, unknown> = {}) {
  return hardenBrainRepo({ repoPath: work, sourceId: 'wiki', pat: PAT, installCron: false, ...extra });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brd-'));
  oldHome = process.env.HOME; oldGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  process.env.GBRAIN_HOME = join(process.env.HOME, '.gbrain');
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  makePair();
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
  delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  rmSync(root, { recursive: true, force: true });
});

describe('hardenBrainRepo', () => {
  test('installs hook (local, untracked, +x), helper, and AGENTS rules', async () => {
    const r = await harden();
    // hook
    const hookPath = join(work, '.git', 'hooks', 'post-commit');
    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, 'utf-8')).toContain('post-commit hook');
    expect(statSync(hookPath).mode & 0o111).toBeTruthy(); // executable
    // helper (committed, +x)
    const helperPath = join(work, 'scripts', 'brain-commit-push.sh');
    expect(existsSync(helperPath)).toBe(true);
    expect(statSync(helperPath).mode & 0o111).toBeTruthy();
    // AGENTS.md with managed block + taxonomy
    const agents = readFileSync(join(work, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('BEGIN gbrain-brain-durability');
    expect(agents).toContain('people/');
    expect(agents).toContain('brain-commit-push.sh');
    // verify pushed scaffolding → clean against origin
    expect(r.clean_against_origin).toBe(true);
    expect(r.needs_attention).toEqual([]);
  });

  test('is idempotent — second run adds NO new commit', async () => {
    await harden();
    const after1 = commitCount(work);
    const r2 = await harden();
    expect(commitCount(work)).toBe(after1); // no churn
    // every step is ok/skipped on the second pass (nothing left to fix)
    expect(r2.steps.every(s => s.status === 'ok' || s.status === 'skipped')).toBe(true);
  });

  test('the post-commit hook is UNTRACKED (never committed)', async () => {
    await harden();
    const tracked = git(work, 'ls-files');
    expect(tracked.includes('post-commit')).toBe(false);
    expect(tracked).toContain('scripts/brain-commit-push.sh'); // helper IS tracked
  });

  test('D3 — patches RESOLVER.md when it exists, not AGENTS.md', async () => {
    writeFileSync(join(work, 'RESOLVER.md'), '# my resolver\n\nuser content\n');
    git(work, 'add', 'RESOLVER.md'); git(work, 'commit', '-qm', 'resolver');
    await harden();
    expect(readFileSync(join(work, 'RESOLVER.md'), 'utf-8')).toContain('BEGIN gbrain-brain-durability');
    expect(existsSync(join(work, 'AGENTS.md'))).toBe(false);
  });

  test('AGENTS block patch preserves user content above and below', async () => {
    writeFileSync(join(work, 'AGENTS.md'), '# Top\n\nkeep above\n\n## footer\nkeep below\n');
    git(work, 'add', 'AGENTS.md'); git(work, 'commit', '-qm', 'agents');
    await harden();
    const body = readFileSync(join(work, 'AGENTS.md'), 'utf-8');
    expect(body).toContain('keep above');
    expect(body).toContain('keep below');
    expect(body).toContain('BEGIN gbrain-brain-durability');
    // patch-in-place: exactly one managed block
    expect(body.split('BEGIN gbrain-brain-durability').length - 1).toBe(1);
  });

  test('D11 — writes a repo-scoped credential (0600 store, local config, ownership key)', async () => {
    await harden();
    const store = join(process.env.GBRAIN_HOME!, 'git-credentials');
    expect(existsSync(store)).toBe(true);
    expect(statSync(store).mode & 0o077).toBe(0); // not group/other readable
    expect(git(work, 'config', '--local', '--get', 'credential.helper')).toContain('store --file');
    expect(cfg(work, 'gbrain.durability.managedcredential')).toBe('true');
  });

  test('D11 — reuses an existing credential.helper (no plaintext store written)', async () => {
    git(work, 'config', 'credential.helper', 'osxkeychain');
    await harden();
    const store = join(process.env.GBRAIN_HOME!, 'git-credentials');
    expect(existsSync(store)).toBe(false);
    expect(git(work, 'config', '--local', '--get', 'credential.helper')).toBe('osxkeychain');
  });

  test('PAT never appears in the serialized report', async () => {
    const r = await harden();
    expect(JSON.stringify(r).includes(PAT)).toBe(false);
  });

  test('detached HEAD → pull step needs_attention (refuses to push to a wrong ref)', async () => {
    const sha = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', sha); // detached
    const r = await harden({ verify: false });
    const pull = r.steps.find(s => s.step === 'pull');
    expect(pull?.status).toBe('needs_attention');
  });

  test('D10 — verify reports needs_attention when push-probe fails (read-only/unreachable)', async () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'unreachable.git'));
    const r = await harden();
    const verify = r.steps.find(s => s.step === 'verify');
    expect(verify?.status).toBe('needs_attention');
    expect(r.clean_against_origin).toBe(false);
    expect(r.needs_attention.length).toBeGreaterThan(0);
    // No scaffolding commit when we can't confirm a push.
    expect(r.steps.find(s => s.step === 'commit')).toBeUndefined();
  });

  test('dry-run makes no commit and writes no files', async () => {
    const before = commitCount(work);
    await harden({ dryRun: true });
    expect(commitCount(work)).toBe(before);
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(false);
  });
});

describe('unhardenBrainRepo', () => {
  test('removes hook + credential wiring; leaves committed content', async () => {
    await harden();
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(existsSync(join(work, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(cfg(work, 'gbrain.durability.managedcredential')).toBe('');
    // committed helper stays
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(true);
    expect(steps.find(s => s.step === 'hook')?.status).toBe('fixed');
  });

  test('idempotent when not hardened (all skipped)', async () => {
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(steps.every(s => s.status === 'skipped')).toBe(true);
  });
});

describe('acceptPat (D8)', () => {
  test('reads + trims a pat-file', () => {
    const p = join(root, 'pat.txt');
    writeFileSync(p, `${PAT}\n`, { mode: 0o600 });
    const r = acceptPat({ patFile: p });
    expect(r?.token).toBe(PAT);
    expect(r?.warnings).toEqual([]);
  });
  test('throws on a missing pat-file', () => {
    expect(() => acceptPat({ patFile: join(root, 'nope.txt') })).toThrow();
  });
  test('throws on an empty pat-file', () => {
    const p = join(root, 'empty.txt'); writeFileSync(p, '   \n', { mode: 0o600 });
    expect(() => acceptPat({ patFile: p })).toThrow();
  });
  test('warns (but continues) on loose perms', () => {
    const p = join(root, 'loose.txt'); writeFileSync(p, PAT); chmodSync(p, 0o644);
    const r = acceptPat({ patFile: p });
    expect(r?.token).toBe(PAT);
    expect(r?.warnings.length).toBeGreaterThan(0);
  });
  test('falls back to GBRAIN_GITHUB_PAT env', () => {
    const old = process.env.GBRAIN_GITHUB_PAT;
    process.env.GBRAIN_GITHUB_PAT = PAT;
    try { expect(acceptPat({})?.source).toBe('env:GBRAIN_GITHUB_PAT'); }
    finally { if (old === undefined) delete process.env.GBRAIN_GITHUB_PAT; else process.env.GBRAIN_GITHUB_PAT = old; }
  });
  test('returns null when no PAT is available', () => {
    const old = process.env.GBRAIN_GITHUB_PAT; delete process.env.GBRAIN_GITHUB_PAT;
    try { expect(acceptPat({})).toBeNull(); }
    finally { if (old !== undefined) process.env.GBRAIN_GITHUB_PAT = old; }
  });
});
