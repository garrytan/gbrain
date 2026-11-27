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
import { withEnv } from './helpers/with-env.ts';

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
      expect(res.targetVersion).toBe('9.9.9');
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
      expect(res.targetVersion).toBe('9.9.9');
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
      expect(res.targetVersion).toBe('9.9.9');
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

describe('defaultFetchAttestation: GitHub token and failure detail', () => {
  const REAL_FETCH = globalThis.fetch;
  const TOKEN = 'ghs_test-token-not-real';
  const VALID = {
    attestations: [{
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(JSON.stringify({
            subject: [{ name: 'gbrain-darwin-arm64', digest: { sha256: FAKE_DIGEST } }],
            predicate: { runDetails: { builder: { id: VALID_BUILDER } } },
          })).toString('base64'),
        },
      },
    }],
  };
  /** Stubs fetch with one response per call, in order, and records each call's Authorization header. */
  function stubFetch(responses: Response[]): (string | null)[] {
    const auth: (string | null)[] = [];
    (globalThis as any).fetch = (_input: any, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(responses.shift() ?? new Response('unexpected call', { status: 500 }));
    };
    return auth;
  }
  async function fetchWith(env: Record<string, string | undefined>, responses: Response[]) {
    const auth = stubFetch(responses);
    const details: string[] = [];
    try {
      const parsed = await withEnv(env, () => defaultFetchAttestation(FAKE_DIGEST, (d) => details.push(d)));
      return { parsed, auth, details };
    } finally {
      (globalThis as any).fetch = REAL_FETCH;
    }
  }

  test('GH_TOKEN, else GITHUB_TOKEN, is sent as a bearer token', async () => {
    const gh = await fetchWith({ GH_TOKEN: TOKEN, GITHUB_TOKEN: 'other' }, [Response.json(VALID)]);
    expect(gh.auth).toEqual([`Bearer ${TOKEN}`]);
    expect(gh.parsed?.[0]?.builderId).toBe(VALID_BUILDER);
    const actions = await fetchWith({ GH_TOKEN: undefined, GITHUB_TOKEN: TOKEN }, [Response.json(VALID)]);
    expect(actions.auth).toEqual([`Bearer ${TOKEN}`]);
  });

  test('with no token set the call stays keyless and still verifies', async () => {
    const r = await fetchWith({ GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, [Response.json(VALID)]);
    expect(r.auth).toEqual([null]);
    expect(r.parsed?.[0]?.builderId).toBe(VALID_BUILDER);
    expect(r.details).toEqual([]);
    const blank = await fetchWith({ GH_TOKEN: '  ', GITHUB_TOKEN: '' }, [Response.json(VALID)]);
    expect(blank.auth).toEqual([null]);
  });

  test('a token GitHub refuses (401, 403, or a masked 404) is retried once without it', async () => {
    for (const status of [401, 403, 404]) {
      const r = await fetchWith({ GH_TOKEN: TOKEN }, [new Response('refused', { status }), Response.json(VALID)]);
      expect({ status, auth: r.auth }).toEqual({ status, auth: [`Bearer ${TOKEN}`, null] });
      expect(r.parsed?.[0]?.builderId).toBe(VALID_BUILDER);
    }
    const both = await fetchWith({ GH_TOKEN: TOKEN }, [new Response('refused', { status: 403 }), new Response('API rate limit exceeded', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })]);
    expect(both.parsed).toBeNull();
    expect(both.details).toEqual(['HTTP 403 from the GitHub attestation API (with a GitHub token); HTTP 403 from the GitHub attestation API (no GitHub token), x-ratelimit-remaining 0']);
  });

  test('an exhausted token bucket (429) or a token that is not a valid header value still reads the keyless attestation', async () => {
    const limited = await fetchWith({ GH_TOKEN: TOKEN }, [new Response('slow down', { status: 429, headers: { 'x-ratelimit-remaining': '0' } }), Response.json(VALID)]);
    expect(limited.auth).toEqual([`Bearer ${TOKEN}`, null]);
    expect(limited.parsed?.[0]?.builderId).toBe(VALID_BUILDER);
    const REAL = globalThis.fetch;
    let keyless = 0;
    (globalThis as any).fetch = (input: any, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      keyless += headers.has('authorization') ? 0 : 1;
      return Promise.resolve(Response.json(VALID));
    };
    try {
      const parsed = await withEnv({ GH_TOKEN: 'two\nlines', GITHUB_TOKEN: undefined }, () => defaultFetchAttestation(FAKE_DIGEST));
      expect(parsed?.[0]?.builderId).toBe(VALID_BUILDER);
      expect(keyless).toBe(1);
    } finally {
      (globalThis as any).fetch = REAL;
    }
  });

  test('a blank GH_TOKEN does not hide GITHUB_TOKEN', async () => {
    const r = await fetchWith({ GH_TOKEN: '  ', GITHUB_TOKEN: TOKEN }, [Response.json(VALID)]);
    expect(r.auth).toEqual([`Bearer ${TOKEN}`]);
  });

  test('Bun\'s verbose fetch logging never prints the token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-attest-verbose-'));
    try {
      const script = join(dir, 'probe.ts');
      writeFileSync(script, [
        `import { defaultFetchAttestation } from ${JSON.stringify(join(import.meta.dir, '../src/core/binary-self-update.ts'))};`,
        "const server = Bun.serve({ port: 0, fetch: () => new Response('none', { status: 404 }) });",
        'const real = globalThis.fetch;',
        "await real(`http://127.0.0.1:${server.port}/probe-logged`);",
        "(globalThis as any).fetch = (_url: unknown, init?: RequestInit) => real(`http://127.0.0.1:${server.port}/`, init);",
        "await defaultFetchAttestation('a'.repeat(64));",
        'server.stop(true);',
      ].join('\n'));
      const r = Bun.spawnSync([process.execPath, script], {
        env: { ...process.env, BUN_CONFIG_VERBOSE_FETCH: 'curl', GH_TOKEN: TOKEN, GITHUB_TOKEN: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = r.stdout.toString() + r.stderr.toString();
      expect(r.exitCode).toBe(0);
      expect(out).toContain('probe-logged');
      expect(out).not.toContain(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failure with the token never puts the error text, which can quote the header, into the detail', async () => {
    const REAL = globalThis.fetch;
    (globalThis as any).fetch = (_input: any, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      return Promise.reject(new TypeError(auth ? `"${auth}" is an invalid header value` : 'ENETDOWN'));
    };
    const details: string[] = [];
    try {
      const parsed = await withEnv({ GH_TOKEN: TOKEN, GITHUB_TOKEN: undefined }, () => defaultFetchAttestation(FAKE_DIGEST, (d) => details.push(d)));
      expect(parsed).toBeNull();
      expect(details).toEqual(['the GitHub attestation API could not be read (with a GitHub token); the GitHub attestation API could not be read (no GitHub token): ENETDOWN']);
      expect(details.join('')).not.toContain(TOKEN);
    } finally {
      (globalThis as any).fetch = REAL;
    }
  });

  test('a rate-limited response is null, with the status and rate-limit headers in the detail and never the token', async () => {
    const limited = new Response('API rate limit exceeded', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795000000' },
    });
    const r = await fetchWith({ GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, [limited]);
    expect(r.parsed).toBeNull();
    expect(r.details).toEqual([
      'HTTP 403 from the GitHub attestation API (no GitHub token), x-ratelimit-remaining 0, x-ratelimit-reset 2026-11-18T11:06:40.000Z',
    ]);
    const authed = await fetchWith({ GH_TOKEN: TOKEN }, [new Response('slow down', { status: 429 }), new Response('slow down', { status: 429 })]);
    expect(authed.parsed).toBeNull();
    expect(authed.details).toEqual(['HTTP 429 from the GitHub attestation API (with a GitHub token); HTTP 429 from the GitHub attestation API (no GitHub token)']);
    expect(authed.details.join('')).not.toContain(TOKEN);
  });

  test('a network error and an empty answer are null with a detail', async () => {
    (globalThis as any).fetch = () => Promise.reject(new Error('ENETDOWN'));
    const details: string[] = [];
    try {
      expect(await withEnv({ GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, () => defaultFetchAttestation(FAKE_DIGEST, (d) => details.push(d)))).toBeNull();
    } finally {
      (globalThis as any).fetch = REAL_FETCH;
    }
    expect(details).toEqual(['the GitHub attestation API could not be read (no GitHub token): ENETDOWN']);
    const empty = await fetchWith({ GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, [Response.json({ attestations: [] })]);
    expect(empty.parsed).toBeNull();
    expect(empty.details).toEqual(['the GitHub attestation API returned no usable build attestation (no GitHub token)']);
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
