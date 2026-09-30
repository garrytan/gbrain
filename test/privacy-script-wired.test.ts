/**
 * scripts/check-privacy.sh behavior: name/path violations, allowlists, staged
 * mode and batching.
 *
 * CLAUDE.md bans the private OpenClaw fork name from public artifacts, and this
 * script is the enforcement mechanism. Its verify wiring is owned generically:
 * test/scripts/run-verify-parallel.test.ts requires every manifest guard to be
 * executed by verify, and test/scripts/ci-gates.test.ts requires the CI verify
 * job to run `bun run verify`.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PRIVACY_SCRIPT = resolve(REPO_ROOT, 'scripts/check-privacy.sh');
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

describe('check-privacy.sh', () => {

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
