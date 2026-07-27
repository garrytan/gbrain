/**
 * Tests for src/core/skillpack/init-scaffold.ts +
 * src/core/skillpack/pack-publish.ts — the publisher side.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  InitScaffoldError,
  runInitScaffold,
} from '../src/core/skillpack/init-scaffold.ts';
import {
  PackPublishError,
  runPackPublish,
} from '../src/core/skillpack/pack-publish.ts';
import { loadSkillpackManifest } from '../src/core/skillpack/manifest-v1.ts';
import { runDoctor } from '../src/core/skillpack/doctor.ts';

function hasGnuTar(): boolean {
  for (const bin of ['gtar', 'tar']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.includes('GNU')) return true;
  }
  return false;
}
const SKIP_NO_GNU = !hasGnuTar();

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'init-pack-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('runInitScaffold — cathedral default', () => {
  test('scaffolds every file the rubric expects', () => {
    const dir = mkdtempSync(join(tmp, 'init-cathedral-'));
    const result = runInitScaffold({ targetDir: dir, name: 'test-pack' });
    for (const expected of [
      'skillpack.json',
      'skills/test-pack/SKILL.md',
      'skills/test-pack/routing-eval.jsonl',
      'runbooks/bootstrap.md',
      'CHANGELOG.md',
      'README.md',
      'LICENSE',
      '.gitignore',
      'test/example.test.ts',
      'e2e/example.e2e.test.ts',
      'evals/test-pack.judge.json',
    ]) {
      expect(existsSync(join(dir, expected))).toBe(true);
    }
    expect(result.filesWritten.length).toBeGreaterThan(8);
    expect(result.manifest.name).toBe('test-pack');
  });

  test('--minimal omits test / e2e / evals', () => {
    const dir = mkdtempSync(join(tmp, 'init-min-'));
    runInitScaffold({ targetDir: dir, name: 'mini-pack', minimal: true });
    expect(existsSync(join(dir, 'skillpack.json'))).toBe(true);
    expect(existsSync(join(dir, 'test/example.test.ts'))).toBe(false);
    expect(existsSync(join(dir, 'e2e/example.e2e.test.ts'))).toBe(false);
    expect(existsSync(join(dir, 'evals/mini-pack.judge.json'))).toBe(false);
  });

  test('refuses to overwrite existing files', () => {
    const dir = mkdtempSync(join(tmp, 'init-overwrite-'));
    mkdirSync(join(dir, 'skills/preexist'), { recursive: true });
    writeFileSync(join(dir, 'skills/preexist/SKILL.md'), 'user content');
    const result = runInitScaffold({ targetDir: dir, name: 'preexist' });
    // The user's SKILL.md should be in filesSkippedExisting
    expect(result.filesSkippedExisting.some((p) => p.endsWith('skills/preexist/SKILL.md'))).toBe(true);
    // And contents preserved.
    expect(require('fs').readFileSync(join(dir, 'skills/preexist/SKILL.md'), 'utf-8')).toBe('user content');
  });

  test('rejects invalid kebab name', () => {
    try {
      runInitScaffold({ targetDir: tmp, name: 'UpperCase' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as InitScaffoldError).code).toBe('invalid_name');
    }
  });

  test('--dry-run writes nothing but reports plan', () => {
    const dir = mkdtempSync(join(tmp, 'init-dry-'));
    const result = runInitScaffold({ targetDir: dir, name: 'dry-pack', dryRun: true });
    expect(result.filesWritten.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'skillpack.json'))).toBe(false);
  });

  test('freshly scaffolded pack scores 10/10 on doctor --quick', async () => {
    const dir = mkdtempSync(join(tmp, 'init-tenten-'));
    runInitScaffold({ targetDir: dir, name: 'reference' });
    const r = await runDoctor({ packRoot: dir, mode: 'quick' });
    expect(r.score).toBe(10);
    expect(r.tier_eligibility).toBe('endorsed');
  });
});

describe('runPackPublish — happy path', () => {
  test.skipIf(SKIP_NO_GNU)('emits a deterministic tarball when doctor passes', async () => {
    const dir = mkdtempSync(join(tmp, 'pack-good-'));
    runInitScaffold({ targetDir: dir, name: 'pack-good' });
    const result = await runPackPublish({ packRoot: dir });
    expect(result.refused_reason).toBeNull();
    expect(result.tarball).not.toBeNull();
    expect(result.tarball?.outPath).toContain('pack-good-0.1.0.tgz');
    expect(result.tarball?.sha256.length).toBe(64);
    expect(result.tarball?.fileCount).toBeGreaterThan(0);
    expect(result.tarball?.tier_eligibility).toBe('endorsed');
    expect(existsSync(result.tarball!.outPath)).toBe(true);
  });

  test('refuses to pack when doctor reports blocked tier', async () => {
    const dir = mkdtempSync(join(tmp, 'pack-bad-'));
    runInitScaffold({ targetDir: dir, name: 'pack-bad' });
    // Sabotage core dimension 5 by removing CHANGELOG.
    rmSync(join(dir, 'CHANGELOG.md'));
    const result = await runPackPublish({ packRoot: dir });
    expect(result.tarball).toBeNull();
    expect(result.refused_reason).toContain('changelog_present_and_current');
  });

  test('dry-run skips tarball but runs doctor', async () => {
    const dir = mkdtempSync(join(tmp, 'pack-dry-'));
    runInitScaffold({ targetDir: dir, name: 'pack-dry' });
    const result = await runPackPublish({ packRoot: dir, dryRun: true });
    expect(result.tarball).toBeNull();
    expect(result.doctor?.score).toBe(10);
  });

  test('throws when skillpack.json missing', async () => {
    const dir = mkdtempSync(join(tmp, 'pack-missing-'));
    try {
      await runPackPublish({ packRoot: dir });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as PackPublishError).code).toBe('manifest_load_failed');
    }
  });

  test.skipIf(SKIP_NO_GNU)('--skip-doctor packs without running the gate', async () => {
    const dir = mkdtempSync(join(tmp, 'pack-skipdoc-'));
    runInitScaffold({ targetDir: dir, name: 'pack-skipdoc' });
    const result = await runPackPublish({ packRoot: dir, skipDoctor: true });
    expect(result.doctor).toBeNull();
    expect(result.tarball).not.toBeNull();
  });
});

describe('end-to-end init -> doctor -> pack', () => {
  test.skipIf(SKIP_NO_GNU)('full publisher loop on a fresh pack', async () => {
    const dir = mkdtempSync(join(tmp, 'e2e-'));
    // 1. init
    runInitScaffold({ targetDir: dir, name: 'e2e-pack' });
    // 2. doctor
    const doc = await runDoctor({ packRoot: dir, mode: 'quick' });
    expect(doc.score).toBe(10);
    // 3. pack
    const pkg = await runPackPublish({ packRoot: dir });
    expect(pkg.tarball).not.toBeNull();
    // 4. manifest round-trip
    const m = loadSkillpackManifest(dir);
    expect(m.name).toBe('e2e-pack');
  });
});
