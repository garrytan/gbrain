/**
 * scripts/pregate-remote-gate.sh — gbrain's gstack-pregate remote gate.
 *
 * Protects: the receipt gstack-pregate --remote reads to clear the
 * requires-remote obligation on a small machine (PREGATE_REMOTE: tree=…
 * tests=… failed=…).
 * Fails when: the tree reported is not the working tree's content fingerprint
 * (untracked files included, ignored files excluded), the totals stop summing
 * every summary lane, a gate with no summary or a moved tree still prints a
 * receipt, the gate's exit code is lost, or a missing UBI_OWNER or a
 * PREGATE_TREE mismatch reaches the gate, or the default gate is anything
 * but the development form `bun run ci:ubicloud:diff` (the full gate runs
 * once per PR, at handoff).
 * Seam: GBRAIN_PREGATE_GATE_CMD replaces `bun run ci:ubicloud:diff`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', '..', 'scripts/pregate-remote-gate.sh');
const SUMMARY = [
  '=== ci-ubicloud summary ===',
  '  gitleaks 1 passed, 0 failed, 8s compute',
  '  unit     30 passed, 2 failed, 80s compute',
  '  e2e      5 passed, 0 failed, 60s compute',
  '  VMs: 8/8 ready, setup 62-72s',
].join('\n');

let repo: string;
const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).stdout.trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'pregate-remote-gate-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function run(gate: string, env: Record<string, string | undefined> = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', UBI_OWNER: 'gbra0test', PREGATE_TREE: undefined, GBRAIN_PREGATE_GATE_CMD: gate, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The content tree of tracked plus untracked-unignored files, as gstack-wtree computes it. */
function contentTree(): string {
  const idx = join(repo, '.git', 'test-index');
  const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_CONFIG_NOSYSTEM: '1' };
  spawnSync('git', ['read-tree', 'HEAD'], { cwd: repo, env });
  spawnSync('git', ['add', '-A', '.'], { cwd: repo, env });
  const tree = spawnSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).stdout.trim();
  rmSync(idx, { force: true });
  return tree;
}

describe('pregate-remote-gate.sh', () => {
  it('reports the working tree with untracked files and sums every summary lane', () => {
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    writeFileSync(join(repo, 'ignored.txt'), 'scratch\n');
    const expected = contentTree();
    expect(expected).not.toBe(git('rev-parse', 'HEAD^{tree}'));
    const gate = join(repo, '.git', 'gate.sh');
    writeFileSync(gate, 'printf \'%s\\n\' "$SUMMARY_TEXT"; exit 1\n');
    const r = run(`bash ${gate}`, { SUMMARY_TEXT: SUMMARY });
    expect(r.out.trim().split('\n').at(-1)).toBe(`PREGATE_REMOTE: tree=${expected} tests=38 failed=2`);
    expect(r.code).toBe(1);
  });

  it('a green gate exits 0 with failed=0 and receives the extra arguments', () => {
    const gate = join(repo, '.git', 'gate.sh');
    writeFileSync(gate, `echo "args: $*"; printf '%s\\n' '=== ci-ubicloud summary ===' '  unit     4 passed, 0 failed, 1s compute'\n`);
    const r = spawnSync('bash', [SCRIPT, '--vms', '8'], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', UBI_OWNER: 'gbra0test', GBRAIN_PREGATE_GATE_CMD: `bash ${gate}` } as Record<string, string>,
    });
    expect(r.stdout).toContain('args: --vms 8');
    expect(r.stdout.trim().split('\n').at(-1)).toBe(`PREGATE_REMOTE: tree=${contentTree()} tests=4 failed=0`);
    expect(r.status).toBe(0);
  });

  it('runs the development gate, bun run ci:ubicloud:diff, by default and passes the extra arguments on', () => {
    const bin = join(repo, '.git', 'fake-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash\necho "fake-bun: $*"\nprintf '%s\\n' '=== ci-ubicloud summary ===' '  gitleaks 1 passed, 0 failed, 2s compute'\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    const r = spawnSync('bash', [SCRIPT, '--lanes', 'unit'], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', UBI_OWNER: 'gbra0test', PATH: `${bin}:${process.env.PATH}`, GBRAIN_PREGATE_GATE_CMD: undefined, PREGATE_TREE: undefined },
    });
    expect(r.stdout).toContain('fake-bun: run ci:ubicloud:diff --lanes unit');
    expect(r.stdout.trim().split('\n').at(-1)).toBe(`PREGATE_REMOTE: tree=${contentTree()} tests=1 failed=0`);
    expect(r.status).toBe(0);
  });

  it('prints no receipt when the gate printed no summary', () => {
    const r = run('echo provisioning failed; exit 3');
    expect(r.out).not.toContain('PREGATE_REMOTE:');
    expect(r.err).toContain('no ci-ubicloud summary');
    expect(r.code).toBe(3);
  });

  it('prints no receipt when the working tree changes during the gate', () => {
    const r = run(`echo changed > moved.txt; printf '%s\\n' '=== ci-ubicloud summary ===' '  unit     4 passed, 0 failed, 1s compute'`);
    expect(r.out).not.toContain('PREGATE_REMOTE:');
    expect(r.err).toContain('changed during the gate');
    expect(r.code).toBe(1);
  });

  it('refuses before the gate without UBI_OWNER or when PREGATE_TREE is another tree', () => {
    const marker = join(repo, '.git', 'ran');
    const noOwner = run(`touch ${marker}`, { UBI_OWNER: '' });
    expect(noOwner.code).toBe(2);
    expect(noOwner.err).toContain('UBI_OWNER is not set');
    const stale = run(`touch ${marker}`, { PREGATE_TREE: '0'.repeat(40) });
    expect(stale.code).toBe(1);
    expect(stale.err).toContain('not the tree pregate selected');
    expect(spawnSync('test', ['-e', marker]).status).not.toBe(0);
  });
});
