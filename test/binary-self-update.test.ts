import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultFetchAttestation,
  expectedAssetName,
  parseAttestationBundle,
  resolvePlatformAsset,
  runBinarySelfUpdate,
  verifyIntegrity,
  type ParsedAttestation,
  type ReleaseAsset,
} from '../src/core/binary-self-update.ts';

const ASSETS: ReleaseAsset[] = [
  { name: 'gbrain-darwin-arm64', url: 'https://example.com/darwin-arm64' },
  { name: 'gbrain-linux-x64', url: 'https://example.com/linux-x64' },
];

// A builder id that matches EXPECTED_BUILDER_ID_PREFIX (this repo's release workflow).
const VALID_BUILDER = 'https://github.com/garrytan/gbrain/.github/workflows/release.yml@refs/heads/master';
const FAKE_DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

/**
 * Integrity deps that PASS for `assetName` at `digest`: computeDigest is pinned
 * so we don't depend on file bytes, and fetchAttestation returns a matching
 * SLSA-provenance attestation. Used to isolate the non-integrity behaviors that
 * predate this gate.
 */
function passingIntegrity(assetName: string, digest = FAKE_DIGEST) {
  return {
    computeDigest: () => digest,
    fetchAttestation: async (): Promise<ParsedAttestation[]> => [
      { subjects: [{ name: assetName, sha256: digest }], builderId: VALID_BUILDER },
    ],
  };
}

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
  test('happy path: stages, verifies integrity, smokes, atomically replaces the target', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD BINARY');
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async (_url, dest) => writeFileSync(dest, 'NEW BINARY'),
        smoke: () => true,
        checkVersion: () => true, // staged bytes are not a real binary; version bind is covered in e2e
        ...passingIntegrity('gbrain-darwin-arm64'),
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
        ...passingIntegrity('gbrain-darwin-arm64'),
      });
      expect(res.reason).toBe('smoke_failed');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
    });
  });

  test('version mismatch (downgrade-replay) → version_mismatch, target untouched, no rename', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        // Release claims v9.9.9, but the staged (validly-attested, older) binary
        // reports a different version → downgrade blocked before rename.
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async (_url, dest) => writeFileSync(dest, 'OLD ATTESTED BINARY'),
        smoke: () => true,
        checkVersion: (_p, expected) => expected === '1.2.3', // staged reports 1.2.3, expected 9.9.9
        ...passingIntegrity('gbrain-darwin-arm64'),
      });
      expect(res.reason).toBe('version_mismatch');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
      expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]);
    });
  });

  // --- Integrity gate (WS2) ---

  test('tampered binary (digest not attested) → integrity_failed, target untouched, NEVER executed', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      let smokeCalled = false;
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async (_url, dest) => writeFileSync(dest, 'TAMPERED'),
        computeDigest: () => FAKE_DIGEST,
        // Attestation exists but covers a DIFFERENT digest.
        fetchAttestation: async () => [
          { subjects: [{ name: 'gbrain-darwin-arm64', sha256: OTHER_DIGEST }], builderId: VALID_BUILDER },
        ],
        smoke: () => {
          smokeCalled = true;
          return true;
        },
      });
      expect(res.reason).toBe('integrity_failed');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
      expect(smokeCalled).toBe(false); // integrity gates BEFORE exec
      expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]); // unverified download discarded
    });
  });

  test('untrusted builder id → integrity_failed even when digest matches', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async (_url, dest) => writeFileSync(dest, 'NEW'),
        computeDigest: () => FAKE_DIGEST,
        fetchAttestation: async () => [
          {
            subjects: [{ name: 'gbrain-darwin-arm64', sha256: FAKE_DIGEST }],
            builderId: 'https://github.com/evil/fork/.github/workflows/release.yml@refs/heads/master',
          },
        ],
        smoke: () => true,
      });
      expect(res.reason).toBe('integrity_failed');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
    });
  });

  test('no attestation available (404/offline/rate-limited) → integrity_unavailable, fail-closed', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      let smokeCalled = false;
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async (_url, dest) => writeFileSync(dest, 'NEW'),
        computeDigest: () => FAKE_DIGEST,
        fetchAttestation: async () => null, // endpoint unreachable / 403 / 404
        smoke: () => {
          smokeCalled = true;
          return true;
        },
      });
      expect(res.reason).toBe('integrity_unavailable');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
      expect(smokeCalled).toBe(false);
      expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]); // unverified download discarded
    });
  });

  test('right workflow, wrong ref (dispatch from a non-master branch) → integrity_failed', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async (_url, dest) => writeFileSync(dest, 'NEW'),
        computeDigest: () => FAKE_DIGEST,
        fetchAttestation: async () => [
          {
            subjects: [{ name: 'gbrain-darwin-arm64', sha256: FAKE_DIGEST }],
            // Same repo + workflow, but minted from an arbitrary branch dispatch.
            builderId:
              'https://github.com/garrytan/gbrain/.github/workflows/release.yml@refs/heads/attacker-branch',
          },
        ],
        smoke: () => true,
      });
      expect(res.reason).toBe('integrity_failed');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
    });
  });

  test('attestation names a different asset → integrity_failed', async () => {
    await withTmp(async (dir) => {
      const target = join(dir, 'gbrain');
      writeFileSync(target, 'OLD');
      const res = await runBinarySelfUpdate(target, {
        platform: 'darwin',
        arch: 'arm64',
        fetchRelease: async () => ({ tag: 'v9.9.9', assets: ASSETS }),
        download: async (_url, dest) => writeFileSync(dest, 'NEW'),
        computeDigest: () => FAKE_DIGEST,
        // Right digest + builder, but attests the linux asset, not ours.
        fetchAttestation: async () => [
          { subjects: [{ name: 'gbrain-linux-x64', sha256: FAKE_DIGEST }], builderId: VALID_BUILDER },
        ],
        smoke: () => true,
      });
      expect(res.reason).toBe('integrity_failed');
      expect(readFileSync(target, 'utf8')).toBe('OLD');
    });
  });
});

describe('verifyIntegrity (unit)', () => {
  const good = (): ParsedAttestation[] => [
    { subjects: [{ name: 'gbrain-linux-x64', sha256: FAKE_DIGEST }], builderId: VALID_BUILDER },
  ];
  test('passes on name + digest + builder match', async () => {
    expect(await verifyIntegrity('/x', 'gbrain-linux-x64', () => FAKE_DIGEST, async () => good())).toBeNull();
  });
  test('non-hex digest → integrity_unavailable', async () => {
    expect(await verifyIntegrity('/x', 'gbrain-linux-x64', () => 'not-a-digest', async () => good())).toBe(
      'integrity_unavailable',
    );
  });
  test('computeDigest throws → integrity_unavailable', async () => {
    expect(
      await verifyIntegrity('/x', 'gbrain-linux-x64', () => {
        throw new Error('nope');
      }, async () => good()),
    ).toBe('integrity_unavailable');
  });
  test('empty attestation array → integrity_unavailable (not failed, not verified)', async () => {
    expect(await verifyIntegrity('/x', 'gbrain-linux-x64', () => FAKE_DIGEST, async () => [])).toBe(
      'integrity_unavailable',
    );
  });
});

describe('defaultFetchAttestation (global fetch stubbed)', () => {
  const REAL_FETCH = globalThis.fetch;
  function stubFetch(impl: (url: string) => Promise<Response> | Response) {
    (globalThis as any).fetch = (input: any) => Promise.resolve(impl(String(input)));
  }
  function restoreFetch() {
    (globalThis as any).fetch = REAL_FETCH;
  }
  function apiResponse(attestations: unknown[]): Response {
    return new Response(JSON.stringify({ attestations }), { status: 200 });
  }
  function bundleFor(stmt: unknown) {
    return { bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(stmt)).toString('base64') } } };
  }
  const VALID_STMT = {
    subject: [{ name: 'gbrain-linux-x64', digest: { sha256: FAKE_DIGEST } }],
    predicate: { runDetails: { builder: { id: VALID_BUILDER } } },
  };

  test('200 with valid bundles → parsed attestations', async () => {
    stubFetch(() => apiResponse([bundleFor(VALID_STMT)]));
    try {
      const parsed = await defaultFetchAttestation(FAKE_DIGEST);
      expect(parsed).not.toBeNull();
      expect(parsed![0]!.builderId).toBe(VALID_BUILDER);
      expect(parsed![0]!.subjects).toEqual([{ name: 'gbrain-linux-x64', sha256: FAKE_DIGEST }]);
    } finally {
      restoreFetch();
    }
  });
  test('404 / 403 (non-2xx) → null (unavailable, never verified)', async () => {
    stubFetch(() => new Response('nope', { status: 404 }));
    try {
      expect(await defaultFetchAttestation(FAKE_DIGEST)).toBeNull();
    } finally {
      restoreFetch();
    }
    stubFetch(() => new Response('rate limited', { status: 403 }));
    try {
      expect(await defaultFetchAttestation(FAKE_DIGEST)).toBeNull();
    } finally {
      restoreFetch();
    }
  });
  test('200 with empty attestations array → null', async () => {
    stubFetch(() => apiResponse([]));
    try {
      expect(await defaultFetchAttestation(FAKE_DIGEST)).toBeNull();
    } finally {
      restoreFetch();
    }
  });
  test('200 with only malformed bundles → null', async () => {
    stubFetch(() => apiResponse([{ bundle: {} }, { bundle: { dsseEnvelope: { payload: '!!!' } } }]));
    try {
      expect(await defaultFetchAttestation(FAKE_DIGEST)).toBeNull();
    } finally {
      restoreFetch();
    }
  });
  test('fetch throws (network down) → null', async () => {
    stubFetch(() => {
      throw new Error('ENETDOWN');
    });
    try {
      expect(await defaultFetchAttestation(FAKE_DIGEST)).toBeNull();
    } finally {
      restoreFetch();
    }
  });
});

describe('parseAttestationBundle', () => {
  function bundleFor(stmt: unknown) {
    return { dsseEnvelope: { payload: Buffer.from(JSON.stringify(stmt)).toString('base64') } };
  }
  test('decodes subjects + builder id from a real-shaped SLSA statement', () => {
    const parsed = parseAttestationBundle(
      bundleFor({
        _type: 'https://in-toto.io/Statement/v1',
        subject: [{ name: 'gbrain-linux-x64', digest: { sha256: FAKE_DIGEST } }],
        predicateType: 'https://slsa.dev/provenance/v1',
        predicate: { runDetails: { builder: { id: VALID_BUILDER } } },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.builderId).toBe(VALID_BUILDER);
    expect(parsed!.subjects).toEqual([{ name: 'gbrain-linux-x64', sha256: FAKE_DIGEST }]);
  });
  test('missing payload → null', () => {
    expect(parseAttestationBundle({})).toBeNull();
    expect(parseAttestationBundle({ dsseEnvelope: {} })).toBeNull();
  });
  test('undecodable / non-JSON payload → null', () => {
    expect(parseAttestationBundle({ dsseEnvelope: { payload: '!!!not base64 json!!!' } })).toBeNull();
  });
  test('no subject or no builder → null', () => {
    expect(parseAttestationBundle(bundleFor({ subject: [], predicate: {} }))).toBeNull();
    expect(
      parseAttestationBundle(bundleFor({ subject: [{ name: 'x', digest: { sha256: FAKE_DIGEST } }], predicate: {} })),
    ).toBeNull();
  });
  test('non-SLSA predicateType → null (only build-provenance is accepted)', () => {
    expect(
      parseAttestationBundle(
        bundleFor({
          predicateType: 'https://in-toto.io/attestation/vuln/v0.1',
          subject: [{ name: 'gbrain-linux-x64', digest: { sha256: FAKE_DIGEST } }],
          predicate: { runDetails: { builder: { id: VALID_BUILDER } } },
        }),
      ),
    ).toBeNull();
  });
});
