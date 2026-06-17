/**
 * Serial (stubs globalThis.fetch): exercises the self-upgrade cache REFRESH
 * orchestration end-to-end — `refreshUpdateCache()` fetches the latest release
 * and writes the correct marker to the shared cache file that the CLI startup
 * hook reads. Network is stubbed; the cache write + marker logic are real.
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
import { readUpdateCache } from '../src/core/self-upgrade.ts';
import { refreshUpdateCache } from '../src/commands/check-update.ts';

const realFetch = globalThis.fetch;
let homeDir: string;
let priorHome: string | undefined;

function bump(kind: 'minor' | 'patch'): string {
  const v = parseSemver(VERSION)!;
  if (kind === 'minor') return `${v[0]}.${v[1] + 1}.0`;
  return `${v[0]}.${v[1]}.${v[2] + 1}`;
}

function stubReleaseFetch(tag: string | null, ok = true): void {
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes('/releases/latest')) {
      if (tag === null) throw new Error('network down');
      return new Response(JSON.stringify({ tag_name: tag, published_at: '2026-01-01T00:00:00Z', html_url: 'https://x' }), {
        status: ok ? 200 : 500,
      });
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
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('refreshUpdateCache — full refresh orchestration (network stubbed)', () => {
  test('minor-bump release → writes upgrade_available marker', async () => {
    const latest = bump('minor');
    stubReleaseFetch(`v${latest}`);
    await refreshUpdateCache();
    const entry = readUpdateCache();
    expect(entry?.marker).toEqual({ kind: 'upgrade_available', current: VERSION, latest });
  });

  test('patch-only release → writes up_to_date marker (patch ignored)', async () => {
    stubReleaseFetch(`v${bump('patch')}`);
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'up_to_date', current: VERSION });
  });

  test('network failure → writes up_to_date marker (fail-open, TTL prevents hammering)', async () => {
    stubReleaseFetch(null);
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'up_to_date', current: VERSION });
  });

  test('non-OK HTTP → fail-open up_to_date', async () => {
    stubReleaseFetch(`v${bump('minor')}`, false);
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'up_to_date', current: VERSION });
  });

  test('garbage tag → fail-open up_to_date (forged/invalid version never cached as upgrade)', async () => {
    stubReleaseFetch('v$(rm -rf /)');
    await refreshUpdateCache();
    expect(readUpdateCache()?.marker).toEqual({ kind: 'up_to_date', current: VERSION });
  });
});
