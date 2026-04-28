import { describe, test, expect, afterEach } from 'bun:test';
import { parseSemver, isMinorOrMajorBump, extractChangelogBetween, classifyHttpStatus, fetchLatestRelease } from '../src/commands/check-update.ts';

describe('parseSemver', () => {
  test('parses standard version', () => {
    expect(parseSemver('0.4.0')).toEqual([0, 4, 0]);
  });

  test('strips v prefix', () => {
    expect(parseSemver('v0.5.0')).toEqual([0, 5, 0]);
  });

  test('returns null for malformed version', () => {
    expect(parseSemver('0.4')).toBeNull();
    expect(parseSemver('abc')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });

  test('handles 4-part versions (takes first 3)', () => {
    expect(parseSemver('0.2.0.1')).toEqual([0, 2, 0]);
  });
});

describe('isMinorOrMajorBump', () => {
  test('0.4.0 vs 0.5.0 → update available (minor bump)', () => {
    expect(isMinorOrMajorBump('0.4.0', '0.5.0')).toBe(true);
  });

  test('0.4.0 vs 0.4.1 → NOT available (patch only)', () => {
    expect(isMinorOrMajorBump('0.4.0', '0.4.1')).toBe(false);
  });

  test('0.4.0 vs 1.0.0 → update available (major bump)', () => {
    expect(isMinorOrMajorBump('0.4.0', '1.0.0')).toBe(true);
  });

  test('0.4.0 vs 0.4.0 → NOT available (same version)', () => {
    expect(isMinorOrMajorBump('0.4.0', '0.4.0')).toBe(false);
  });

  test('0.4.0 vs 0.3.0 → NOT available (older)', () => {
    expect(isMinorOrMajorBump('0.4.0', '0.3.0')).toBe(false);
  });

  test('0.4.1 vs 0.5.0 → update available (minor bump, different patch)', () => {
    expect(isMinorOrMajorBump('0.4.1', '0.5.0')).toBe(true);
  });

  test('malformed version → returns false', () => {
    expect(isMinorOrMajorBump('0.4.0', 'abc')).toBe(false);
    expect(isMinorOrMajorBump('bad', '0.5.0')).toBe(false);
  });

  test('handles v prefix on latest', () => {
    expect(isMinorOrMajorBump('0.4.0', 'v0.5.0')).toBe(true);
  });
});

describe('extractChangelogBetween', () => {
  const changelog = `# Changelog

## [0.5.0] - 2026-05-01

### Added
- Feature X

## [0.4.1] - 2026-04-15

### Fixed
- Bug Y

## [0.4.0] - 2026-04-09

### Added
- Feature Z

## [0.3.0] - 2026-04-08

### Added
- Feature W
`;

  test('extracts entries between 0.4.0 and 0.5.0', () => {
    const result = extractChangelogBetween(changelog, '0.4.0', '0.5.0');
    expect(result).toContain('Feature X');
    expect(result).toContain('Bug Y');
    expect(result).not.toContain('Feature Z');
    expect(result).not.toContain('Feature W');
  });

  test('extracts only 0.5.0 when upgrading from 0.4.1', () => {
    const result = extractChangelogBetween(changelog, '0.4.1', '0.5.0');
    expect(result).toContain('Feature X');
    expect(result).not.toContain('Bug Y');
  });

  test('returns empty for same version', () => {
    const result = extractChangelogBetween(changelog, '0.5.0', '0.5.0');
    expect(result).toBe('');
  });

  test('returns empty for malformed from version', () => {
    const result = extractChangelogBetween(changelog, 'bad', '0.5.0');
    expect(result).toBe('');
  });

  test('does not capture older major versions incorrectly', () => {
    const crossMajor = `# Changelog

## [2.0.0] - 2026-06-01
### Added
- Major 2

## [0.5.0] - 2026-05-01
### Added
- Minor 5
`;
    const result = extractChangelogBetween(crossMajor, '1.2.0', '2.0.0');
    expect(result).toContain('Major 2');
    expect(result).not.toContain('Minor 5');
  });
});

describe('classifyHttpStatus', () => {
  test('404 → no_releases (permanent, NOT transient)', () => {
    expect(classifyHttpStatus(404)).toEqual({ error: 'no_releases', transient: false });
  });

  test('429 → rate_limited (transient)', () => {
    expect(classifyHttpStatus(429)).toEqual({ error: 'rate_limited', transient: true });
  });

  test('5xx → http_error (transient)', () => {
    expect(classifyHttpStatus(500)).toEqual({ error: 'http_error', transient: true });
    expect(classifyHttpStatus(502)).toEqual({ error: 'http_error', transient: true });
    expect(classifyHttpStatus(503)).toEqual({ error: 'http_error', transient: true });
  });

  test('403 → http_error (transient — likely auth/abuse-detection, retry next cycle)', () => {
    expect(classifyHttpStatus(403)).toEqual({ error: 'http_error', transient: true });
  });

  test('only no_releases is non-transient (the alert-worthy signal)', () => {
    for (const status of [400, 401, 403, 408, 429, 500, 502, 503, 504]) {
      expect(classifyHttpStatus(status).transient).toBe(true);
    }
    expect(classifyHttpStatus(404).transient).toBe(false);
  });
});

describe('fetchLatestRelease (malformed responses)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stubFetch(response: Response) {
    globalThis.fetch = (async () => response) as unknown as typeof fetch;
  }

  test('2xx with non-JSON body → transient http_error (does not throw)', async () => {
    stubFetch(new Response('<html>cloudflare error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const result = await fetchLatestRelease();
    expect(result).toEqual({ ok: false, error: 'http_error', transient: true });
  });

  test('2xx with truncated JSON → transient http_error (does not throw)', async () => {
    stubFetch(new Response('{"tag_name": "v0.5.', { status: 200 }));
    const result = await fetchLatestRelease();
    expect(result).toEqual({ ok: false, error: 'http_error', transient: true });
  });

  test('2xx with JSON missing tag_name → transient http_error', async () => {
    stubFetch(new Response('{"name":"some release"}', { status: 200 }));
    const result = await fetchLatestRelease();
    expect(result).toEqual({ ok: false, error: 'http_error', transient: true });
  });

  test('2xx with empty tag_name → transient http_error', async () => {
    stubFetch(new Response('{"tag_name": ""}', { status: 200 }));
    const result = await fetchLatestRelease();
    expect(result).toEqual({ ok: false, error: 'http_error', transient: true });
  });

  test('2xx with valid tag_name → ok', async () => {
    stubFetch(new Response(JSON.stringify({
      tag_name: 'v0.22.4',
      published_at: '2026-04-27T00:00:00Z',
      html_url: 'https://github.com/garrytan/gbrain/releases/tag/v0.22.4',
    }), { status: 200 }));
    const result = await fetchLatestRelease();
    expect(result).toEqual({
      ok: true,
      tag: 'v0.22.4',
      published_at: '2026-04-27T00:00:00Z',
      url: 'https://github.com/garrytan/gbrain/releases/tag/v0.22.4',
    });
  });

  test('2xx with valid tag_name but missing optional fields → ok with empty defaults', async () => {
    stubFetch(new Response('{"tag_name":"v0.1.0"}', { status: 200 }));
    const result = await fetchLatestRelease();
    expect(result).toEqual({ ok: true, tag: 'v0.1.0', published_at: '', url: '' });
  });

  test('404 still returns no_releases (regression guard)', async () => {
    stubFetch(new Response('not found', { status: 404 }));
    const result = await fetchLatestRelease();
    expect(result).toEqual({ ok: false, error: 'no_releases', transient: false });
  });
});

describe('check-update CLI', () => {
  test('check-update is in CLI_ONLY set', async () => {
    const source = await Bun.file(
      new URL('../src/cli.ts', import.meta.url).pathname
    ).text();
    expect(source).toContain("'check-update'");
  });

  test('--help prints usage and exits 0', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('check-update');
    expect(exitCode).toBe(0);
  });

  test('--json returns valid JSON with required fields', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update', '--json'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const output = JSON.parse(stdout);
    expect(output).toHaveProperty('current_version');
    expect(output).toHaveProperty('update_available');
    expect(output).toHaveProperty('upgrade_command');
    expect(output).toHaveProperty('current_source', 'package-json');
    expect(typeof output.update_available).toBe('boolean');
  });
});
