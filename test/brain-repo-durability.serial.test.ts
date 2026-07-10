import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  acceptPat,
  generateBrainPullPlist,
  hardenBrainRepo,
  renderCronWrapper,
  unhardenBrainRepo,
} from '../src/core/brain-repo-durability.ts';

const PAT = 'ghp_TESTSECRETTOKEN0123456789abcdef';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  }).trim();
}

let root: string;
let work: string;
let oldHome: string | undefined;
let oldPmbrainHome: string | undefined;
let oldGbrainHome: string | undefined;
let oldAllow: string | undefined;
let oldPat: string | undefined;
let oldGPat: string | undefined;

function makeRepo(): void {
  const bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@example.test');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* best effort */ }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-brd-'));
  oldHome = process.env.HOME;
  oldPmbrainHome = process.env.PMBRAIN_HOME;
  oldGbrainHome = process.env.GBRAIN_HOME;
  oldAllow = process.env.PMBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  oldPat = process.env.PMBRAIN_GITHUB_PAT;
  oldGPat = process.env.GBRAIN_GITHUB_PAT;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  process.env.PMBRAIN_HOME = join(process.env.HOME, '.pmbrain');
  delete process.env.GBRAIN_HOME;
  process.env.PMBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  delete process.env.PMBRAIN_GITHUB_PAT;
  delete process.env.GBRAIN_GITHUB_PAT;
  makeRepo();
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldPmbrainHome === undefined) delete process.env.PMBRAIN_HOME; else process.env.PMBRAIN_HOME = oldPmbrainHome;
  if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
  if (oldAllow === undefined) delete process.env.PMBRAIN_GIT_ALLOW_FILE_TRANSPORT; else process.env.PMBRAIN_GIT_ALLOW_FILE_TRANSPORT = oldAllow;
  if (oldPat === undefined) delete process.env.PMBRAIN_GITHUB_PAT; else process.env.PMBRAIN_GITHUB_PAT = oldPat;
  if (oldGPat === undefined) delete process.env.GBRAIN_GITHUB_PAT; else process.env.GBRAIN_GITHUB_PAT = oldGPat;
  rmSync(root, { recursive: true, force: true });
});

describe('brain repo durability', () => {
  test('harden installs local hook, committed helper, and resolver rules without cron', async () => {
    const r = await hardenBrainRepo({
      repoPath: work,
      sourceId: 'wiki',
      pat: PAT,
      installCron: false,
      verify: false,
    });
    expect(existsSync(join(work, '.git', 'hooks', 'post-commit'))).toBe(true);
    expect(readFileSync(join(work, '.git', 'hooks', 'post-commit'), 'utf-8')).toContain('pmbrain brain-durability');
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(join(work, 'scripts', 'brain-commit-push.sh')).mode & 0o111).toBeTruthy();
    }
    expect(readFileSync(join(work, 'AGENTS.md'), 'utf-8')).toContain('BEGIN pmbrain-brain-durability');
    expect(JSON.stringify(r)).not.toContain(PAT);
  });

  test('unharden removes local-only wiring and leaves committed helper content', async () => {
    await hardenBrainRepo({ repoPath: work, sourceId: 'wiki', pat: PAT, installCron: false, verify: false });
    const steps = await unhardenBrainRepo({ repoPath: work, sourceId: 'wiki' });
    expect(existsSync(join(work, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(existsSync(join(work, 'scripts', 'brain-commit-push.sh'))).toBe(true);
    expect(steps.some((s) => s.step === 'hook' && s.status === 'fixed')).toBe(true);
  });

  test('acceptPat prefers PMBRAIN_GITHUB_PAT and falls back to GBRAIN_GITHUB_PAT', () => {
    process.env.GBRAIN_GITHUB_PAT = 'gb-old';
    expect(acceptPat({})?.token).toBe('gb-old');
    process.env.PMBRAIN_GITHUB_PAT = 'pm-new';
    expect(acceptPat({})?.token).toBe('pm-new');
  });
});

describe('durability cron renderers', () => {
  test('cron wrapper calls DB-free sources pull --path', () => {
    const wrapper = renderCronWrapper('wiki', '/data/wiki', 'main', '/usr/local/bin/pmbrain', '/home/u/.pmbrain/brain-push.log');
    expect(wrapper).toContain("sources pull --path '/data/wiki'");
    expect(wrapper).toContain("--branch 'main'");
    expect(wrapper).not.toMatch(/sources pull '?wiki'?(\s|$)/);
  });

  test('launchd plist is periodic and secret-free', () => {
    const plist = generateBrainPullPlist('com.pmbrain.brain-pull.wiki', '/home/u/.pmbrain/brain-pull-wiki.sh', '/home/u', 1800);
    expect(plist).toContain('<key>StartInterval</key><integer>1800</integer>');
    expect(plist).not.toContain('ghp_');
  });
});
