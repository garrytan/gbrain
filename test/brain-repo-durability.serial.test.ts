/**
 * brain-repo-durability core (v0.42.44): hardenBrainRepo / unhardenBrainRepo /
 * acceptPat. Real git against a local bare remote. HOME + GBRAIN_HOME are
 * redirected to a tmp dir; installCron:false so the suite never touches launchd.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, chmodSync } from 'fs';
import { join, dirname, relative } from 'path';
import { tmpdir } from 'os';
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import {
  hardenBrainRepo, unhardenBrainRepo, acceptPat, maintainPushLog, isDurabilityHardened,
  type DurabilityReport, type DurabilityStep,
} from '../src/core/brain-repo-durability.ts';
// Namespace import: a missing export fails only the tests that use it.
import * as durability from '../src/core/brain-repo-durability.ts';
import { canonicalFilesystemPath, recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { assertManagedFilesystemWrite } from '../src/core/persistence/filesystem-guard.ts';

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
  // CX2-8: GBRAIN_HOME is a PARENT dir (config.ts semantics — `.gbrain` is
  // appended by the resolver), so the effective home is $HOME/.gbrain.
  process.env.GBRAIN_HOME = process.env.HOME;
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
    const store = join(process.env.HOME!, '.gbrain', 'git-credentials');
    expect(existsSync(store)).toBe(true);
    expect(statSync(store).mode & 0o077).toBe(0); // not group/other readable
    expect(git(work, 'config', '--local', '--get', 'credential.helper')).toContain('store --file');
    expect(cfg(work, 'gbrain.durability.managedcredential')).toBe('true');
  });

  test('D11 — reuses an existing credential.helper (no plaintext store written)', async () => {
    git(work, 'config', 'credential.helper', 'osxkeychain');
    await harden();
    const store = join(process.env.HOME!, '.gbrain', 'git-credentials');
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

  test('dry-run does not fetch or pull from origin', async () => {
    const secondClone = mkdtempSync(join(root, 'pusher-'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, secondClone], { stdio: 'ignore' });
    execFileSync('git', ['-C', secondClone, 'config', 'user.email', 't@t.t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', secondClone, 'config', 'user.name', 'tester'], { stdio: 'ignore' });
    writeFileSync(join(secondClone, 'upstream.md'), 'new upstream content\n');
    execFileSync('git', ['-C', secondClone, 'add', 'upstream.md'], { stdio: 'ignore' });
    execFileSync('git', ['-C', secondClone, 'commit', '-qm', 'advance origin'], { stdio: 'ignore' });
    execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', secondClone, 'push', '-q', 'origin', 'main'], { stdio: 'ignore' });

    const headBefore = git(work, 'rev-parse', 'HEAD');
    const trackingBefore = git(work, 'rev-parse', 'refs/remotes/origin/main');
    const report = await harden({ dryRun: true });

    expect(git(work, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(existsSync(join(work, 'upstream.md'))).toBe(false);
    expect(git(work, 'rev-parse', 'refs/remotes/origin/main')).toBe(trackingBefore);
    expect(existsSync(join(work, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(report.steps.find(step => step.step === 'pull')?.status).toBe('skipped');
  });

  test('dry-run does not chmod an already-current helper (#3736)', async () => {
    await harden(); // real run installs scripts/brain-commit-push.sh at 0o755
    const helperPath = join(work, 'scripts', 'brain-commit-push.sh');
    chmodSync(helperPath, 0o644); // simulate perms drifting away from +x, content unchanged
    await harden({ dryRun: true });
    expect(statSync(helperPath).mode & 0o777).toBe(0o644); // untouched — preview must not mutate
  });

  test('non-dry-run restores the exec bit on an already-current helper', async () => {
    await harden();
    const helperPath = join(work, 'scripts', 'brain-commit-push.sh');
    chmodSync(helperPath, 0o644);
    await harden();
    expect(statSync(helperPath).mode & 0o111).toBeTruthy(); // exec bit restored
  });

  test('CX2-3 — parent-repo-aware: a subdirectory target hardens the repo ROOT', async () => {
    // Workspace layout: the source dir is `repo/brain` while the enclosing
    // repo owns `.git`. Pre-fix the `.git` assertion failed on the subdir.
    const sub = join(work, 'brain');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'note.md'), '# note\n');
    git(work, 'add', 'brain/note.md'); git(work, 'commit', '-qm', 'brain dir');
    const r = await hardenBrainRepo({ repoPath: sub, sourceId: 'wiki', pat: PAT, installCron: false });
    expect(r.repo_path).toBe(git(work, 'rev-parse', '--show-toplevel'));
    // scaffolding landed at the ROOT, not inside brain/
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(true);
    expect(existsSync(join(sub, 'scripts'))).toBe(false);
    expect(r.needs_attention).toEqual([]);
  });

  test('S3#10 — maintainPushLog chmods 0600 and rotates at 1MB', async () => {
    const home = join(process.env.HOME!, '.gbrain');
    mkdirSync(home, { recursive: true });
    const log = join(home, 'brain-push.log');
    writeFileSync(log, 'x'.repeat(1024 * 1024 + 1), { mode: 0o644 });
    maintainPushLog();
    // rotated: predecessor kept as .1, fresh log is empty + 0600
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(readFileSync(log, 'utf-8')).toBe('');
    expect(statSync(log).mode & 0o077).toBe(0);
    // small log: chmod only, no rotation
    rmSync(`${log}.1`);
    writeFileSync(log, 'small\n', { mode: 0o644 });
    maintainPushLog();
    expect(existsSync(`${log}.1`)).toBe(false);
    expect(readFileSync(log, 'utf-8')).toBe('small\n');
    expect(statSync(log).mode & 0o077).toBe(0);
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

// ── #5182: managed canonical worktrees opt into git effects via repo-local config ──

const MANAGED_KEY = 'gbrain.durability.managed';
const LEGACY_BANNER = '# gbrain brain-durability post-commit hook (v0.42.44+)';

/** Every file under `dir` (relative path → content digest / link target / '<dir>'). */
function snapshotTree(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full);
      if (skip(rel)) continue;
      if (entry.isDirectory()) { out[rel] = '<dir>'; walk(full); }
      else if (entry.isSymbolicLink()) out[rel] = `-> ${readFileSync(full, 'utf-8')}`;
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
/** Worktree files outside .git plus the hooks/refs state inside it (config is compared separately). */
function localState(): Record<string, string> {
  return snapshotTree(work, rel => rel === '.git/config' || rel === '.git/index' || rel === '.git/gbrain-managed.json');
}
function stepMap(r: DurabilityReport): Record<string, string> { return Object.fromEntries(r.steps.map(s => [s.step, s.status])); }
function stepOf(r: DurabilityReport, name: string): DurabilityStep | undefined { return r.steps.find(s => s.step === name); }
function configBytes(): string { return readFileSync(join(work, '.git', 'config'), 'utf-8'); }
function markManaged(): void { recordManagedRoots(randomUUID(), [{ local_path: work }]); }
function markOwnerClaimOnly(): void { writeFileSync(join(work, '.gbrain-owner.json'), '{"version":1}'); }
function markSiblingReservation(): void {
  const digest = createHash('sha256').update(canonicalFilesystemPath(work)).digest('hex');
  writeFileSync(join(dirname(canonicalFilesystemPath(work)), `.gbrain-owner-${digest}.json`), '{"version":1}');
}
function advanceOrigin(): void {
  const second = mkdtempSync(join(root, 'pusher-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, second], { stdio: 'ignore' });
  execFileSync('git', ['-C', second, 'config', 'user.email', 't@t.t'], { stdio: 'ignore' });
  execFileSync('git', ['-C', second, 'config', 'user.name', 'tester'], { stdio: 'ignore' });
  writeFileSync(join(second, 'upstream.md'), 'new upstream content\n');
  execFileSync('git', ['-C', second, 'add', 'upstream.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', second, 'commit', '-qm', 'advance origin'], { stdio: 'ignore' });
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', second, 'push', '-q', 'origin', 'main'], { stdio: 'ignore' });
}
const MANAGED_REAL_STEPS = { pull: 'skipped', credential: 'fixed', outbox: 'fixed', hook: 'skipped', helper: 'skipped',
  agents: 'skipped', cron: 'skipped', verify: 'ok' };

describe('managed root (#5182)', () => {
  test('real harden writes only the repo-local opt-in: no hook, helper, rules, commit, pull or cron', async () => {
    markManaged();
    const headBefore = git(work, 'rev-parse', 'HEAD');
    const originBefore = git(bare, 'rev-parse', 'refs/heads/main');
    const trackingBefore = git(work, 'rev-parse', 'refs/remotes/origin/main');
    const countBefore = commitCount(work);
    const hooksBefore = readdirSync(join(work, '.git', 'hooks')).sort();
    const beforeFiles = localState();
    const r = await harden();

    expect(r.managed).toBe(true);
    expect(Object.keys(stepMap(r))).toEqual(Object.keys(MANAGED_REAL_STEPS));
    expect(stepMap(r)).toEqual(MANAGED_REAL_STEPS);
    expect(stepOf(r, 'commit')).toBeUndefined();
    expect(r.needs_attention).toEqual([]);
    expect(r.clean_against_origin).toBe(true);
    expect(cfg(work, MANAGED_KEY)).toBe('true');
    expect(durability.isManagedGitEffectEnabled(work)).toBe(true);
    expect(isDurabilityHardened(work)).toBe(false); // legacy write-through sinks keep their own gate
    expect(existsSync(join(work, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(readdirSync(join(work, '.git', 'hooks')).sort()).toEqual(hooksBefore);
    expect(existsSync(join(work, 'scripts'))).toBe(false);
    expect(existsSync(join(work, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(work, 'RESOLVER.md'))).toBe(false);
    expect(git(work, 'status', '--porcelain')).toBe('');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(commitCount(work)).toBe(countBefore);
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(originBefore);
    expect(git(work, 'rev-parse', 'refs/remotes/origin/main')).toBe(trackingBefore);
    expect(localState()).toEqual(beforeFiles);
    expect(existsSync(join(process.env.HOME!, '.gbrain', 'brain-push.log'))).toBe(false);
    for (const name of ['pull', 'hook', 'helper', 'agents', 'cron']) expect(stepOf(r, name)?.detail).toContain('managed');
    expect(JSON.stringify(r).includes(PAT)).toBe(false);
  });

  test('never pulls or fetches: an advanced origin leaves the worktree, HEAD and FETCH_HEAD alone', async () => {
    markManaged();
    advanceOrigin();
    const headBefore = git(work, 'rev-parse', 'HEAD');
    const trackingBefore = git(work, 'rev-parse', 'refs/remotes/origin/main');
    const r = await harden();
    expect(git(work, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(work, 'rev-parse', 'refs/remotes/origin/main')).toBe(trackingBefore);
    expect(existsSync(join(work, 'upstream.md'))).toBe(false);
    expect(existsSync(join(work, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(stepOf(r, 'pull')?.status).toBe('skipped');
    expect(cfg(work, MANAGED_KEY)).toBe('true');
  });

  test('is idempotent: the second run is all ok/skipped and leaves .git/config byte-identical', async () => {
    markManaged();
    await harden();
    const config = configBytes();
    const state = localState();
    const r2 = await harden();
    expect(r2.steps.every(s => s.status === 'ok' || s.status === 'skipped')).toBe(true);
    expect(stepOf(r2, 'outbox')?.status).toBe('ok');
    expect(configBytes()).toBe(config);
    expect(localState()).toEqual(state);
  });

  test('without a PAT the credential step is skipped and only the opt-in key is written', async () => {
    markManaged();
    const r = await harden({ pat: undefined });
    expect(stepOf(r, 'credential')?.status).toBe('skipped');
    expect(stepOf(r, 'outbox')?.status).toBe('fixed');
    expect(cfg(work, MANAGED_KEY)).toBe('true');
    expect(cfg(work, 'credential.helper')).toBe('');
    expect(cfg(work, 'gbrain.durability.managedcredential')).toBe('');
  });

  test('--no-verify skips the push probe and still opts in', async () => {
    markManaged();
    const r = await harden({ verify: false });
    expect(stepOf(r, 'verify')?.status).toBe('skipped');
    expect(cfg(work, MANAGED_KEY)).toBe('true');
  });

  test('a failing push probe is needs_attention but the opt-in stays set (the outbox retries pushes)', async () => {
    markManaged();
    git(work, 'remote', 'set-url', 'origin', join(root, 'unreachable.git'));
    const r = await harden();
    expect(stepOf(r, 'verify')?.status).toBe('needs_attention');
    expect(r.needs_attention.length).toBeGreaterThan(0);
    expect(r.clean_against_origin).toBe(false);
    expect(cfg(work, MANAGED_KEY)).toBe('true');
    expect(stepOf(r, 'commit')).toBeUndefined();
  });

  test('a subdirectory source hardens the enclosing managed repo root', async () => {
    markManaged();
    const sub = join(work, 'brain'); mkdirSync(sub, { recursive: true });
    const r = await hardenBrainRepo({ repoPath: sub, sourceId: 'wiki', pat: PAT, installCron: false });
    expect(r.managed).toBe(true);
    expect(r.repo_path).toBe(git(work, 'rev-parse', '--show-toplevel'));
    expect(cfg(work, MANAGED_KEY)).toBe('true');
    expect(existsSync(join(sub, 'scripts'))).toBe(false);
    expect(existsSync(join(work, 'scripts'))).toBe(false);
  });

  test('the opt-in is written to the repository own config and never to global config', async () => {
    markManaged();
    const globalConfig = join(process.env.HOME!, '.gitconfig');
    expect(existsSync(globalConfig)).toBe(false);
    const r = await hardenBrainRepo({ repoPath: work, sourceId: 'wiki', installCron: false, verify: false });
    expect(stepOf(r, 'outbox')?.status).toBe('fixed');
    expect(git(work, 'config', '--local', '--get', MANAGED_KEY)).toBe('true');
    expect(readFileSync(join(work, '.git', 'config'), 'utf-8')).toContain('managed = true');
    expect(existsSync(globalConfig)).toBe(false);
  });

  test('GIT_CONFIG cannot redirect the opt-in write: harden never reports outbox fixed unless the local key is true', async () => {
    markManaged();
    const alt = join(root, 'alt-gitconfig');
    let r!: DurabilityReport;
    const prior = process.env.GIT_CONFIG;
    process.env.GIT_CONFIG = alt;
    try {
      r = await hardenBrainRepo({ repoPath: work, sourceId: 'wiki', installCron: false, verify: false });
    } finally {
      if (prior === undefined) delete process.env.GIT_CONFIG; else process.env.GIT_CONFIG = prior;
    }
    const outbox = stepOf(r, 'outbox');
    // Read the local key with GIT_CONFIG restored (--local errors while it is set).
    const localValue = cfg(work, MANAGED_KEY);
    if (outbox?.status === 'fixed') expect(localValue).toBe('true');
    expect(outbox?.status).toBe('needs_attention');
    expect(outbox?.detail).toContain('GIT_CONFIG');
    expect(r.needs_attention.some(n => n.startsWith('outbox:'))).toBe(true);
    expect(localValue).toBe('');
    // The redirect target must not have received the key.
    expect(existsSync(alt)).toBe(false);
  });

  test('detached HEAD stays needs_attention on the pull step', async () => {
    markManaged();
    git(work, 'checkout', '-q', git(work, 'rev-parse', 'HEAD'));
    const r = await harden({ verify: false });
    expect(stepOf(r, 'pull')?.status).toBe('needs_attention');
    expect(stepOf(r, 'pull')?.detail).toContain('detached HEAD');
  });

  for (const [label, mark] of [['registry record and git marker', markManaged], ['owner claim file only', markOwnerClaimOnly],
    ['sibling reservation only', markSiblingReservation]] as const) {
    test(`managed detection covers ${label}`, async () => {
      mark();
      const r = await harden({ verify: false });
      expect(r.managed).toBe(true);
      expect(stepOf(r, 'hook')?.status).toBe('skipped');
      expect(cfg(work, MANAGED_KEY)).toBe('true');
      expect(existsSync(join(work, '.git', 'hooks', 'post-commit'))).toBe(false);
      expect(existsSync(join(work, 'scripts'))).toBe(false);
      expect(existsSync(join(work, 'AGENTS.md'))).toBe(false);
    });
  }

  test('a root already opted in through the legacy hook reports that and leaves the hook and key alone', async () => {
    const hook = join(work, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, `#!/bin/sh\n${LEGACY_BANNER}\nexit 0\n`); chmodSync(hook, 0o755);
    const hookBytes = readFileSync(hook);
    markManaged();
    const r = await harden();
    expect(stepOf(r, 'outbox')).toMatchObject({ status: 'ok' });
    expect(stepOf(r, 'outbox')?.detail).toContain('legacy hook');
    expect(cfg(work, MANAGED_KEY)).toBe('');
    expect(readFileSync(hook)).toEqual(hookBytes);
    expect(stepOf(r, 'hook')?.status).toBe('skipped');
    expect(existsSync(join(work, 'scripts'))).toBe(false);
  });

  test('dry-run reports the same step statuses as the real run and writes nothing', async () => {
    markManaged();
    git(work, 'remote', 'set-url', 'origin', join(root, 'unreachable.git')); // proves no network is needed
    const config = configBytes();
    const state = localState();
    const store = join(process.env.HOME!, '.gbrain', 'git-credentials');
    const preview = await harden({ dryRun: true, installCron: true });
    expect(preview.managed).toBe(true);
    expect(configBytes()).toBe(config);
    expect(cfg(work, MANAGED_KEY)).toBe('');
    expect(localState()).toEqual(state);
    expect(existsSync(store)).toBe(false);
    expect(existsSync(join(process.env.HOME!, 'Library', 'LaunchAgents'))).toBe(false);
    expect(preview.needs_attention).toEqual([]);
    expect(stepOf(preview, 'verify')).toMatchObject({ status: 'skipped', detail: 'dry-run' });
    for (const name of ['hook', 'helper', 'agents', 'cron', 'pull']) expect(stepOf(preview, name)?.status).toBe('skipped');
    expect(stepOf(preview, 'outbox')?.status).toBe('fixed');
    expect(stepOf(preview, 'outbox')?.detail).toContain('dry-run');

    const real = await harden({ verify: false, installCron: false });
    const { verify: _previewVerify, ...previewSteps } = stepMap(preview);
    const { verify: _realVerify, ...realSteps } = stepMap(real);
    expect(previewSteps).toEqual(realSteps);
    expect(Object.keys(stepMap(preview))).toEqual(Object.keys(stepMap(real)));
  });

  test('dry-run on an already opted-in root reports ok and stays a no-op', async () => {
    markManaged();
    await harden();
    const config = configBytes();
    const preview = await harden({ dryRun: true });
    expect(stepOf(preview, 'outbox')?.status).toBe('ok');
    expect(preview.steps.every(s => s.status === 'ok' || s.status === 'skipped')).toBe(true);
    expect(configBytes()).toBe(config);
  });

  test('corrupt managed-root records fail closed for real and dry-run runs without writing the key', async () => {
    const registry = join(process.env.HOME!, '.gbrain', 'persistence', 'managed-roots');
    mkdirSync(registry, { recursive: true }); writeFileSync(join(registry, 'broken.json'), '{');
    const config = configBytes();
    await expect(harden()).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    await expect(harden({ dryRun: true })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    expect(configBytes()).toBe(config);
    expect(cfg(work, MANAGED_KEY)).toBe('');
    expect(existsSync(join(work, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  test('after a managed harden the filesystem fence still refuses scripts, rules, pages and hooks', async () => {
    markManaged();
    await harden();
    for (const target of [join(work, 'scripts', 'brain-commit-push.sh'), join(work, 'AGENTS.md'), join(work, 'RESOLVER.md'),
      join(work, 'notes', 'page.md'), join(work, '.git', 'hooks', 'post-commit'), work]) {
      expect(() => assertManagedFilesystemWrite(target)).toThrow('managed canonical worktree');
    }
  });

  test('unharden removes the opt-in and credential wiring and leaves the worktree untouched', async () => {
    markManaged();
    await harden();
    const state = localState();
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(steps.map(s => [s.step, s.status])).toEqual([['cron', 'skipped'], ['hook', 'skipped'], ['credential', 'fixed'], ['outbox', 'fixed']]);
    expect(steps.find(s => s.step === 'outbox')?.detail).toContain('durability_not_enabled');
    expect(cfg(work, MANAGED_KEY)).toBe('');
    expect(cfg(work, 'gbrain.durability.managedcredential')).toBe('');
    expect(durability.isManagedGitEffectEnabled(work)).toBe(false);
    expect(localState()).toEqual(state);
    const again = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(again.every(s => s.status === 'skipped')).toBe(true);
    expect(again.find(s => s.step === 'outbox')?.detail).toContain('no managed opt-in');
  });

  test('unharden from a subdirectory source resolves the repo toplevel and removes the opt-in', async () => {
    markManaged();
    const sub = join(work, 'brain'); mkdirSync(sub, { recursive: true });
    const hardened = await hardenBrainRepo({ repoPath: sub, sourceId: 'wiki', installCron: false, verify: false });
    expect(stepOf(hardened, 'outbox')?.status).toBe('fixed');
    expect(durability.isManagedGitEffectEnabled(work)).toBe(true);
    const steps = await unhardenBrainRepo({ repoPath: sub, sourceId: 'wiki' });
    const outbox = steps.find(s => s.step === 'outbox');
    expect(outbox?.status).toBe('fixed');
    expect(cfg(work, MANAGED_KEY)).toBe('');
    expect(durability.isManagedGitEffectEnabled(work)).toBe(false);
    const again = await unhardenBrainRepo({ repoPath: sub, sourceId: 'wiki' });
    expect(again.find(s => s.step === 'outbox')?.status).toBe('skipped');
  });

  test('unharden of a non-true foreign value says so and leaves it unchanged', async () => {
    markManaged();
    git(work, 'config', '--local', MANAGED_KEY, 'not-ours');
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    const outbox = steps.find(s => s.step === 'outbox');
    expect(outbox?.status).toBe('skipped');
    expect(outbox?.detail).toContain("non-'true' value");
    expect(cfg(work, MANAGED_KEY)).toBe('not-ours');
  });

  test('unharden removes only an exact true value and never touches other config', async () => {
    markManaged();
    git(work, 'config', '--local', MANAGED_KEY, 'not-ours');
    git(work, 'config', '--local', 'gbrain.durability.other', 'keep');
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(steps.find(s => s.step === 'outbox')?.status).toBe('skipped');
    expect(cfg(work, MANAGED_KEY)).toBe('not-ours');
    expect(cfg(work, 'gbrain.durability.other')).toBe('keep');
  });
});

describe('unmanaged root regression (#5182)', () => {
  const REAL_STEPS = { pull: 'ok', credential: 'fixed', hook: 'fixed', helper: 'fixed', agents: 'fixed', cron: 'skipped', verify: 'ok', commit: 'fixed' };
  const DRY_STEPS = { pull: 'skipped', credential: 'fixed', hook: 'fixed', helper: 'fixed', agents: 'fixed', cron: 'skipped', verify: 'skipped' };

  test('real harden keeps its step list and statuses, has no outbox step and does not set the key', async () => {
    const r = await harden();
    expect(Object.keys(stepMap(r))).toEqual(Object.keys(REAL_STEPS));
    expect(stepMap(r)).toEqual(REAL_STEPS);
    expect(r.managed).toBeUndefined();
    expect('managed' in r).toBe(false);
    expect(cfg(work, MANAGED_KEY)).toBe('');
    expect(isDurabilityHardened(work)).toBe(true);
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(true);
  });

  test('dry-run keeps its step list and statuses and writes nothing', async () => {
    const config = configBytes();
    const state = localState();
    const r = await harden({ dryRun: true });
    expect(Object.keys(stepMap(r))).toEqual(Object.keys(DRY_STEPS));
    expect(stepMap(r)).toEqual(DRY_STEPS);
    expect('managed' in r).toBe(false);
    expect(configBytes()).toBe(config);
    expect(localState()).toEqual(state);
  });

  test('unharden returns exactly the three legacy steps without an outbox entry', async () => {
    await harden();
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(steps.map(s => String(s.step))).toEqual(['cron', 'hook', 'credential']);
    const idle = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(idle.map(s => String(s.step))).toEqual(['cron', 'hook', 'credential']);
  });

  test('unharden from an unmanaged subdirectory emits no outbox step and keeps the legacy steps', async () => {
    const sub = join(work, 'brain'); mkdirSync(sub, { recursive: true });
    const steps = await unhardenBrainRepo({ repoPath: sub, sourceId: 'wiki' });
    expect(steps.map(s => String(s.step))).toEqual(['cron', 'hook', 'credential']);
    expect(steps.every(s => s.status === 'skipped')).toBe(true);
  });

  test('unharden from a subdirectory of a non-repo path skips the outbox step without throwing', async () => {
    const plain = join(root, 'not-a-repo', 'brain'); mkdirSync(plain, { recursive: true });
    const steps = await unhardenBrainRepo({ repoPath: plain, sourceId: 'wiki' });
    expect(steps.map(s => String(s.step))).toEqual(['cron', 'hook', 'credential']);
  });

  test('a stray opt-in key on an unmanaged root is still removed by unharden', async () => {
    git(work, 'config', '--local', MANAGED_KEY, 'true');
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(steps.find(s => s.step === 'outbox')?.status).toBe('fixed');
    expect(cfg(work, MANAGED_KEY)).toBe('');
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
