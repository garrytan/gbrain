/**
 * Per-repo filing-rules resolution (#4015): `sources harden` must render a
 * repo's OWN `skills/_brain-filing-rules.json` taxonomy into the managed
 * AGENTS/RESOLVER block, not the bundled default — falling back to the
 * bundled default only when the repo has no rules file, or that file is
 * malformed. Fixture mirrors brain-repo-durability.serial.test.ts (real git
 * against a local bare remote; HOME + GBRAIN_HOME redirected to a tmp dir).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';

const PAT = 'ghp_TESTSECRETTOKEN0123456789abcdef';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
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

function writeRepoRules(json: string): void {
  mkdirSync(join(work, 'skills'), { recursive: true });
  writeFileSync(join(work, 'skills', '_brain-filing-rules.json'), json);
  git(work, 'add', 'skills/_brain-filing-rules.json'); git(work, 'commit', '-qm', 'filing rules');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'frr-'));
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

describe('per-source filing-rules resolution', () => {
  test('repo with its own skills/_brain-filing-rules.json → managed block carries that taxonomy', async () => {
    writeRepoRules(JSON.stringify({
      version: '1.0.0',
      rules: [{ kind: 'widget', directory: 'widgets/', description: 'A widget page.' }],
    }));
    await harden();
    const agents = readFileSync(join(work, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('`widgets/`');
    expect(agents).not.toContain('`people/`');
  });

  test('repo without a rules file → bundled default taxonomy (regression pin)', async () => {
    await harden();
    const agents = readFileSync(join(work, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('`people/`');
  });

  test('malformed JSON in the repo file → falls back to bundled default, no throw', async () => {
    writeRepoRules('{ this is not valid json');
    await harden(); // must not throw
    const agents = readFileSync(join(work, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('`people/`');
  });
});
