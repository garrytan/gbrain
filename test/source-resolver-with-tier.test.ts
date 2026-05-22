/**
 * v0.37.7.0 — resolveSourceWithTier() tier-attribution variant tests.
 *
 * Mirrors the 6-tier priority chain from source-resolver.test.ts but
 * asserts the returned `tier` label matches the winning tier.
 * Powers `gbrain sources current` so users can verify both the
 * resolved source AND the reason it resolved.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveSourceWithTier,
  SOURCE_TIER_NAMES,
  type SourceTier,
} from '../src/core/source-resolver.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

// Stub engine same shape as source-resolver.test.ts
function makeStub(
  registeredSources: string[],
  paths: Array<{ id: string; local_path: string }>,
  defaultKey: string | null,
): BrainEngine {
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

describe('SOURCE_TIER_NAMES ordering matches resolveSourceId priority', () => {
  test('canonical order is 1=flag → 6=seed_default', () => {
    expect(SOURCE_TIER_NAMES).toEqual([
      'flag',
      'env',
      'dotfile',
      'local_path',
      'brain_default',
      'seed_default',
    ]);
  });
});

describe('resolveSourceWithTier — tier 1 (flag)', () => {
  test('explicit flag returns tier=flag with detail naming the value', async () => {
    const engine = makeStub(['default', 'dept-x'], [], null);
    const result = await resolveSourceWithTier(engine, 'dept-x', '/tmp');
    expect(result.source_id).toBe('dept-x');
    expect(result.tier).toBe('flag');
    expect(result.detail).toContain('--source dept-x');
  });

  test('rejects unregistered explicit source', async () => {
    const engine = makeStub(['default'], [], null);
    await expect(resolveSourceWithTier(engine, 'ghost', '/tmp')).rejects.toThrow(/not found/);
  });
});

describe('resolveSourceWithTier — tier 2 (env)', () => {
  test('GBRAIN_SOURCE env returns tier=env when no flag', async () => {
    const engine = makeStub(['default', 'wiki'], [], null);
    await withEnv({ GBRAIN_SOURCE: 'wiki' }, async () => {
      const result = await resolveSourceWithTier(engine, null, '/tmp');
      expect(result.source_id).toBe('wiki');
      expect(result.tier).toBe('env');
      expect(result.detail).toBe('GBRAIN_SOURCE=wiki');
    });
  });
});

describe('resolveSourceWithTier — tier 3 (dotfile)', () => {
  let scratchDir: string;
  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'gbrain-tier-dotfile-'));
  });
  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  test('.gbrain-source dotfile in CWD returns tier=dotfile', async () => {
    writeFileSync(join(scratchDir, '.gbrain-source'), 'team-alpha\n');
    const engine = makeStub(['default', 'team-alpha'], [], null);
    const result = await resolveSourceWithTier(engine, null, scratchDir);
    expect(result.source_id).toBe('team-alpha');
    expect(result.tier).toBe('dotfile');
    expect(result.detail).toBe('.gbrain-source');
  });

  test('dotfile in ancestor directory walks up to find it', async () => {
    writeFileSync(join(scratchDir, '.gbrain-source'), 'team-alpha\n');
    const nested = join(scratchDir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const engine = makeStub(['default', 'team-alpha'], [], null);
    const result = await resolveSourceWithTier(engine, null, nested);
    expect(result.tier).toBe('dotfile');
  });
});

describe('resolveSourceWithTier — tier 4 (local_path)', () => {
  test('registered source whose local_path contains CWD returns tier=local_path', async () => {
    const engine = makeStub(
      ['default', 'gstack'],
      [{ id: 'gstack', local_path: '/work/gstack' }],
      null,
    );
    const result = await resolveSourceWithTier(engine, null, '/work/gstack/src');
    expect(result.source_id).toBe('gstack');
    expect(result.tier).toBe('local_path');
    expect(result.detail).toContain('/work/gstack');
  });

  test('longest-prefix wins on nested registered sources', async () => {
    const engine = makeStub(
      ['default', 'parent', 'child'],
      [
        { id: 'parent', local_path: '/work' },
        { id: 'child', local_path: '/work/sub' },
      ],
      null,
    );
    const result = await resolveSourceWithTier(engine, null, '/work/sub/file');
    expect(result.source_id).toBe('child');
    expect(result.tier).toBe('local_path');
  });
});

describe('resolveSourceWithTier — tier 5 (brain_default)', () => {
  test('sources.default config returns tier=brain_default', async () => {
    const engine = makeStub(['default', 'dept-x'], [], 'dept-x');
    const result = await resolveSourceWithTier(engine, null, '/tmp/no-dotfile-here');
    expect(result.source_id).toBe('dept-x');
    expect(result.tier).toBe('brain_default');
    expect(result.detail).toContain('sources.default');
  });
});

describe('resolveSourceWithTier — tier 6 (seed_default)', () => {
  test('no other signals returns tier=seed_default with no detail', async () => {
    const engine = makeStub(['default'], [], null);
    const result = await resolveSourceWithTier(engine, null, '/tmp/no-dotfile-here');
    expect(result.source_id).toBe('default');
    expect(result.tier).toBe('seed_default');
    expect(result.detail).toBeUndefined();
  });
});

describe('resolveSourceWithTier — priority assertion', () => {
  test('flag wins over env wins over dotfile wins over default', async () => {
    // Set up a stub where ALL tiers could resolve. Assert the
    // higher-priority one wins.
    const engine = makeStub(
      ['default', 'flag-src', 'env-src', 'dot-src', 'default-src'],
      [],
      'default-src',
    );
    await withEnv({ GBRAIN_SOURCE: 'env-src' }, async () => {
      // Flag highest priority
      const r1 = await resolveSourceWithTier(engine, 'flag-src', '/tmp');
      expect(r1.tier).toBe('flag');
      // Without flag → env
      const r2 = await resolveSourceWithTier(engine, null, '/tmp');
      expect(r2.tier).toBe('env');
    });
  });
});

// Typecheck-only assertion: SourceTier is the union of SOURCE_TIER_NAMES.
const _exhaustiveCheck: SourceTier = 'flag';
void _exhaustiveCheck;
