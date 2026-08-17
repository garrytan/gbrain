/**
 * E2E: real atomic binary self-update against a live local release server.
 *
 * Unlike test/binary-self-update.test.ts (which stubs `download` + `smoke` to
 * exercise the orchestration), this drives the REAL dangerous path end-to-end:
 *   real HTTP download (defaultDownload) → real chmod → real `--version` smoke
 *   (defaultSmoke / execFileSync) → real renameSync over a running "binary" →
 *   re-exec the swapped binary and assert it reports the new version.
 *
 * Only `fetchRelease` and `fetchAttestation` are injected (to point at the local
 * server / an in-process attestation instead of the GitHub API — tests must
 * never hit the real network). The DIGEST computation stays REAL
 * (`defaultComputeDigest` runs, uninjected): the in-process attestation carries
 * the true sha256 of the served bytes, so the integrity gate is exercised
 * end-to-end, not bypassed. The "binary" is a `#!/bin/sh` script so the swap
 * mechanics are exercised identically on darwin + linux; platform/arch are
 * pinned to linux/x64 so `expectedAssetName` resolves deterministically
 * regardless of host.
 *
 * No DB — runs in every environment.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXPECTED_BUILDER_IDS,
  runBinarySelfUpdate,
  type ParsedAttestation,
  type ReleaseAsset,
} from '../../src/core/binary-self-update.ts';

const NEW_BINARY = '#!/bin/sh\necho "gbrain 0.43.0"\n';
const OLD_BINARY = '#!/bin/sh\necho "gbrain 0.42.0"\n';
const NON_GBRAIN = '#!/bin/sh\necho "not the tool"\n';
// A real gbrain binary, but an OLDER version than the release claims — the
// downgrade-replay an asset-swap adversary would serve (its old digest still
// has a valid attestation).
const OLD_ATTESTED_BINARY = '#!/bin/sh\necho "gbrain 0.41.0"\n';

/** Attestation deps whose subject digest is the REAL sha256 of `content` —
 * integrity passes only because the served bytes genuinely match. */
function attestationFor(content: string): {
  fetchAttestation: () => Promise<ParsedAttestation[]>;
} {
  const digest = createHash('sha256').update(content).digest('hex');
  return {
    fetchAttestation: async () => [
      { subjects: [{ name: 'gbrain-linux-x64', sha256: digest }], builderId: EXPECTED_BUILDER_IDS[0]! },
    ],
  };
}

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/good-asset') return new Response(NEW_BINARY, { status: 200 });
      if (path === '/downgrade-asset') return new Response(OLD_ATTESTED_BINARY, { status: 200 });
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
        ...attestationFor(NEW_BINARY),
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
        // Attestation genuinely matches the served bytes, so integrity passes
        // and the failure is isolated to the smoke step (the case under test).
        ...attestationFor(NON_GBRAIN),
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

  test('missing attestation → integrity_unavailable: never executed, old binary intact, no leftovers', async () => {
    const { dir, target } = makeTargetBinary();
    try {
      const result = await runBinarySelfUpdate(target, {
        fetchRelease: async () => ({ tag: 'v0.43.0', assets: assets(`${base}/good-asset`) }),
        fetchAttestation: async () => null, // 404 / offline / rate-limited
        platform: 'linux',
        arch: 'x64',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('integrity_unavailable');
      expect(versionOf(target)).toBe('gbrain 0.42.0'); // fail-closed, old binary intact
      expect(tmpLeftovers(dir)).toEqual([]); // unverified download discarded
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('downgrade replay: older attested binary served for a newer tag → version_mismatch, no swap', async () => {
    const { dir, target } = makeTargetBinary();
    try {
      const result = await runBinarySelfUpdate(target, {
        // Release tag is v0.43.0, but the served bytes are a real, validly
        // attested gbrain 0.41.0 (its digest has a genuine attestation).
        fetchRelease: async () => ({ tag: 'v0.43.0', assets: assets(`${base}/downgrade-asset`) }),
        ...attestationFor(OLD_ATTESTED_BINARY), // digest+builder verify PASSES
        platform: 'linux',
        arch: 'x64',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('version_mismatch'); // real --version says 0.41.0, tag says 0.43.0
      expect(versionOf(target)).toBe('gbrain 0.42.0'); // running binary untouched
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tampered bytes (digest not attested) → integrity_failed before any exec', async () => {
    const { dir, target } = makeTargetBinary();
    try {
      const result = await runBinarySelfUpdate(target, {
        // Server serves NEW_BINARY, but the attestation covers different bytes.
        fetchRelease: async () => ({ tag: 'v0.43.0', assets: assets(`${base}/good-asset`) }),
        ...attestationFor('DIFFERENT CONTENT ENTIRELY'),
        platform: 'linux',
        arch: 'x64',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('integrity_failed');
      expect(versionOf(target)).toBe('gbrain 0.42.0');
      expect(tmpLeftovers(dir)).toEqual([]);
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
