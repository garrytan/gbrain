/**
 * v0.41.13 (#1434) — sole_non_default tier (5.5) in resolveSourceId /
 * resolveSourceWithTier.
 *
 * When NO brain_default config is set AND exactly one registered source has
 * local_path set and isn't 'default', auto-route to it. Closes the bug
 * class where `gbrain sync` without --source silently routed to source_id
 * 'default' even though the user had a single Vault-mounted source.
 *
 * Tier ordering placement codex review forced:
 *   - AFTER brain_default (explicit user intent wins)
 *   - BEFORE seed_default (auto-route beats the empty terminal)
 *
 * Tests use a stub BrainEngine that only implements the three methods the
 * resolver touches: executeRaw, getConfig, kind. Hermetic — no PGLite.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolveSourceId,
  resolveSourceWithTier,
  SOURCE_TIER_NAMES,
  formatSoleNonDefaultNudge,
} from '../src/core/source-resolver.ts';
import { withEnv } from './helpers/with-env.ts';

type StubSource = { id: string; local_path: string | null; archived?: boolean };

function makeStub(
  sources: StubSource[],
  globalDefault: string | null = null,
  opts?: { defaultActivePages?: number; pagesProbeThrows?: boolean },
) {
  return {
    kind: 'pglite' as const,
    async executeRaw<T>(sql: string, _params?: unknown[]): Promise<T[]> {
      // Query shapes hit in the resolver:
      //   1. tier 4 (local_path match): SELECT id, local_path FROM sources WHERE local_path IS NOT NULL
      //   2. assertSourceExists: SELECT id FROM sources WHERE id = $1
      //   3. tier 5.5 (sole_non_default): SELECT id FROM sources WHERE local_path IS NOT NULL AND id != 'default' AND archived = false
      //   4. tier 5.5 emptiness guard (#3070): SELECT 1 ... FROM pages WHERE source_id = 'default' AND deleted_at IS NULL LIMIT 1
      if (sql.includes('FROM pages')) {
        if (opts?.pagesProbeThrows) throw new Error('relation "pages" probe failed (legacy schema)');
        return (opts?.defaultActivePages ?? 0) > 0 ? ([{ one: 1 }] as unknown as T[]) : [];
      }
      if (sql.includes('archived = false')) {
        return sources.filter(s => s.local_path !== null && s.id !== 'default' && s.archived !== true)
          .map(s => ({ id: s.id })) as unknown as T[];
      }
      if (sql.includes('local_path IS NOT NULL AND id != \'default\'')) {
        return sources.filter(s => s.local_path !== null && s.id !== 'default')
          .map(s => ({ id: s.id })) as unknown as T[];
      }
      if (
        sql.includes('SELECT id, local_path FROM sources WHERE local_path IS NOT NULL') ||
        sql.includes(', archived FROM sources WHERE local_path IS NOT NULL')
      ) {
        return sources.filter(s => s.local_path !== null)
          .map(s => ({ id: s.id, local_path: s.local_path, archived: s.archived === true })) as unknown as T[];
      }
      if (sql.includes('SELECT id FROM sources WHERE id =')) {
        const id = (_params as string[])?.[0];
        return sources.filter(s => s.id === id).map(s => ({ id: s.id })) as unknown as T[];
      }
      return [];
    },
    async getConfig(_key: string): Promise<string | null> {
      return globalDefault;
    },
  } as unknown as Parameters<typeof resolveSourceId>[0];
}

describe('#1434 — sole_non_default tier', () => {
  test('fires when exactly one non-default source is registered (no brain_default)', async () => {
    const engine = makeStub([
      { id: 'default', local_path: null },
      { id: 'studiovault', local_path: '/Users/india/vault' },
    ]);
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    expect(result.source_id).toBe('studiovault');
    expect(result.tier).toBe('sole_non_default');
  });

  test('does NOT fire when 2+ non-default sources exist (ambiguous — user must pick)', async () => {
    const engine = makeStub([
      { id: 'default', local_path: null },
      { id: 'studiovault', local_path: '/Users/india/vault' },
      { id: 'second-vault', local_path: '/Users/india/other-vault' },
    ]);
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    expect(result.source_id).toBe('default');
    expect(result.tier).toBe('seed_default');
  });

  test('does NOT fire when 0 non-default sources exist (fresh install)', async () => {
    const engine = makeStub([{ id: 'default', local_path: null }]);
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    expect(result.source_id).toBe('default');
    expect(result.tier).toBe('seed_default');
  });

  test('does NOT fire when sole non-default has NULL local_path (no on-disk shape)', async () => {
    const engine = makeStub([
      { id: 'default', local_path: null },
      { id: 'remote-only', local_path: null }, // GitHub-only source
    ]);
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    expect(result.source_id).toBe('default');
    expect(result.tier).toBe('seed_default');
  });

  test('does NOT fire when brain_default is set (explicit user intent wins)', async () => {
    const engine = makeStub(
      [
        { id: 'default', local_path: null },
        { id: 'studiovault', local_path: '/Users/india/vault' },
      ],
      'default', // user explicitly set sources.default
    );
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    expect(result.source_id).toBe('default');
    expect(result.tier).toBe('brain_default');
  });

  test('does NOT fire when explicit --source flag is passed (tier 1 wins)', async () => {
    const engine = makeStub([
      { id: 'default', local_path: null },
      { id: 'studiovault', local_path: '/Users/india/vault' },
    ]);
    const result = await resolveSourceWithTier(engine, 'default', '/tmp');
    expect(result.source_id).toBe('default');
    expect(result.tier).toBe('flag');
  });

  test('does NOT fire when GBRAIN_SOURCE env is set (tier 2 wins)', async () => {
    const engine = makeStub([
      { id: 'default', local_path: null },
      { id: 'studiovault', local_path: '/Users/india/vault' },
    ]);
    await withEnv({ GBRAIN_SOURCE: 'default' }, async () => {
      const result = await resolveSourceWithTier(engine, null, '/tmp');
      expect(result.source_id).toBe('default');
      expect(result.tier).toBe('env');
    });
  });

  test('archived non-default source is ignored (does not count toward the 1)', async () => {
    const engine = makeStub([
      { id: 'default', local_path: null },
      { id: 'studiovault', local_path: '/Users/india/vault' },
      { id: 'old-vault', local_path: '/Users/india/archive', archived: true },
    ]);
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    // archived 'old-vault' shouldn't count → still one non-default → fires
    expect(result.source_id).toBe('studiovault');
    expect(result.tier).toBe('sole_non_default');
  });

  test('resolveSourceId mirrors resolveSourceWithTier on the new tier', async () => {
    const engine = makeStub([
      { id: 'default', local_path: null },
      { id: 'studiovault', local_path: '/Users/india/vault' },
    ]);
    const flat = await resolveSourceId(engine, null, '/tmp');
    const tagged = await resolveSourceWithTier(engine, null, '/tmp');
    expect(flat).toBe(tagged.source_id);
  });

  test('detail string explains the routing', async () => {
    const engine = makeStub([
      { id: 'default', local_path: null },
      { id: 'studiovault', local_path: '/Users/india/vault' },
    ]);
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    expect(result.detail).toContain('only non-default');
  });

  // #3070 — the emptiness guard: the tier's charter is rescuing brains whose
  // 'default' holds 0 pages. An ESTABLISHED default corpus must not have its
  // bare writes hijacked into the sole side-source.
  test("#3070: does NOT fire when 'default' holds an established corpus", async () => {
    const engine = makeStub(
      [
        { id: 'default', local_path: null },
        { id: 'studiovault', local_path: '/Users/india/vault' },
      ],
      null,
      { defaultActivePages: 1045 },
    );
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    expect(result.source_id).toBe('default');
    expect(result.tier).toBe('seed_default');
    expect(await resolveSourceId(engine, null, '/tmp')).toBe('default');
  });

  test('#3070: still fires when default is empty (the #1434 charter preserved)', async () => {
    const engine = makeStub(
      [
        { id: 'default', local_path: null },
        { id: 'studiovault', local_path: '/Users/india/vault' },
      ],
      null,
      { defaultActivePages: 0 },
    );
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    expect(result.source_id).toBe('studiovault');
    expect(result.tier).toBe('sole_non_default');
  });

  // The #3070 flip must not be silent: one stray page in 'default' quietly
  // reroutes every bare command away from the sole side-source. A one-line
  // stderr warning names both sides so the misroute is diagnosable.
  test('#3070: the flip prints a one-line stderr warning naming both sources', async () => {
    const engine = makeStub(
      [
        { id: 'default', local_path: null },
        { id: 'studiovault', local_path: '/Users/india/vault' },
      ],
      null,
      { defaultActivePages: 1 },
    );
    const originalError = console.error;
    const errLines: string[] = [];
    console.error = (...args: unknown[]) => { errLines.push(args.join(' ')); };
    try {
      await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: undefined }, async () => {
        const result = await resolveSourceWithTier(engine, null, '/tmp');
        expect(result.source_id).toBe('default');
        expect(result.tier).toBe('seed_default');
      });
    } finally {
      console.error = originalError;
    }
    expect(errLines.length).toBe(1);
    const line = errLines[0];
    expect(line).toContain("'studiovault'");
    expect(line).toContain("'default'");
    expect(line).toContain('non-empty');
  });

  test('#3070: the flip warning is suppressed via GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE=1', async () => {
    const engine = makeStub(
      [
        { id: 'default', local_path: null },
        { id: 'studiovault', local_path: '/Users/india/vault' },
      ],
      null,
      { defaultActivePages: 1 },
    );
    const originalError = console.error;
    const errLines: string[] = [];
    console.error = (...args: unknown[]) => { errLines.push(args.join(' ')); };
    try {
      await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: '1' }, async () => {
        const result = await resolveSourceWithTier(engine, null, '/tmp');
        expect(result.source_id).toBe('default');
      });
    } finally {
      console.error = originalError;
    }
    expect(errLines.length).toBe(0);
  });

  test('#3070: no flip warning when default is empty (tier fires normally)', async () => {
    const engine = makeStub(
      [
        { id: 'default', local_path: null },
        { id: 'studiovault', local_path: '/Users/india/vault' },
      ],
      null,
      { defaultActivePages: 0 },
    );
    const originalError = console.error;
    const errLines: string[] = [];
    console.error = (...args: unknown[]) => { errLines.push(args.join(' ')); };
    try {
      await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: undefined }, async () => {
        const result = await resolveSourceWithTier(engine, null, '/tmp');
        expect(result.source_id).toBe('studiovault');
      });
    } finally {
      console.error = originalError;
    }
    expect(errLines.length).toBe(0);
  });

  test('#3070: pages-probe failure keeps the pre-guard routing (legacy brain)', async () => {
    const engine = makeStub(
      [
        { id: 'default', local_path: null },
        { id: 'studiovault', local_path: '/Users/india/vault' },
      ],
      null,
      { pagesProbeThrows: true },
    );
    const result = await resolveSourceWithTier(engine, null, '/tmp');
    expect(result.source_id).toBe('studiovault');
    expect(result.tier).toBe('sole_non_default');
  });
});

describe('SOURCE_TIER_NAMES includes sole_non_default at index 5', () => {
  test('positioned between brain_default and seed_default', () => {
    const idx = SOURCE_TIER_NAMES.indexOf('sole_non_default');
    expect(idx).toBeGreaterThan(SOURCE_TIER_NAMES.indexOf('brain_default'));
    expect(idx).toBeLessThan(SOURCE_TIER_NAMES.indexOf('seed_default'));
  });
});

describe('formatSoleNonDefaultNudge', () => {
  test('returns canonical nudge string in default env', async () => {
    await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: undefined }, async () => {
      expect(formatSoleNonDefaultNudge('studiovault')).toBe(
        "[gbrain] routing to source 'studiovault' (sole non-default source registered; pass --source to override).",
      );
    });
  });

  test('returns null when GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE=1 suppresses', async () => {
    await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: '1' }, async () => {
      expect(formatSoleNonDefaultNudge('studiovault')).toBeNull();
    });
  });

  test('any value other than literal "1" does NOT suppress', async () => {
    await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: 'true' }, async () => {
      expect(formatSoleNonDefaultNudge('studiovault')).not.toBeNull();
    });
  });
});
