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

function makeStub(sources: StubSource[], globalDefault: string | null = null) {
  return {
    kind: 'pglite' as const,
    async executeRaw<T>(sql: string, _params?: unknown[]): Promise<T[]> {
      // Two query shapes hit in the resolver:
      //   1. tier 4 (local_path match): SELECT id, local_path FROM sources WHERE local_path IS NOT NULL
      //   2. assertSourceExists: SELECT id FROM sources WHERE id = $1
      //   3. tier 5.5 (sole_non_default): SELECT id FROM sources WHERE local_path IS NOT NULL AND id != 'default' AND archived = false
      if (sql.includes('archived = false')) {
        return sources.filter(s => s.local_path !== null && s.id !== 'default' && s.archived !== true)
          .map(s => ({ id: s.id })) as unknown as T[];
      }
      if (sql.includes('local_path IS NOT NULL AND id != \'default\'')) {
        return sources.filter(s => s.local_path !== null && s.id !== 'default')
          .map(s => ({ id: s.id })) as unknown as T[];
      }
      if (sql.includes('SELECT id, local_path FROM sources WHERE local_path IS NOT NULL')) {
        return sources.filter(s => s.local_path !== null)
          .map(s => ({ id: s.id, local_path: s.local_path })) as unknown as T[];
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
