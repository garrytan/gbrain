/**
 * Serial (stubs globalThis.fetch): exercises the self-upgrade cache REFRESH
 * orchestration end-to-end — `refreshUpdateCache()` resolves the latest version
 * (from the VERSION file on master, #486 — the repo has zero GitHub releases,
 * so the old `releases/latest` API path could never succeed) and writes the
 * correct marker to the shared cache file that the CLI startup hook reads.
 * Network is stubbed; the cache write + marker logic are real.
 *
 * Quarantined as *.serial.test.ts because it reassigns the process-global
 * `fetch` (cross-file-unsafe under the parallel runner).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/version.ts';
import { parseSemver } from '../src/core/semver.ts';
import { readUpdateCache, writeUpdateCache } from '../src/core/self-upgrade.ts';
import { fetchLatestRelease, parseVersionFileBody, refreshUpdateCache, runCheckUpdate } from '../src/commands/check-update.ts';

const realFetch = globalThis.fetch;
const realLog = console.log;
let homeDir: string;
let priorHome: string | undefined;

function bump(kind: 'minor' | 'patch' | 'micro'): string {
  const v = parseSemver(VERSION)!;
  if (kind === 'minor') return `${v[0]}.${v[1] + 1}.0.0`;
  if (kind === 'patch') return `${v[0]}.${v[1]}.${v[2] + 1}.0`;
  return `${v[0]}.${v[1]}.${v[2]}.${v[3] + 1}`;
}

/** Stub the VERSION-file fetch. body === null → network throw. */
function stubVersionFetch(body: string | null, status = 200): void {
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes('/gbrain/master/VERSION')) {
      if (body === null) throw new Error('network down');
      return new Response(body, { status });
    }
    // Changelog fetch (only happens when update available) — return empty.
    return new Response('', { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  priorHome = process.env.GBRAIN_HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-'));
  process.env.GBRAIN_HOME = homeDir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('fetchLatestRelease — resolves from the VERSION file, discriminates failures', () => {
  test('bare version body → ok with that tag', async () => {
    stubVersionFetch('0.99.1.0\n');
    expect(await fetchLatestRelease()).toMatchObject({ ok: true, tag: '0.99.1.0' });
  });

  test('network throw → network_error (NOT no_releases — offline users are not told "no releases exist")', async () => {
    stubVersionFetch(null);
    expect(await fetchLatestRelease()).toEqual({ ok: false, reason: 'network_error' });
  });

  test('HTTP 404 → no_releases', async () => {
    stubVersionFetch('Not Found', 404);
    expect(await fetchLatestRelease()).toEqual({ ok: false, reason: 'no_releases' });
  });

  test('garbage body → no_releases', async () => {
    stubVersionFetch('<html>rate limited</html>');
    expect(await fetchLatestRelease()).toEqual({ ok: false, reason: 'no_releases' });
  });
});

describe('parseVersionFileBody — shape gate over the raw fetch body', () => {
  test('trailing newline, v prefix, 3-segment legacy, suffix channel', () => {
    expect(parseVersionFileBody('0.42.67.0\n')).toBe('0.42.67.0');
    expect(parseVersionFileBody('v0.42.67.0')).toBe('0.42.67.0');
    expect(parseVersionFileBody('0.31.3\n')).toBe('0.31.3'); // legacy 3-segment
    expect(parseVersionFileBody('0.31.1.1-fixwave\n')).toBe('0.31.1.1'); // suffix compares as base
  });

  test('malformed / huge / injected bodies → null', () => {
    expect(parseVersionFileBody('')).toBeNull();
    expect(parseVersionFileBody('not a version')).toBeNull();
    expect(parseVersionFileBody('$(rm -rf /)')).toBeNull();
    expect(parseVersionFileBody('1.2')).toBeNull(); // 2-segment: not a gbrain version
    expect(parseVersionFileBody('9'.repeat(10_000_000))).toBeNull(); // bounded, no blowup
  });
});

describe('refreshUpdateCache — full refresh orchestration (network stubbed)', () => {
  test('minor-bump VERSION on master → writes upgrade_available marker', async () => {
    const latest = bump('minor');
    stubVersionFetch(`${latest}\n`);
    await refreshUpdateCache();
    const entry = readUpdateCache();
    expect(entry?.marker).toEqual({ kind: 'upgrade_available', current: VERSION, latest });
  });

  test('patch bump → writes upgrade_available marker', async () => {
    const latest = bump('patch');
    stubVersionFetch(`${latest}\n`);
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'upgrade_available', current: VERSION, latest });
  });

  test('micro bump → writes upgrade_available marker', async () => {
    const latest = bump('micro');
    stubVersionFetch(`${latest}\n`);
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'upgrade_available', current: VERSION, latest });
  });

  test('minor bump published as legacy 3-segment → still detected', async () => {
    const v = parseSemver(VERSION)!;
    const latest = `${v[0]}.${v[1] + 1}.0`; // 3-segment, no micro
    stubVersionFetch(`${latest}\n`);
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'upgrade_available', current: VERSION, latest });
  });

  test('suffix channel release (X.Y.Z.W-fixwave) → compares as numeric base', async () => {
    const latest = bump('micro');
    stubVersionFetch(`${latest}-fixwave\n`);
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'upgrade_available', current: VERSION, latest });
  });

  test('same version on master → up_to_date marker', async () => {
    stubVersionFetch(`${VERSION}\n`);
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'up_to_date', current: VERSION });
  });

  // The #486 bug class: a failed check must never fabricate "you're current".
  test('network failure with NO prior cache → writes NOTHING (never a fabricated up_to_date)', async () => {
    stubVersionFetch(null);
    await refreshUpdateCache();
    expect(readUpdateCache()).toBeNull();
  });

  test('network failure with prior upgrade_available → pending notice PRESERVED, not erased', async () => {
    const latest = bump('minor');
    writeUpdateCache({ kind: 'upgrade_available', current: VERSION, latest });
    stubVersionFetch(null);
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'upgrade_available', current: VERSION, latest });
  });

  test('non-OK HTTP → no fabricated up_to_date', async () => {
    stubVersionFetch('nope', 500);
    await refreshUpdateCache();
    expect(readUpdateCache()).toBeNull();
  });

  test('garbage body → no fabricated marker (forged/invalid version never cached as upgrade)', async () => {
    stubVersionFetch('$(rm -rf /)');
    await refreshUpdateCache();
    expect(readUpdateCache()).toBeNull();
  });
});

describe('runCheckUpdate --json — failure discrimination (#486)', () => {
  function capture(): string[] {
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    return lines;
  }

  test('offline → error: network_error (not "no releases exist")', async () => {
    stubVersionFetch(null);
    const lines = capture();
    await runCheckUpdate(['--json']);
    const out = JSON.parse(lines.join('\n'));
    expect(out.error).toBe('network_error');
    expect(out.update_available).toBe(false);
    expect(readUpdateCache()).toBeNull(); // and no fabricated up_to_date cache
  });

  test('endpoint answers but no usable version → error: no_releases', async () => {
    stubVersionFetch('garbage');
    const lines = capture();
    await runCheckUpdate(['--json']);
    expect(JSON.parse(lines.join('\n')).error).toBe('no_releases');
  });

  test('newer VERSION on master → update_available true with latest_version set', async () => {
    const latest = bump('minor');
    stubVersionFetch(`${latest}\n`);
    const lines = capture();
    await runCheckUpdate(['--json']);
    const out = JSON.parse(lines.join('\n'));
    expect(out.update_available).toBe(true);
    expect(out.latest_version).toBe(latest);
    expect(readUpdateCache()?.marker).toEqual({ kind: 'upgrade_available', current: VERSION, latest });
  });
});
