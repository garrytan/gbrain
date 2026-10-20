/**
 * #6845: scripts/check-core-guard-coverage.mjs derives its repository root
 * from import.meta.url. URL.pathname keeps percent-encoding, so a checkout
 * whose path has a space or a non-ASCII character scanned a directory that
 * doesn't exist and failed. The root must be the decoded file path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');
let parent: string;
let root: string;

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), 'gbrain-guard-root-'));
  root = join(parent, 'wt dir é');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(REPO, 'scripts', 'check-core-guard-coverage.mjs'), join(root, 'scripts', 'check-core-guard-coverage.mjs'));
  symlinkSync(join(REPO, 'src'), join(root, 'src'));
});

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

describe('#6845 core guard coverage check in a path with a space and an accent', () => {
  test('scans the checkout it sits in without GBRAIN_GUARD_ROOT', () => {
    const env = { ...process.env };
    delete env.GBRAIN_GUARD_ROOT;
    const r = spawnSync('node', [join(root, 'scripts', 'check-core-guard-coverage.mjs')], { cwd: root, env, encoding: 'utf8' });
    expect(r.stderr).not.toContain('ENOENT');
    expect(r.status).toBe(0);
  });
});
