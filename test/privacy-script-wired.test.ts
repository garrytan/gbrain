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
 * which CI's test.yml runs on shard 1 before the matrix fans out.
 * Regression guard now asserts both: (1) verify chains check:privacy,
 * (2) CI workflow's pre-test gate calls `bun run verify`. Together those
 * guarantee the privacy check runs before any merge.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
const PRIVACY_SCRIPT = resolve(REPO_ROOT, 'scripts/check-privacy.sh');
const TEST_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/test.yml');

describe('check-privacy.sh CI wiring', () => {
  it('scripts/check-privacy.sh exists and is executable', () => {
    expect(existsSync(PRIVACY_SCRIPT)).toBe(true);
    const stat = require('fs').statSync(PRIVACY_SCRIPT);
    // eslint-disable-next-line no-bitwise
    expect((stat.mode & 0o100) !== 0).toBe(true);
  });

  it('package.json "verify" script chains check:privacy', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(typeof pkg.scripts?.verify).toBe('string');
    expect(pkg.scripts.verify).toContain('check:privacy');
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
});
