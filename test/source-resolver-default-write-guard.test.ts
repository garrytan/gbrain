/**
 * write-time guard for the seed_default tier.
 *
 * `sole_non_default` (tier 5.5) only auto-routes the single-source case. On a
 * brain with 2+ non-default sources, an unscoped mutating op still falls to
 * `seed_default` and silently lands in source_id 'default', re-opening the
 * cross-source duplicate-slug class (#1434 / PR #707).
 *
 * `assessDefaultWriteGuard` measures where the brain's pages actually live and
 * fires only when non-default sources hold the bulk. Hermetic — the stub
 * engine answers the single page-distribution aggregate the guard runs.
 */

import { describe, test, expect } from 'bun:test';
import {
  assessDefaultWriteGuard,
  defaultWriteAllowedByEnv,
  formatDefaultWriteRefusal,
  formatDefaultWriteWarning,
  GBRAIN_ALLOW_DEFAULT_WRITE_ENV,
} from '../src/core/source-resolver.ts';
import { withEnv } from './helpers/with-env.ts';

type Dist = { defaultPages: number; nonDefaultPages: number; nonDefaultSources: number };

/** Stub engine that answers the guard's page-distribution aggregate. */
function makeStub(dist: Dist | 'throw') {
  return {
    kind: 'pglite' as const,
    async executeRaw<T>(sql: string): Promise<T[]> {
      if (dist === 'throw') throw new Error('no pages table');
      if (sql.includes('FROM pages')) {
        return [{
          default_pages: dist.defaultPages,
          non_default_pages: dist.nonDefaultPages,
          non_default_sources: dist.nonDefaultSources,
        }] as unknown as T[];
      }
      return [];
    },
  } as unknown as Parameters<typeof assessDefaultWriteGuard>[0];
}

describe('assessDefaultWriteGuard', () => {
  test('fires when non-default sources hold the bulk (2+ sources, default near-empty)', async () => {
    const a = await assessDefaultWriteGuard(makeStub({ defaultPages: 0, nonDefaultPages: 1467, nonDefaultSources: 2 }));
    expect(a.shouldGuard).toBe(true);
    expect(a.nonDefaultPages).toBe(1467);
    expect(a.nonDefaultSources).toBe(2);
  });

  test('does NOT fire on a fresh brain (no non-default content)', async () => {
    const a = await assessDefaultWriteGuard(makeStub({ defaultPages: 0, nonDefaultPages: 0, nonDefaultSources: 0 }));
    expect(a.shouldGuard).toBe(false);
  });

  test('does NOT fire on a legacy default-dominant brain (default holds the bulk)', async () => {
    // e.g. mid-migration: some content moved to a new source, most still in default
    const a = await assessDefaultWriteGuard(makeStub({ defaultPages: 5000, nonDefaultPages: 40, nonDefaultSources: 1 }));
    expect(a.shouldGuard).toBe(false);
  });

  test('fires when non-default strictly exceeds default', async () => {
    const a = await assessDefaultWriteGuard(makeStub({ defaultPages: 40, nonDefaultPages: 41, nonDefaultSources: 1 }));
    expect(a.shouldGuard).toBe(true);
  });

  test('does NOT fire on an exact tie (default not the minority)', async () => {
    const a = await assessDefaultWriteGuard(makeStub({ defaultPages: 100, nonDefaultPages: 100, nonDefaultSources: 1 }));
    expect(a.shouldGuard).toBe(false);
  });

  test('coerces string/bigint aggregate results (pglite SUM/COUNT shapes)', async () => {
    const engine = {
      kind: 'pglite' as const,
      async executeRaw<T>(): Promise<T[]> {
        return [{ default_pages: '3', non_default_pages: '900', non_default_sources: BigInt(2) }] as unknown as T[];
      },
    } as unknown as Parameters<typeof assessDefaultWriteGuard>[0];
    const a = await assessDefaultWriteGuard(engine);
    expect(a.shouldGuard).toBe(true);
    expect(a.nonDefaultPages).toBe(900);
    expect(a.nonDefaultSources).toBe(2);
  });

  test('fail-open: a query error returns shouldGuard=false (never breaks a write)', async () => {
    const a = await assessDefaultWriteGuard(makeStub('throw'));
    expect(a.shouldGuard).toBe(false);
    expect(a.defaultPages).toBe(0);
  });

  test('fail-open: an empty result set returns shouldGuard=false', async () => {
    const engine = {
      kind: 'pglite' as const,
      async executeRaw<T>(): Promise<T[]> { return [] as T[]; },
    } as unknown as Parameters<typeof assessDefaultWriteGuard>[0];
    const a = await assessDefaultWriteGuard(engine);
    expect(a.shouldGuard).toBe(false);
  });
});

describe('defaultWriteAllowedByEnv', () => {
  test('true only for the literal "1"', async () => {
    await withEnv({ [GBRAIN_ALLOW_DEFAULT_WRITE_ENV]: '1' }, async () => {
      expect(defaultWriteAllowedByEnv()).toBe(true);
    });
  });
  test('false when unset', async () => {
    await withEnv({ [GBRAIN_ALLOW_DEFAULT_WRITE_ENV]: undefined }, async () => {
      expect(defaultWriteAllowedByEnv()).toBe(false);
    });
  });
  test('false for any other value', async () => {
    await withEnv({ [GBRAIN_ALLOW_DEFAULT_WRITE_ENV]: 'true' }, async () => {
      expect(defaultWriteAllowedByEnv()).toBe(false);
    });
  });
});

describe('formatDefaultWriteRefusal', () => {
  const a = { shouldGuard: true, defaultPages: 0, nonDefaultPages: 1467, nonDefaultSources: 2 };

  test('names the command and the counts', () => {
    const msg = formatDefaultWriteRefusal('sync', a);
    expect(msg).toContain("Refusing unscoped sync");
    expect(msg).toContain('2 non-default source(s)');
    expect(msg).toContain('1467 pages');
    expect(msg).toContain('');
  });

  test('defaults the scope flag to --source (sync)', () => {
    const msg = formatDefaultWriteRefusal('sync', a);
    expect(msg).toContain('gbrain sync --source <id>');
    expect(msg).toContain('gbrain sync --source default');
  });

  test('honors a custom scope flag (import uses --source-id)', () => {
    const msg = formatDefaultWriteRefusal('import <dir>', a, '--source-id');
    expect(msg).toContain('gbrain import <dir> --source-id <id>');
    expect(msg).toContain('gbrain import <dir> --source-id default');
    expect(msg).not.toContain('--source <id>');
  });

  test('spells out the env escape hatch', () => {
    const msg = formatDefaultWriteRefusal('sync', a);
    expect(msg).toContain(`${GBRAIN_ALLOW_DEFAULT_WRITE_ENV}=1 gbrain sync`);
  });
});

describe('formatDefaultWriteWarning', () => {
  test('one line, points at GBRAIN_SOURCE, cites the issue', () => {
    const msg = formatDefaultWriteWarning({ shouldGuard: true, defaultPages: 3, nonDefaultPages: 900, nonDefaultSources: 2 });
    expect(msg.split('\n')).toHaveLength(1);
    expect(msg).toContain('GBRAIN_SOURCE=<id>');
    expect(msg).toContain('2 non-default source(s)');
    expect(msg).toContain('');
  });
});
