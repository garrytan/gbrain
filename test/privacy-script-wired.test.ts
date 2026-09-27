/**
 * Regression guard: scripts/check-privacy.sh must run in CI's auto-pipeline.
 *
 * CLAUDE.md bans the private OpenClaw fork name from public artifacts.
 * scripts/check-privacy.sh is the enforcement mechanism. If someone
 * refactors the script chain and drops the privacy check, this test
 * fails loudly.
 *
 * v0.26.4 split: `bun run test` is now the fast parallel loop and does
 * NOT chain pre-checks; the privacy gate moved to `bun run verify`,
 * which CI's test.yml runs as its own job before the matrix fans out.
 *
 * v0.41.4+ wave: `bun run verify` now delegates to
 * scripts/run-verify-parallel.sh which fans out all 20 checks in
 * parallel via & + wait. The privacy check is one entry in that
 * script's CHECKS[] array. Regression guard updated to follow the
 * indirection: (1) verify points at the parallel dispatcher,
 * (2) the dispatcher's CHECKS array contains check:privacy,
 * (3) CI workflow's verify job calls `bun run verify`.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
const PRIVACY_SCRIPT = resolve(REPO_ROOT, 'scripts/check-privacy.sh');
const VERIFY_DISPATCHER = resolve(REPO_ROOT, 'scripts/run-verify-parallel.sh');
const TEST_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/test.yml');
const guardSource = readFileSync(PRIVACY_SCRIPT, 'utf8');
const bannedName = guardSource.match(/^BANNED_NAME='([^']+)'/m)![1]!;
const bannedPath = guardSource.match(/BANNED_PATHS=\(\s*'([^']+)'/)![1]!;

function privacyFixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'privacy-guard-'));
  for (const [file, contents] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }
  const init = spawnSync('git', ['init', '-q', root]);
  expect(init.status).toBe(0);
  const add = spawnSync('git', ['add', '.'], { cwd: root });
  expect(add.status).toBe(0);
  return root;
}

function runPrivacy(root: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync('bash', [PRIVACY_SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('check-privacy.sh CI wiring', () => {
  it('scripts/check-privacy.sh exists and is executable', () => {
    expect(existsSync(PRIVACY_SCRIPT)).toBe(true);
    const stat = require('fs').statSync(PRIVACY_SCRIPT);
    // eslint-disable-next-line no-bitwise
    expect((stat.mode & 0o100) !== 0).toBe(true);
  });

  it('package.json "verify" script delegates to run-verify-parallel.sh', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(typeof pkg.scripts?.verify).toBe('string');
    // verify body is now `bash scripts/run-verify-parallel.sh`. The
    // direct check:privacy substring assertion broke when the && chain
    // was replaced with the parallel dispatcher. Follow the indirection.
    expect(pkg.scripts.verify).toContain('run-verify-parallel.sh');
  });

  it('run-verify-parallel.sh dispatches check:privacy', () => {
    expect(existsSync(VERIFY_DISPATCHER)).toBe(true);
    // The dispatcher exposes --dry-list which prints one check name per
    // line. Authoritative check than substring-grepping the script body
    // (which could pass on a commented-out entry).
    const r = spawnSync('bash', [VERIFY_DISPATCHER, '--dry-list'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    const checks = r.stdout.trim().split('\n');
    expect(checks).toContain('check:privacy');
  });

  it('package.json "check:privacy" alias points at the script', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(pkg.scripts?.['check:privacy']).toContain('check-privacy.sh');
  });

  it('CI test.yml runs `bun run verify` so the privacy gate fires', () => {
    expect(existsSync(TEST_WORKFLOW)).toBe(true);
    const yml = readFileSync(TEST_WORKFLOW, 'utf-8');
    expect(yml).toContain('bun run verify');
  });

  it('reports every name and path violation with its original line number', () => {
    const root = privacyFixture({
      'docs/a file.md': `safe\n${bannedName.toUpperCase()}\n${bannedPath}\n`,
      'src/b.ts': `${bannedName}\n`,
      'ignored.bin': bannedName,
    });
    try {
      const r = runPrivacy(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('BANNED NAME in docs/a file.md');
      expect(r.stderr).toContain(`2:${bannedName.toUpperCase()}`);
      expect(r.stderr).toContain(`BANNED PATH '${bannedPath}' in docs/a file.md`);
      expect(r.stderr).toContain('BANNED NAME in src/b.ts');
      expect(r.stderr).not.toContain('ignored.bin');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves exact allowlist paths, case-sensitive path rules, and the changelog name check', () => {
    const root = privacyFixture({
      'CLAUDE.md': `${bannedName}\n${bannedPath}\n`,
      'CHANGELOG.md': `${bannedPath}\n`,
      'docs/case.md': `${bannedPath.toUpperCase()}\n`,
    });
    try {
      expect(runPrivacy(root).status).toBe(0);
      writeFileSync(join(root, 'CHANGELOG.md'), `${bannedName}\n`);
      const r = runPrivacy(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('BANNED NAME in CHANGELOG.md');
      expect(r.stderr).not.toContain('BANNED PATH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('staged mode keeps its selected-file scope and scans their current working contents', () => {
    const root = privacyFixture({ 'selected.md': 'safe\n' });
    try {
      writeFileSync(join(root, 'intent.md'), `${bannedName}\n`);
      expect(spawnSync('git', ['add', '-N', 'intent.md'], { cwd: root }).status).toBe(0);
      expect(runPrivacy(root, ['--staged']).status).toBe(0);
      expect(runPrivacy(root).status).toBe(1);
      writeFileSync(join(root, 'selected.md'), `${bannedName}\n`);
      const r = runPrivacy(root, ['--staged']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('BANNED NAME in selected.md');
      expect(r.stderr).not.toContain('intent.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('batches clean files while still checking matches beyond the first batch', () => {
    const root = privacyFixture(Object.fromEntries(Array.from({ length: 260 }, (_, i) => [`docs/clean ${i}.md`, 'safe\n'])));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'grep-calls');
    writeFileSync(join(bin, 'grep'), `#!/usr/bin/env bash\nprintf 'grep\\n' >> "$GREP_CALL_LOG"\nexec "$REAL_GREP" "$@"\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}`, GREP_CALL_LOG: log, REAL_GREP: Bun.which('grep')! };
    try {
      expect(runPrivacy(root, [], env).status).toBe(0);
      expect(readFileSync(log, 'utf8').trim().split('\n').length).toBeLessThan(10);
      writeFileSync(join(root, 'docs', 'clean 99.md'), `${bannedName}\n`);
      const r = runPrivacy(root, [], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('BANNED NAME in docs/clean 99.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a later candidate batch cannot be scanned', () => {
    const root = privacyFixture(Object.fromEntries(Array.from({ length: 260 }, (_, i) => [`docs/file ${i}.md`, `${bannedName}\n`])));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const marker = join(root, 'first-batch');
    writeFileSync(join(bin, 'grep'), `#!/usr/bin/env bash\nif [ -f "$BATCH_MARKER" ]; then\n  echo 'candidate scan failed' >&2\n  exit 2\nfi\nprintf done > "$BATCH_MARKER"\nexec "$REAL_GREP" "$@"\n`, { mode: 0o755 });
    try {
      const r = runPrivacy(root, [], { PATH: `${bin}:${process.env.PATH}`, BATCH_MARKER: marker, REAL_GREP: Bun.which('grep')! });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('candidate scan failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
