import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  GIT_SSRF_FLAGS,
  parseRemoteUrl,
  RemoteUrlError,
  cloneRepo,
  pullRepo,
  GitOperationError,
  validateRepoState,
} from '../src/core/git-remote.ts';
import { withEnv } from './helpers/with-env.ts';

// ---------------------------------------------------------------------------
// Fake-git harness: write a shell script that records its argv to a log file,
// then prepend its dir to PATH for the test. Lets us assert exact argv shape
// without invoking real git.
// ---------------------------------------------------------------------------

const FAKE_GIT_DIR = join(tmpdir(), `gbrain-git-remote-test-${process.pid}`);
const FAKE_GIT_LOG = join(FAKE_GIT_DIR, 'argv.log');
const FAKE_GIT_MODE = join(FAKE_GIT_DIR, 'mode');

function writeFakeGit(): void {
  mkdirSync(FAKE_GIT_DIR, { recursive: true });
  // Mode file controls fake-git behavior: "ok" = exit 0, "fail" = exit 1.
  writeFileSync(FAKE_GIT_MODE, 'ok');
  // Per-invocation argv goes into argv.log (one JSON array per line).
  writeFileSync(FAKE_GIT_LOG, '');
  const script = `#!/usr/bin/env bash
# Fake git for git-remote.test.ts
{ printf '['; for arg in "$@"; do printf '%s,' "$(printf '%s' "$arg" | jq -Rs .)"; done; printf 'null]\\n'; } >> "${FAKE_GIT_LOG}"
mode=$(cat "${FAKE_GIT_MODE}" 2>/dev/null || echo ok)
case "$mode" in
  fail) exit 1 ;;
  url-drift) echo "https://github.com/different/url" ;;
  url-match) echo "https://github.com/expected/url" ;;
  *) ;;
esac
exit 0
`;
  const path = join(FAKE_GIT_DIR, 'git');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function readArgvLog(): string[][] {
  const raw = readFileSync(FAKE_GIT_LOG, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const arr = JSON.parse(line) as (string | null)[];
      return arr.filter((x): x is string => x !== null);
    });
}

function clearArgvLog(): void {
  writeFileSync(FAKE_GIT_LOG, '');
}

function setMode(mode: 'ok' | 'fail' | 'url-drift' | 'url-match'): void {
  writeFileSync(FAKE_GIT_MODE, mode);
}

beforeAll(() => writeFakeGit());
afterAll(() => rmSync(FAKE_GIT_DIR, { recursive: true, force: true }));
beforeEach(() => {
  clearArgvLog();
  setMode('ok');
});

const fakePath = (): string => `${FAKE_GIT_DIR}:${process.env.PATH ?? ''}`;

// ---------------------------------------------------------------------------
// GIT_SSRF_FLAGS — pinned shape (snapshot test). If a future flag is added,
// update the expected list here AND verify both cloneRepo + pullRepo pick it
// up via the GIT_SSRF_FLAGS spread (the codex finding that motivated this).
// ---------------------------------------------------------------------------

describe('GIT_SSRF_FLAGS', () => {
  test('exact shape — codex SSRF lockdown', () => {
    expect([...GIT_SSRF_FLAGS]).toEqual([
      '-c', 'http.followRedirects=false',
      '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ext.allow=never',
      '--no-recurse-submodules',
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseRemoteUrl
// ---------------------------------------------------------------------------

describe('parseRemoteUrl — happy path', () => {
  test('accepts plain https URL', () => {
    const r = parseRemoteUrl('https://github.com/garrytan/dummy.git');
    expect(r.url).toBe('https://github.com/garrytan/dummy.git');
    expect(r.hostname).toBe('github.com');
  });
});

describe('parseRemoteUrl — rejection cases', () => {
  test('rejects empty input', () => {
    expect(() => parseRemoteUrl('')).toThrow(RemoteUrlError);
  });
  test('rejects malformed URL', () => {
    expect(() => parseRemoteUrl('not a url')).toThrow(/malformed|invalid_url/i);
  });
  test('rejects ssh:// scheme', () => {
    try {
      parseRemoteUrl('ssh://git@github.com/foo/bar.git');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteUrlError);
      expect((e as RemoteUrlError).code).toBe('unsupported_scheme');
    }
  });
  test('rejects git:// scheme', () => {
    expect(() => parseRemoteUrl('git://github.com/foo/bar')).toThrow(/scheme not supported/i);
  });
  test('rejects file:// scheme', () => {
    expect(() => parseRemoteUrl('file:///etc/passwd')).toThrow(/scheme not supported/i);
  });
  test('rejects embedded credentials', () => {
    try {
      parseRemoteUrl('https://user:pass@github.com/foo');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteUrlError);
      expect((e as RemoteUrlError).code).toBe('embedded_credentials');
    }
  });
  test('rejects path traversal (..)', () => {
    try {
      parseRemoteUrl('https://github.com/foo/../etc/passwd');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteUrlError);
      expect((e as RemoteUrlError).code).toBe('path_traversal');
    }
  });
  test('rejects RFC1918 192.168.x.x', () => {
    try {
      parseRemoteUrl('https://192.168.1.1/repo.git');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteUrlError);
      expect((e as RemoteUrlError).code).toBe('internal_target');
    }
  });
  test('rejects loopback 127.0.0.1', () => {
    expect(() => parseRemoteUrl('https://127.0.0.1/repo')).toThrow(/internal/i);
  });
  test('rejects localhost', () => {
    expect(() => parseRemoteUrl('https://localhost/repo')).toThrow(/internal/i);
  });
  test('rejects metadata.google.internal', () => {
    expect(() => parseRemoteUrl('https://metadata.google.internal/foo')).toThrow(
      /internal/i,
    );
  });
  test('rejects 169.254.x.x AWS metadata range', () => {
    expect(() => parseRemoteUrl('https://169.254.169.254/foo')).toThrow(/internal/i);
  });

  // Codex v0.28.1 finding: IPv6 ULA + link-local were not blocked.
  test('rejects IPv6 ULA fc00::/7 (fd-prefix)', () => {
    expect(() => parseRemoteUrl('https://[fd00:1234::1]/repo')).toThrow(/internal/i);
  });
  test('rejects IPv6 ULA fc00::/7 (fc-prefix)', () => {
    expect(() => parseRemoteUrl('https://[fc01:2345::abcd]/repo')).toThrow(/internal/i);
  });
  test('rejects IPv6 link-local fe80::/10', () => {
    expect(() => parseRemoteUrl('https://[fe80::1]/repo')).toThrow(/internal/i);
  });
  test('does NOT reject public IPv6', () => {
    // 2606:4700:4700::1111 is Cloudflare DNS — public IPv6
    const r = parseRemoteUrl('https://[2606:4700:4700::1111]/repo');
    expect(r.hostname).toBe('[2606:4700:4700::1111]');
  });
});

// T3 — Tailscale CGNAT regression cases.
describe('parseRemoteUrl — CGNAT 100.64/10 (Tailscale)', () => {
  test('rejected by default', async () => {
    await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: undefined }, async () => {
      try {
        parseRemoteUrl('https://100.64.0.1/repo.git');
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RemoteUrlError);
        expect((e as RemoteUrlError).code).toBe('internal_target');
      }
    });
  });
  test('accepted with GBRAIN_ALLOW_PRIVATE_REMOTES=1', async () => {
    await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: '1' }, async () => {
      const r = parseRemoteUrl('https://100.64.0.1/repo.git');
      expect(r.hostname).toBe('100.64.0.1');
    });
  });
  test('also covers 100.127.x (upper end of CGNAT range)', async () => {
    await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: undefined }, async () => {
      expect(() => parseRemoteUrl('https://100.127.255.1/x')).toThrow(/internal/i);
    });
  });
  test('does NOT reject 100.0.x (just below CGNAT range)', () => {
    // 100.0.0.0/8 is regular public IP space outside CGNAT
    const r = parseRemoteUrl('https://100.63.255.1/repo');
    expect(r.hostname).toBe('100.63.255.1');
  });
});

// ---------------------------------------------------------------------------
// cloneRepo — fake-git harness
// ---------------------------------------------------------------------------

describe('cloneRepo', () => {
  test('happy path: invokes git with GIT_SSRF_FLAGS + --depth=1 + url + dest', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-target');
    rmSync(dest, { recursive: true, force: true });
    await withEnv({ PATH: fakePath() }, async () => {
      cloneRepo('https://example.com/repo', dest);
    });
    const calls = readArgvLog();
    expect(calls.length).toBe(1);
    const argv = calls[0];
    // Pin the SSRF flags before the 'clone' verb (codex Q2 invariant).
    expect(argv.slice(0, GIT_SSRF_FLAGS.length)).toEqual([...GIT_SSRF_FLAGS]);
    expect(argv).toContain('clone');
    expect(argv).toContain('--depth=1');
    expect(argv).toContain('https://example.com/repo');
    expect(argv[argv.length - 1]).toBe(dest);
  });

  test('depth=0 means no --depth flag (full clone)', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-full');
    rmSync(dest, { recursive: true, force: true });
    await withEnv({ PATH: fakePath() }, async () => {
      cloneRepo('https://example.com/repo', dest, { depth: 0 });
    });
    const argv = readArgvLog()[0];
    expect(argv.find(a => a.startsWith('--depth'))).toBeUndefined();
  });

  test('passes --branch when provided', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-branch');
    rmSync(dest, { recursive: true, force: true });
    await withEnv({ PATH: fakePath() }, async () => {
      cloneRepo('https://example.com/repo', dest, { branch: 'main' });
    });
    const argv = readArgvLog()[0];
    const branchIdx = argv.indexOf('--branch');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(argv[branchIdx + 1]).toBe('main');
  });

  test('refuses non-empty destDir', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-nonempty');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'sentinel'), 'hi');
    await withEnv({ PATH: fakePath() }, async () => {
      try {
        cloneRepo('https://example.com/repo', dest);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(GitOperationError);
        expect((e as GitOperationError).op).toBe('clone');
      }
    });
    expect(readArgvLog().length).toBe(0); // never invoked git
    rmSync(dest, { recursive: true, force: true });
  });

  test('throws GitOperationError when git exits non-zero', async () => {
    const dest = join(FAKE_GIT_DIR, 'clone-fails');
    rmSync(dest, { recursive: true, force: true });
    setMode('fail');
    await withEnv({ PATH: fakePath() }, async () => {
      try {
        cloneRepo('https://example.com/repo', dest);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(GitOperationError);
        expect((e as GitOperationError).op).toBe('clone');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// pullRepo — fake-git harness
// ---------------------------------------------------------------------------

describe('pullRepo', () => {
  test('happy path: invokes git -C path with GIT_SSRF_FLAGS + pull --ff-only', async () => {
    const repo = join(FAKE_GIT_DIR, 'pull-target');
    mkdirSync(repo, { recursive: true });
    await withEnv({ PATH: fakePath() }, async () => {
      pullRepo(repo);
    });
    const argv = readArgvLog()[0];
    expect(argv[0]).toBe('-C');
    expect(argv[1]).toBe(repo);
    expect(argv.slice(2, 2 + GIT_SSRF_FLAGS.length)).toEqual([...GIT_SSRF_FLAGS]);
    expect(argv).toContain('pull');
    expect(argv).toContain('--ff-only');
    rmSync(repo, { recursive: true, force: true });
  });

  test('throws GitOperationError when git exits non-zero', async () => {
    const repo = join(FAKE_GIT_DIR, 'pull-fails');
    mkdirSync(repo, { recursive: true });
    setMode('fail');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(() => pullRepo(repo)).toThrow(GitOperationError);
    });
    rmSync(repo, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// validateRepoState — 6-state decision tree
// ---------------------------------------------------------------------------

describe('validateRepoState', () => {
  const fixtureDir = join(FAKE_GIT_DIR, 'state-fixtures');

  beforeEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
    mkdirSync(fixtureDir, { recursive: true });
  });

  test("returns 'missing' for nonexistent path", () => {
    expect(validateRepoState(join(fixtureDir, 'nope'))).toBe('missing');
  });

  test("returns 'not-a-dir' when path is a file", () => {
    const p = join(fixtureDir, 'a-file');
    writeFileSync(p, 'hi');
    expect(validateRepoState(p)).toBe('not-a-dir');
  });

  test("returns 'no-git' for directory without .git/", () => {
    const p = join(fixtureDir, 'no-git-dir');
    mkdirSync(p, { recursive: true });
    expect(validateRepoState(p)).toBe('no-git');
  });

  test("returns 'corrupted' when git remote get-url fails", async () => {
    const p = join(fixtureDir, 'corrupted-repo');
    mkdirSync(join(p, '.git'), { recursive: true });
    setMode('fail');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(validateRepoState(p)).toBe('corrupted');
    });
  });

  test("returns 'url-drift' when remote differs from expected", async () => {
    const p = join(fixtureDir, 'drift-repo');
    mkdirSync(join(p, '.git'), { recursive: true });
    setMode('url-drift');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(validateRepoState(p, 'https://github.com/expected/url')).toBe('url-drift');
    });
  });

  test("returns 'healthy' when remote matches expected", async () => {
    const p = join(fixtureDir, 'healthy-repo');
    mkdirSync(join(p, '.git'), { recursive: true });
    setMode('url-match');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(validateRepoState(p, 'https://github.com/expected/url')).toBe('healthy');
    });
  });

  test("returns 'healthy' when no expected URL provided (just probe)", async () => {
    const p = join(fixtureDir, 'healthy-no-expect');
    mkdirSync(join(p, '.git'), { recursive: true });
    setMode('ok');
    await withEnv({ PATH: fakePath() }, async () => {
      expect(validateRepoState(p)).toBe('healthy');
    });
  });
});
