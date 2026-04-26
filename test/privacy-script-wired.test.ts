/**
 * Regression guard: scripts/check-privacy.sh must be wired into the
 * `bun run test` chain.
 *
 * CLAUDE.md:550 bans the private OpenClaw fork name from public
 * artifacts. scripts/check-privacy.sh is the enforcement mechanism.
 * If someone refactors the test script and drops the privacy check,
 * this test fails loudly.
 *
 * The assertion is a substring match against package.json's
 * scripts.test field. Deliberately simple: the goal is to detect
 * accidental unwiring, not to validate the shell chain's semantics.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
const PRIVACY_SCRIPT = resolve(REPO_ROOT, 'scripts/check-privacy.sh');

describe('check-privacy.sh CI wiring', () => {
  it('scripts/check-privacy.sh exists and is executable', () => {
    expect(existsSync(PRIVACY_SCRIPT)).toBe(true);
    const stat = require('fs').statSync(PRIVACY_SCRIPT);
    // Mode has user-exec bit set.
    // eslint-disable-next-line no-bitwise
    expect((stat.mode & 0o100) !== 0).toBe(true);
  });

  it('package.json "test" script includes check-privacy.sh', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(typeof pkg.scripts?.test).toBe('string');
    expect(pkg.scripts.test).toContain('check-privacy.sh');
  });

  it('package.json exposes a "check:privacy" convenience alias', () => {
    // Not load-bearing for CI, but prevents the script from disappearing
    // from the scripts map during a refactor.
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(pkg.scripts?.['check:privacy']).toContain('check-privacy.sh');
  });
});
