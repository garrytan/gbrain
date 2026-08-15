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
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
const PRIVACY_SCRIPT = resolve(REPO_ROOT, 'scripts/check-privacy.sh');
const VERIFY_DISPATCHER = resolve(REPO_ROOT, 'scripts/run-verify-parallel.sh');
const TEST_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/test.yml');

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
});
