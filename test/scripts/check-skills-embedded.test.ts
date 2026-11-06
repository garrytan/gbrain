/**
 * GBRA-194: scripts/check-skills-embedded.sh compiles
 * scripts/skills-embedded-smoketest.ts and compares its output with skills/.
 * The compile runs in verify (check:skills-embedded). This test runs the
 * smoketest from source, which is fast, and checks the guard's shape.
 */

import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SMOKETEST = resolve(REPO_ROOT, 'scripts/skills-embedded-smoketest.ts');
const GUARD = resolve(REPO_ROOT, 'scripts/check-skills-embedded.sh');

describe('skills-embedded-smoketest.ts', () => {
  it('prints one path and sha256 per bundled skill file, matching skills/', () => {
    const run = Bun.spawnSync(['bun', SMOKETEST], { cwd: REPO_ROOT });
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.toString().trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(50);
    for (const line of lines) {
      const [path, sha] = line.split('\t');
      expect(sha).toBe(createHash('sha256').update(readFileSync(resolve(REPO_ROOT, 'skills', path!))).digest('hex'));
    }
  });
});

describe('check-skills-embedded.sh', () => {
  const source = readFileSync(GUARD, 'utf8');

  it('runs under set -euo pipefail and compiles the smoketest', () => {
    expect(source).toContain('set -euo pipefail');
    expect(source).toContain('bun build --compile');
    expect(source).toContain('scripts/skills-embedded-smoketest.ts');
  });

  it('runs the binary with skills/ and src/ removed, outside the checkout', () => {
    expect(source).toContain('rm -rf "$BUILD_DIR/skills" "$BUILD_DIR/src"');
    expect(source).toContain('(cd / && HOME="$BUILD_DIR" "$OUT_BIN"');
  });
});
