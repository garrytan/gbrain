/**
 * E2E: real atomic binary self-update against a live local release server.
 *
 * Unlike test/binary-self-update.test.ts (which stubs `download` + `smoke` to
 * exercise the orchestration), this drives the REAL dangerous path end-to-end:
 *   real HTTP download (defaultDownload) → real chmod → real `--version` smoke
 *   (defaultSmoke / execFileSync) → real renameSync over a running "binary" →
 *   re-exec the swapped binary and assert it reports the new version.
 *
 * Only `fetchRelease` is injected (to point at the local server instead of the
 * GitHub API). The "binary" is a `#!/bin/sh` script so the swap mechanics are
 * exercised identically on darwin + linux; platform/arch are pinned to
 * linux/x64 so `expectedAssetName` resolves deterministically regardless of host.
 *
 * No DB — runs in every environment.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBinarySelfUpdate, type ReleaseAsset } from '../../src/core/binary-self-update.ts';

const NEW_BINARY = '#!/bin/sh\necho "gbrain 0.43.0"\n';
const OLD_BINARY = '#!/bin/sh\necho "gbrain 0.42.0"\n';
const NON_GBRAIN = '#!/bin/sh\necho "not the tool"\n';

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/good-asset') return new Response(NEW_BINARY, { status: 200 });
      if (path === '/bad-smoke-asset') return new Response(NON_GBRAIN, { status: 200 });
      if (path === '/404-asset') return new Response('nope', { status: 404 });
      if (path === '/empty-asset') return new Response('', { status: 200 });
      return new Response('not found', { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function makeTargetBinary(): { dir: string; target: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-swap-'));
  const target = join(dir, 'gbrain');
  writeFileSync(target, OLD_BINARY);
  chmodSync(target, 0o755);
  return { dir, target };
}

function assets(url: string): ReleaseAsset[] {
  return [{ name: 'gbrain-linux-x64', url }];
}

function versionOf(path: string): string {
  return execFileSync(path, ['--version'], { encoding: 'utf-8' }).trim();
}

function tmpLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes('.tmp.'));
}

describe('binary self-update — real swap E2E', () => {
  test('happy path: downloads, smokes, atomically replaces the running binary', async () => {
    const { dir, target } = makeTargetBinary();
    try {
      expect(versionOf(target)).toBe('gbrain 0.42.0');
      const result = await runBinarySelfUpdate(target, {
        fetchRelease: async () => ({ tag: 'v0.43.0', assets: assets(`${base}/good-asset`) }),
        platform: 'linux',
        arch: 'x64',
      });
      expect(result.ok).toBe(true);
      expect(result.asset).toBe('gbrain-linux-x64');
      // The running "binary" was atomically replaced; a fresh exec sees the new version.
      expect(versionOf(target)).toBe('gbrain 0.43.0');
      expect(tmpLeftovers(dir)).toEqual([]); // staged temp renamed away, none left
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('smoke failure leaves the old binary untouched (no brick)', async () => {
    const { dir, target } = makeTargetBinary();
    try {
      const result = await runBinarySelfUpdate(target, {
        fetchRelease: async () => ({ tag: 'v0.43.0', assets: assets(`${base}/bad-smoke-asset`) }),
        platform: 'linux',
        arch: 'x64',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('smoke_failed');
      expect(versionOf(target)).toBe('gbrain 0.42.0'); // old binary intact
      expect(tmpLeftovers(dir)).toEqual([]); // staged temp cleaned up on failure
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('download HTTP error leaves the old binary untouched', async () => {
    const { dir, target } = makeTargetBinary();
    try {
      const result = await runBinarySelfUpdate(target, {
        fetchRelease: async () => ({ tag: 'v0.43.0', assets: assets(`${base}/404-asset`) }),
        platform: 'linux',
        arch: 'x64',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('download_failed');
      expect(versionOf(target)).toBe('gbrain 0.42.0');
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('empty downloaded asset is rejected, old binary intact', async () => {
    const { dir, target } = makeTargetBinary();
    try {
      const result = await runBinarySelfUpdate(target, {
        fetchRelease: async () => ({ tag: 'v0.43.0', assets: assets(`${base}/empty-asset`) }),
        platform: 'linux',
        arch: 'x64',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('download_failed');
      expect(versionOf(target)).toBe('gbrain 0.42.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no matching asset for platform → no_asset, no download attempted', async () => {
    const { dir, target } = makeTargetBinary();
    try {
      const result = await runBinarySelfUpdate(target, {
        fetchRelease: async () => ({ tag: 'v0.43.0', assets: [{ name: 'gbrain-darwin-arm64', url: `${base}/good-asset` }] }),
        platform: 'linux',
        arch: 'x64',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no_asset');
      expect(versionOf(target)).toBe('gbrain 0.42.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unsupported platform short-circuits before any network call', async () => {
    const { dir, target } = makeTargetBinary();
    let fetched = false;
    try {
      const result = await runBinarySelfUpdate(target, {
        fetchRelease: async () => {
          fetched = true;
          return { tag: 'v0.43.0', assets: assets(`${base}/good-asset`) };
        },
        platform: 'win32',
        arch: 'x64',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('unsupported_platform');
      expect(fetched).toBe(false); // never hit the network
      expect(versionOf(target)).toBe('gbrain 0.42.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
