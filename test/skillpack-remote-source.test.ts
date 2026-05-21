/**
 * Tests for src/core/skillpack/remote-source.ts — source resolution.
 *
 * classifySpec is pure and gets the bulk of the test surface. Git fetch is
 * exercised via the e2e flow test; tarball + local paths are deterministic
 * and tested here.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  RemoteSourceError,
  classifySpec,
  resolveSource,
} from '../src/core/skillpack/remote-source.ts';
import { packTarball } from '../src/core/skillpack/tarball.ts';

function hasGnuTar(): boolean {
  for (const bin of ['gtar', 'tar']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.includes('GNU')) return true;
  }
  return false;
}

const SKIP_NO_GNU = !hasGnuTar();

describe('classifySpec — pure classifier', () => {
  test('rejects empty / non-string', () => {
    expect(() => classifySpec('')).toThrow(RemoteSourceError);
    expect(() => classifySpec('   ')).toThrow(RemoteSourceError);
  });

  test('classifies https URL', () => {
    const r = classifySpec('https://github.com/garrytan/skillpack-hackathon-evaluation');
    expect(r.kind).toBe('git-url');
    expect(r.normalized).toBe('https://github.com/garrytan/skillpack-hackathon-evaluation');
  });

  test('expands owner/repo into github URL', () => {
    const r = classifySpec('garrytan/skillpack-hackathon-evaluation');
    expect(r.kind).toBe('git-url');
    expect(r.normalized).toBe('https://github.com/garrytan/skillpack-hackathon-evaluation.git');
  });

  test('classifies absolute path as local', () => {
    const r = classifySpec('/Users/garry/skillpack');
    expect(r.kind).toBe('local');
    expect(r.normalized).toBe('/Users/garry/skillpack');
  });

  test('classifies relative path with ./ as local', () => {
    const r = classifySpec('./skillpack');
    expect(r.kind).toBe('local');
  });

  test('classifies .tgz path as tarball', () => {
    const r = classifySpec('/tmp/pack-0.1.0.tgz');
    expect(r.kind).toBe('tarball');
  });

  test('classifies .tar.gz path as tarball', () => {
    const r = classifySpec('./pack.tar.gz');
    expect(r.kind).toBe('tarball');
  });

  test('classifies bare kebab as kebab (needs registry)', () => {
    const r = classifySpec('hackathon-evaluation');
    expect(r.kind).toBe('kebab');
    expect(r.normalized).toBe('hackathon-evaluation');
  });

  test('rejects malformed input', () => {
    expect(() => classifySpec('Has Spaces')).toThrow(RemoteSourceError);
    expect(() => classifySpec('UPPER/CASE')).not.toThrow(); // owner/repo is alnum-tolerant (GitHub allows uppercase usernames)
    expect(() => classifySpec('multi/slash/path')).toThrow(RemoteSourceError);
  });
});

describe('resolveSource — local dir', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'remote-source-local-'));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns kind=local with the absolute path when skillpack.json exists', () => {
    const pack = join(tmp, 'mypack');
    mkdirSync(pack);
    writeFileSync(join(pack, 'skillpack.json'), '{}');
    const r = resolveSource(pack);
    expect(r.kind).toBe('local');
    expect(r.path).toBe(pack);
    expect(r.pinned_commit).toBeNull();
    expect(r.tarball_sha256).toBeNull();
    expect(r.cache_hit).toBe(false);
  });

  test('rejects local path that is not a directory', () => {
    const f = join(tmp, 'file');
    writeFileSync(f, 'x');
    try {
      resolveSource(f);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RemoteSourceError).code).toBe('spec_local_not_pack_root');
    }
  });

  test('rejects local dir without skillpack.json', () => {
    const dir = join(tmp, 'empty');
    mkdirSync(dir);
    try {
      resolveSource(dir);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RemoteSourceError).code).toBe('spec_local_not_pack_root');
    }
  });

  test('rejects missing local path', () => {
    try {
      resolveSource(join(tmp, 'nope'));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RemoteSourceError).code).toBe('spec_local_missing');
    }
  });
});

describe('resolveSource — tarball', () => {
  let tmp: string;
  let cacheRoot: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'remote-source-tar-'));
    cacheRoot = join(tmp, 'cache');
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test.skipIf(SKIP_NO_GNU)('extracts a tarball and returns a pack root with skillpack.json', () => {
    const src = join(tmp, 'mypack');
    mkdirSync(join(src, 'skills/foo'), { recursive: true });
    writeFileSync(join(src, 'skills/foo/SKILL.md'), '---\nname: foo\n---\n');
    writeFileSync(
      join(src, 'skillpack.json'),
      JSON.stringify({
        api_version: 'gbrain-skillpack-v1',
        name: 'mypack',
        version: '0.1.0',
        description: 'd',
        author: 'a',
        license: 'MIT',
        homepage: 'https://example.com',
        gbrain_min_version: '0.36.0',
        skills: ['skills/foo'],
      }),
    );
    const tgz = join(tmp, 'mypack.tgz');
    packTarball({ sourceDir: src, outPath: tgz });

    const r = resolveSource(tgz, { cacheRoot });
    expect(r.kind).toBe('tarball');
    expect(r.cache_hit).toBe(false);
    expect(r.tarball_sha256).not.toBeNull();
    expect(r.pinned_commit).toBeNull();
    // findPackRoot should hop down into the `mypack/` subdir where skillpack.json lives.
    expect(r.path).toContain('mypack');
  });

  test.skipIf(SKIP_NO_GNU)('returns cache_hit=true on second resolve of the same tarball', () => {
    const src = join(tmp, 'cachable');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'skillpack.json'), '{}');
    const tgz = join(tmp, 'cachable.tgz');
    packTarball({ sourceDir: src, outPath: tgz });

    const r1 = resolveSource(tgz, { cacheRoot });
    expect(r1.cache_hit).toBe(false);
    const r2 = resolveSource(tgz, { cacheRoot });
    expect(r2.cache_hit).toBe(true);
    expect(r2.tarball_sha256).toBe(r1.tarball_sha256);
    expect(r2.path).toBe(r1.path);
  });

  test.skipIf(SKIP_NO_GNU)('noCache=true forces a fresh extract even when cache exists', () => {
    const src = join(tmp, 'nocache');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'skillpack.json'), '{}');
    const tgz = join(tmp, 'nocache.tgz');
    packTarball({ sourceDir: src, outPath: tgz });

    resolveSource(tgz, { cacheRoot });
    const r = resolveSource(tgz, { cacheRoot, noCache: true });
    expect(r.cache_hit).toBe(false);
  });

  test('rejects missing tarball file', () => {
    try {
      resolveSource(join(tmp, 'nothere.tgz'), { cacheRoot });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RemoteSourceError).code).toBe('spec_tarball_missing');
    }
  });
});

describe('resolveSource — kebab name short-circuits to registry', () => {
  test('throws spec_kebab_invalid_shape for bare kebab name', () => {
    try {
      resolveSource('hackathon-evaluation');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RemoteSourceError).code).toBe('spec_kebab_invalid_shape');
    }
  });
});
