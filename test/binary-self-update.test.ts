import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expectedAssetName,
  resolvePlatformAsset,
  runBinarySelfUpdate,
  type ReleaseAsset,
} from '../src/core/binary-self-update.ts';

const ASSETS: ReleaseAsset[] = [
  { name: 'gbrain-darwin-arm64', url: 'https://example.com/darwin-arm64' },
  { name: 'gbrain-linux-x64', url: 'https://example.com/linux-x64' },
];

describe('expectedAssetName / resolvePlatformAsset', () => {
  test('maps the two published targets', () => {
    expect(expectedAssetName('darwin', 'arm64')).toBe('gbrain-darwin-arm64');
    expect(expectedAssetName('linux', 'x64')).toBe('gbrain-linux-x64');
  });
  test('null for unpublished platform/arch', () => {
    expect(expectedAssetName('darwin', 'x64')).toBeNull();
    expect(expectedAssetName('linux', 'arm64')).toBeNull();
    expect(expectedAssetName('win32', 'x64')).toBeNull();
  });
  test('resolvePlatformAsset returns the matching URL or null', () => {
    expect(resolvePlatformAsset(ASSETS, 'darwin', 'arm64')).toBe('https://example.com/darwin-arm64');
    expect(resolvePlatformAsset(ASSETS, 'linux', 'x64')).toBe('https://example.com/linux-x64');
    expect(resolvePlatformAsset(ASSETS, 'win32', 'x64')).toBeNull();
    expect(resolvePlatformAsset([], 'darwin', 'arm64')).toBeNull(); // asset missing from release
  });
});

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-binup-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('runBinarySelfUpdate', () => {
  test('happy path: stages, smokes, atomically replaces the target', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD BINARY');
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async (_url, dest) => writeFileSync(dest, 'NEW BINARY'),
        smoke: () => true,
      });
      expect(res.ok).toBe(true);
      expect(res.asset).toBe('gbrain-darwin-arm64');
      expect(readFileSync(target, 'utf8')).toBe('NEW BINARY');
    });
  });

  test('unsupported platform → unsupported_platform, target untouched', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain.exe');
      writeFileSync(target, 'OLD');
      const res = await runBinarySelfUpdate(target, {
        platform: 'win32',
        arch: 'x64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('unsupported_platform');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
    });
  });

  test('fetch failure → fetch_failed, target untouched', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => null,
      });
      expect(res.reason).toBe('fetch_failed');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
    });
  });

  test('asset missing from release → no_asset, target untouched', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      const res = await runBinarySelfUpdate(target, {
        platform: 'linux',
        arch: 'x64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: [] }),
      });
      expect(res.reason).toBe('no_asset');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
    });
  });

  test('download throws → download_failed, no staged leftover, target untouched', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async () => {
          throw new Error('disk full');
        },
      });
      expect(res.reason).toBe('download_failed');
      expect(res.error).toContain('disk full');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
    });
  });

  test('smoke fail → smoke_failed, staged discarded, target untouched', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async (_url, dest) => writeFileSync(dest, 'CORRUPT'),
        smoke: () => false,
      });
      expect(res.reason).toBe('smoke_failed');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
    });
  });
});
