/**
 * v0.18.0 Step 6 — source resolution priority tests.
 *
 * Priority order (highest first):
 *   1. Explicit --source flag
 *   2. GBRAIN_SOURCE env var
 *   3. .gbrain-source dotfile walk-up
 *   4. Registered source whose local_path contains CWD (longest prefix wins)
 *   5. Brain-level `sources.default` config key
 *   6. Fallback: literal 'default'
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSourceId, __testing } from '../src/core/source-resolver.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// ── Stub engine ────────────────────────────────────────────

function makeStub(registeredSources: string[], paths: Array<{ id: string; local_path: string }>, defaultKey: string | null): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const target = params?.[0];
        return (registeredSources.includes(target as string)
          ? [{ id: target } as unknown as T]
          : []);
      }
      if (sql.includes('SELECT id, local_path FROM sources')) {
        return paths as unknown as T[];
      }
      return [];
    },
    getConfig: async (key: string) => (key === 'sources.default' ? defaultKey : null),
  } as unknown as BrainEngine;
}

// ── Priority 1: explicit flag ──────────────────────────────

describe('resolveSourceId priority 1 — explicit flag', () => {
  test('wins over every other signal', async () => {
    const engine = makeStub(['default', 'gstack', 'wiki'], [{ id: 'wiki', local_path: '/tmp' }], 'gstack');
    process.env.GBRAIN_SOURCE = 'wiki';
    try {
      const id = await resolveSourceId(engine, 'gstack', '/tmp/whatever');
      expect(id).toBe('gstack');
    } finally {
      delete process.env.GBRAIN_SOURCE;
    }
  });

  test('rejects unregistered explicit source with actionable error', async () => {
    const engine = makeStub(['default'], [], null);
    await expect(resolveSourceId(engine, 'ghost')).rejects.toThrow(/not found/);
  });

  test('rejects invalid format', async () => {
    const engine = makeStub(['default'], [], null);
    await expect(resolveSourceId(engine, 'WRONG-case!')).rejects.toThrow(/Invalid --source/);
  });
});

// ── Priority 2: env var ────────────────────────────────────

describe('resolveSourceId priority 2 — GBRAIN_SOURCE env', () => {
  test('wins over dotfile / registered-path / default', async () => {
    const engine = makeStub(['default', 'env-wins'], [{ id: 'other', local_path: '/tmp' }], 'default');
    process.env.GBRAIN_SOURCE = 'env-wins';
    try {
      const id = await resolveSourceId(engine, null, '/tmp/x');
      expect(id).toBe('env-wins');
    } finally {
      delete process.env.GBRAIN_SOURCE;
    }
  });
});

// ── Priority 3: dotfile walk-up ────────────────────────────

describe('resolveSourceId priority 3 — .gbrain-source dotfile walk-up', () => {
  let tmpdirPath: string;

  beforeEach(() => {
    tmpdirPath = mkdtempSync(join(tmpdir(), 'gbrain-resolver-test-'));
  });
  afterEach(() => {
    rmSync(tmpdirPath, { recursive: true, force: true });
  });

  test('finds dotfile in CWD', async () => {
    writeFileSync(join(tmpdirPath, '.gbrain-source'), 'gstack\n');
    const engine = makeStub(['default', 'gstack'], [], null);
    const id = await resolveSourceId(engine, null, tmpdirPath);
    expect(id).toBe('gstack');
  });

  test('walks up ancestors to find dotfile', async () => {
    writeFileSync(join(tmpdirPath, '.gbrain-source'), 'wiki\n');
    const deep = join(tmpdirPath, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    const engine = makeStub(['default', 'wiki'], [], null);
    const id = await resolveSourceId(engine, null, deep);
    expect(id).toBe('wiki');
  });

  test('ignores dotfile with invalid content', async () => {
    writeFileSync(join(tmpdirPath, '.gbrain-source'), 'INVALID!\n');
    const engine = makeStub(['default'], [], null);
    const id = await resolveSourceId(engine, null, tmpdirPath);
    expect(id).toBe('default');
  });
});

// ── Priority 4: registered local_path match (longest prefix) ──

describe('resolveSourceId priority 4 — registered local_path longest-prefix match', () => {
  test('picks registered source whose local_path contains CWD', async () => {
    const engine = makeStub(
      ['default', 'gstack'],
      [{ id: 'gstack', local_path: '/tmp/gstack' }],
      null,
    );
    const id = await resolveSourceId(engine, null, '/tmp/gstack/plans/foo');
    expect(id).toBe('gstack');
  });

  test('longest prefix wins when paths are nested (per Codex second pass)', async () => {
    // Codex flagged: overlapping paths need longest-prefix resolution.
    // If gstack at /tmp/gstack and plans at /tmp/gstack/plans both
    // exist, CWD inside plans/ must pick plans.
    const engine = makeStub(
      ['default', 'gstack', 'plans'],
      [
        { id: 'gstack', local_path: '/tmp/gstack' },
        { id: 'plans', local_path: '/tmp/gstack/plans' },
      ],
      null,
    );
    const id = await resolveSourceId(engine, null, '/tmp/gstack/plans/deeper');
    expect(id).toBe('plans');
  });

  test("CWD outside any registered path falls through to default", async () => {
    const engine = makeStub(
      ['default', 'gstack'],
      [{ id: 'gstack', local_path: '/tmp/gstack' }],
      null,
    );
    const id = await resolveSourceId(engine, null, '/some/other/dir');
    expect(id).toBe('default');
  });
});

// ── Priority 5: brain-level default ────────────────────────

describe('resolveSourceId priority 5 — sources.default config key', () => {
  test("returns configured default when no higher signal present", async () => {
    const engine = makeStub(['default', 'custom'], [], 'custom');
    const id = await resolveSourceId(engine, null, '/some/random/dir');
    expect(id).toBe('custom');
  });
});

// ── Priority 6: fallback ────────────────────────────────────

describe('resolveSourceId priority 6 — fallback', () => {
  test("returns 'default' when no signal at all", async () => {
    const engine = makeStub(['default'], [], null);
    const id = await resolveSourceId(engine, null, '/random/dir');
    expect(id).toBe('default');
  });
});

// ── Regex validation ───────────────────────────────────────

describe('SOURCE_ID_RE', () => {
  test('accepts valid ids', () => {
    for (const id of ['default', 'wiki', 'gstack', 'yc-media', 'garrys-list', 'a', '123']) {
      expect(__testing.SOURCE_ID_RE.test(id)).toBe(true);
    }
  });
  test('rejects invalid ids', () => {
    for (const id of ['', 'a'.repeat(33), 'Upper', 'has_underscore', 'trailing-', '-leading', 'with spaces', 'with.dots']) {
      expect(__testing.SOURCE_ID_RE.test(id)).toBe(false);
    }
  });
});

// ── Dotfile trust check ────────────────────────────────────
//
// The dotfile walk-up reads `.gbrain-source` from any ancestor of the
// CWD. Without an ownership check, an attacker who can write into a
// shared ancestor (e.g. `/tmp/poc/`) can hijack the resolved source
// for any user whose CWD lives below it. The check rejects three
// classes of untrusted dotfiles: symlinks, files owned by another
// user, and world-writable files.

describe('dotfile trust check (owner / symlink / world-writable)', () => {
  let tmpdirPath: string;

  beforeEach(() => {
    tmpdirPath = mkdtempSync(join(tmpdir(), 'gbrain-resolver-trust-'));
  });
  afterEach(() => {
    rmSync(tmpdirPath, { recursive: true, force: true });
  });

  test('accepts a normal user-owned, non-symlink, non-world-writable dotfile', async () => {
    writeFileSync(join(tmpdirPath, '.gbrain-source'), 'wiki\n', { mode: 0o644 });
    const engine = makeStub(['default', 'wiki'], [], null);
    const id = await resolveSourceId(engine, null, tmpdirPath);
    expect(id).toBe('wiki');
  });

  test('rejects a symlinked dotfile', async () => {
    if (typeof process.getuid !== 'function') return; // POSIX only
    const real = join(tmpdirPath, '.gbrain-real');
    writeFileSync(real, 'hijacked\n');
    const link = join(tmpdirPath, '.gbrain-source');
    // Use require() to access symlinkSync without restructuring imports.
    const { symlinkSync } = await import('fs');
    symlinkSync(real, link);
    const engine = makeStub(['default', 'hijacked'], [], null);
    const id = await resolveSourceId(engine, null, tmpdirPath);
    // Symlink rejected → walk continues → reaches FS root → returns 'default'.
    expect(id).toBe('default');
  });

  test('rejects a world-writable dotfile', async () => {
    if (typeof process.getuid !== 'function') return;
    const path = join(tmpdirPath, '.gbrain-source');
    writeFileSync(path, 'hijacked\n');
    // umask masks the 0o002 bit on writeFileSync's mode arg, so set it
    // explicitly after creation.
    const { chmodSync } = await import('fs');
    chmodSync(path, 0o666);
    const engine = makeStub(['default', 'hijacked'], [], null);
    const id = await resolveSourceId(engine, null, tmpdirPath);
    expect(id).toBe('default');
  });

  test('isTrustedDotfile rejects symlink stats', () => {
    const fakeSymlink = {
      isSymbolicLink: () => true,
      uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      mode: 0o644,
    } as ReturnType<typeof __testing.isTrustedDotfile> extends boolean
      ? Parameters<typeof __testing.isTrustedDotfile>[0]
      : never;
    expect(__testing.isTrustedDotfile(fakeSymlink as Parameters<typeof __testing.isTrustedDotfile>[0])).toBe(false);
  });

  test('isTrustedDotfile rejects foreign-owned files', () => {
    if (typeof process.getuid !== 'function') return;
    const myUid = process.getuid();
    const foreign = {
      isSymbolicLink: () => false,
      uid: myUid + 1, // some other uid that is not us and not 0
      mode: 0o644,
    } as Parameters<typeof __testing.isTrustedDotfile>[0];
    expect(__testing.isTrustedDotfile(foreign)).toBe(false);
  });

  test('isTrustedDotfile rejects world-writable files (mode bit 0o002)', () => {
    if (typeof process.getuid !== 'function') return;
    const ww = {
      isSymbolicLink: () => false,
      uid: process.getuid()!,
      mode: 0o666,
    } as Parameters<typeof __testing.isTrustedDotfile>[0];
    expect(__testing.isTrustedDotfile(ww)).toBe(false);
  });

  test('isTrustedDotfile accepts owner-only file (mode 0o600)', () => {
    if (typeof process.getuid !== 'function') return;
    const ok = {
      isSymbolicLink: () => false,
      uid: process.getuid()!,
      mode: 0o600,
    } as Parameters<typeof __testing.isTrustedDotfile>[0];
    expect(__testing.isTrustedDotfile(ok)).toBe(true);
  });
});
