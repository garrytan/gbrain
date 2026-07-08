import { describe, it, expect } from 'bun:test';
import { resolveOrphanExcludeTypes, orphanTypeExcludeClause } from '../src/core/health-config.ts';

describe('resolveOrphanExcludeTypes', () => {
  it('defaults to [] when unset (count everything)', () => {
    expect(resolveOrphanExcludeTypes(undefined)).toEqual([]);
    expect(resolveOrphanExcludeTypes('')).toEqual([]);
  });

  it('parses a comma list, trimming + lowercasing', () => {
    expect(resolveOrphanExcludeTypes('artifact_pointer, Ingest_Log ,extract_receipt'))
      .toEqual(['artifact_pointer', 'ingest_log', 'extract_receipt']);
  });

  it('keeps kebab + underscore type tokens', () => {
    expect(resolveOrphanExcludeTypes('selftest-run,freshness_check'))
      .toEqual(['selftest-run', 'freshness_check']);
  });

  it('drops malformed tokens (injection-safe fail-closed)', () => {
    expect(resolveOrphanExcludeTypes("email'); DROP TABLE pages;--,artifact_pointer"))
      .toEqual(['artifact_pointer']);
    expect(resolveOrphanExcludeTypes('a b, c*d, ok_type')).toEqual(['ok_type']);
  });
});

describe('orphanTypeExcludeClause', () => {
  it('returns "" when nothing configured (no-op)', () => {
    expect(orphanTypeExcludeClause('p', undefined)).toBe('');
    expect(orphanTypeExcludeClause('p', '')).toBe('');
  });

  it('builds a validated NOT IN fragment', () => {
    expect(orphanTypeExcludeClause('p', 'artifact_pointer,ingest_log'))
      .toBe(" AND p.type NOT IN ('artifact_pointer', 'ingest_log')");
  });

  it('honors the page alias', () => {
    expect(orphanTypeExcludeClause('pg', 'selftest-run'))
      .toBe(" AND pg.type NOT IN ('selftest-run')");
  });
});
