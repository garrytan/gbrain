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
