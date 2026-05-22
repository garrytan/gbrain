import { describe, test, expect } from 'bun:test';
import {
  buildSourceFactorCase,
  buildHardExcludeClause,
  buildVisibilityClause,
  __test__,
} from '../src/core/search/sql-ranking.ts';
import {
  DEFAULT_SOURCE_BOOSTS,
  DEFAULT_HARD_EXCLUDES,
  parseSourceBoostEnv,
  parseHardExcludesEnv,
  resolveBoostMap,
  resolveHardExcludes,
} from '../src/core/search/source-boost.ts';

const { escapeLikePattern, escapeSqlLiteral, buildLikePrefixLiteral } = __test__;

describe('escapeLikePattern', () => {
  test('escapes %', () => {
    expect(escapeLikePattern('foo%bar')).toBe('foo\\%bar');
  });

  test('escapes _', () => {
    expect(escapeLikePattern('foo_bar')).toBe('foo\\_bar');
  });

  test('escapes \\ (Postgres LIKE default escape char)', () => {
    expect(escapeLikePattern('foo\\bar')).toBe('foo\\\\bar');
  });

  test('escapes all three together', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  test('leaves plain strings untouched', () => {
    expect(escapeLikePattern('originals/talks/')).toBe('originals/talks/');
  });
});

describe('escapeSqlLiteral', () => {
  test('doubles single quotes', () => {
    expect(escapeSqlLiteral("O'Brien")).toBe("O''Brien");
  });

  test('handles SQL injection attempts as literal data', () => {
    // Classic injection pattern is rendered harmless because the doubled
    // quote keeps it inside a string literal in the emitted SQL.
    expect(escapeSqlLiteral("'; DROP TABLE pages; --")).toBe("''; DROP TABLE pages; --");
  });
});

describe('buildLikePrefixLiteral', () => {
  test('produces a quoted LIKE pattern with trailing %', () => {
    expect(buildLikePrefixLiteral('originals/')).toBe("'originals/%'");
  });

  test('escapes meta-chars before adding the trailing %', () => {
    // Input contains a literal % that should be escaped, and the trailing
    // % we add is the LIKE wildcard.
    expect(buildLikePrefixLiteral('weird%path/')).toBe("'weird\\%path/%'");
  });

  test('escapes single-quote in prefix as SQL literal', () => {
    expect(buildLikePrefixLiteral("o'brien/")).toBe("'o''brien/%'");
  });
});

describe('buildSourceFactorCase', () => {
  test('returns plain 1.0 when detail is "high" (temporal bypass)', () => {
    const result = buildSourceFactorCase('p.slug', { 'originals/': 1.5 }, 'high');
    expect(result).toBe('1.0');
  });

  test('temporal bypass tolerates uppercase / whitespace from MCP boundary', () => {
    // Agents passing JSON over MCP can send "HIGH" or "high " (trailing
    // space). The bypass must catch these — otherwise loose-string callers
    // silently get boosted ranking instead of temporal bypass.
    const map = { 'originals/': 1.5 };
    expect(buildSourceFactorCase('p.slug', map, 'HIGH' as 'high')).toBe('1.0');
    expect(buildSourceFactorCase('p.slug', map, 'high ' as 'high')).toBe('1.0');
    expect(buildSourceFactorCase('p.slug', map, '  High  ' as 'high')).toBe('1.0');
  });

  test('returns plain 1.0 when boost map is empty', () => {
    expect(buildSourceFactorCase('p.slug', {}, 'medium')).toBe('1.0');
  });

  test('emits a CASE expression for non-high detail', () => {
    const result = buildSourceFactorCase('p.slug', { 'originals/': 1.5 }, 'medium');
    expect(result).toBe("(CASE WHEN p.slug LIKE 'originals/%' THEN 1.5 ELSE 1.0 END)");
  });

  test('sorts prefixes by length descending so longest-match wins', () => {
    const result = buildSourceFactorCase(
      'p.slug',
      { 'media/': 0.9, 'media/articles/': 1.1, 'media/x/': 0.7 },
      'medium',
    );
    // Longest first: media/articles/ (15), media/x/ (8), media/ (6)
    const m = result.match(/LIKE '([^']+)%'/g);
    expect(m).toEqual([
      "LIKE 'media/articles/%'",
      "LIKE 'media/x/%'",
      "LIKE 'media/%'",
    ]);
  });

  test('detail=low and detail=undefined both emit the boost CASE', () => {
    const map = { 'originals/': 1.5 };
    expect(buildSourceFactorCase('p.slug', map, 'low')).toContain('CASE WHEN');
    expect(buildSourceFactorCase('p.slug', map, undefined)).toContain('CASE WHEN');
  });

  test('rejects non-finite or negative factors', () => {
    const result = buildSourceFactorCase(
      'p.slug',
      { 'good/': 1.5, 'nan/': NaN, 'neg/': -1, 'inf/': Infinity },
      'medium',
    );
    expect(result).toBe("(CASE WHEN p.slug LIKE 'good/%' THEN 1.5 ELSE 1.0 END)");
  });

  test('uses the supplied slug column reference', () => {
    expect(buildSourceFactorCase('slug', { 'originals/': 1.5 }, 'medium'))
      .toContain('WHEN slug LIKE');
  });
});

describe('buildHardExcludeClause', () => {
  test('returns empty string when prefixes is empty', () => {
    expect(buildHardExcludeClause('p.slug', [])).toBe('');
  });

  test('emits NOT (col LIKE ... OR col LIKE ...)', () => {
    const result = buildHardExcludeClause('p.slug', ['test/', 'archive/']);
    expect(result).toBe(`AND NOT (p.slug LIKE 'test/%' OR p.slug LIKE 'archive/%')`);
  });

  test('escapes %, _, and \\ as LIKE meta-characters', () => {
    // CEO pass 4 + codex finding: backslash is Postgres LIKE's default escape char.
    // A literal backslash in a user-supplied prefix must be escaped to \\ so
    // it's treated as data, not as "escape the next char".
    const result = buildHardExcludeClause('p.slug', ['weird\\path/']);
    expect(result).toBe(`AND NOT (p.slug LIKE 'weird\\\\path/%')`);
  });

  test('treats SQL-injection-style input as literal', () => {
    const result = buildHardExcludeClause('p.slug', ["'; DROP TABLE pages; --"]);
    // Single quotes get doubled — the injection becomes inert text inside
    // the string literal.
    expect(result).toContain("''; DROP TABLE pages; --");
    // Sanity: the structure of the clause is intact.
    expect(result).toMatch(/^AND NOT \(p\.slug LIKE '.*%'\)$/);
  });

  test('skips empty-string prefixes', () => {
    const result = buildHardExcludeClause('p.slug', ['test/', '', 'archive/']);
    // Two LIKE clauses, one OR.
    expect((result.match(/LIKE/g) || []).length).toBe(2);
  });
});

describe('parseSourceBoostEnv', () => {
  test('parses comma-separated prefix:factor pairs', () => {
    expect(parseSourceBoostEnv('originals/:1.8,openclaw/chat/:0.3'))
      .toEqual({ 'originals/': 1.8, 'openclaw/chat/': 0.3 });
  });

  test('returns empty object for undefined or empty', () => {
    expect(parseSourceBoostEnv(undefined)).toEqual({});
    expect(parseSourceBoostEnv('')).toEqual({});
  });

  test('skips malformed entries', () => {
    expect(parseSourceBoostEnv('bogus,no-colon,originals/:abc,valid/:1.5'))
      .toEqual({ 'valid/': 1.5 });
  });

  test('rejects negative factors', () => {
    expect(parseSourceBoostEnv('foo/:-1.0,bar/:0.5')).toEqual({ 'bar/': 0.5 });
  });

  test('accepts factor=0 (legal but performance-inferior to hard-exclude)', () => {
    expect(parseSourceBoostEnv('foo/:0')).toEqual({ 'foo/': 0 });
  });

  test('uses last colon to separate prefix from factor', () => {
    // Edge case: someone puts a colon inside the prefix. Last colon wins.
    expect(parseSourceBoostEnv('foo:bar/:1.5')).toEqual({ 'foo:bar/': 1.5 });
  });
});

describe('parseHardExcludesEnv', () => {
  test('parses comma-separated prefixes', () => {
    expect(parseHardExcludesEnv('test/,scratch/,private/'))
      .toEqual(['test/', 'scratch/', 'private/']);
  });

  test('returns empty array for undefined', () => {
    expect(parseHardExcludesEnv(undefined)).toEqual([]);
  });

  test('trims whitespace and drops empty entries', () => {
    expect(parseHardExcludesEnv(' test/ , , scratch/ ')).toEqual(['test/', 'scratch/']);
  });
});

describe('resolveBoostMap', () => {
  test('returns defaults when env is unset', () => {
    expect(resolveBoostMap(undefined)).toEqual(DEFAULT_SOURCE_BOOSTS);
  });

  test('env override takes precedence over defaults', () => {
    const merged = resolveBoostMap('originals/:99');
    expect(merged['originals/']).toBe(99);
    // Other defaults still present.
    expect(merged['concepts/']).toBe(DEFAULT_SOURCE_BOOSTS['concepts/']);
  });

  test('env-only entries are added on top of defaults', () => {
    const merged = resolveBoostMap('newprefix/:2.5');
    expect(merged['newprefix/']).toBe(2.5);
    expect(merged['originals/']).toBe(DEFAULT_SOURCE_BOOSTS['originals/']);
  });
});

describe('resolveHardExcludes', () => {
  test('returns defaults when nothing is overridden', () => {
    const r = resolveHardExcludes(undefined, undefined, undefined);
    for (const p of DEFAULT_HARD_EXCLUDES) expect(r).toContain(p);
  });

  test('caller exclude_slug_prefixes adds to the union', () => {
    const r = resolveHardExcludes(['scratch/'], undefined, undefined);
    expect(r).toContain('scratch/');
    expect(r).toContain('test/'); // default still present
  });

  test('include_slug_prefixes opts back in', () => {
    const r = resolveHardExcludes(undefined, ['test/'], undefined);
    expect(r).not.toContain('test/');
    // Other defaults still present.
    expect(r).toContain('archive/');
  });

  test('env GBRAIN_SEARCH_EXCLUDE adds to the union', () => {
    const r = resolveHardExcludes(undefined, undefined, 'envdir/');
    expect(r).toContain('envdir/');
  });

  test('include subtracts from env-supplied excludes too', () => {
    const r = resolveHardExcludes(undefined, ['envdir/'], 'envdir/');
    expect(r).not.toContain('envdir/');
  });
});

// v0.26.5 — visibility clause for soft-deleted pages and archived sources.
describe('buildVisibilityClause (v0.26.5)', () => {
  test('emits both predicates joined by AND with a leading AND', () => {
    const clause = buildVisibilityClause('p', 's');
    // Leading AND so callers can splice unconditionally.
    expect(clause.startsWith('AND ')).toBe(true);
    // Both predicates present: page-level deleted_at IS NULL + source-level NOT archived.
    expect(clause).toContain('p.deleted_at IS NULL');
    expect(clause).toContain('NOT s.archived');
  });

  test('uses the supplied aliases verbatim', () => {
    expect(buildVisibilityClause('pp', 'src')).toBe('AND pp.deleted_at IS NULL AND NOT src.archived');
  });

  test('does NOT bypass on detail level — visibility is a contract, not a temporal preference', () => {
    // Distinct from buildSourceFactorCase: there's no detail-gated short-circuit.
    // Soft-deleted content stays hidden regardless of caller's detail level.
    // Function signature has no detail param at all; this test pins that contract.
    expect(buildVisibilityClause.length).toBe(2);
  });

  test('emits a stable string regardless of call order (idempotent for snapshot tests)', () => {
    const a = buildVisibilityClause('p', 's');
    const b = buildVisibilityClause('p', 's');
    expect(a).toBe(b);
  });

  test('produces no JSONB containment in the output (column-based, not @>)', () => {
    // Issue 5 contract: archived was promoted from JSONB key to real column.
    // The visibility clause must not regress to JSONB containment.
    const clause = buildVisibilityClause('p', 's');
    expect(clause).not.toContain('@>');
    expect(clause).not.toContain('config');
  });
});
