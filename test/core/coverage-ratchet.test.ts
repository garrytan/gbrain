import { describe, expect, test } from 'bun:test';
import {
  baselineKey,
  evaluateCoverage,
  mergeReports,
  normalizeBaselines,
  normalizeRepoPath,
  parseLcov,
  sanitizeSuiteName,
  selectSuites,
  validateConfig,
  type CoverageRatchetConfig,
} from '../../src/core/coverage-ratchet.ts';

const LCOV = `TN:
SF:src/core/alpha.ts
LF:4
LH:4
end_of_record
TN:
SF:/repo/src/core/beta.ts
LF:10
LH:8
end_of_record
`;

describe('coverage-ratchet core', () => {
  test('normalizes repo-relative and absolute LCOV paths', () => {
    expect(normalizeRepoPath('./src/core/foo.ts')).toBe('src/core/foo.ts');
    expect(normalizeRepoPath('/repo/src/core/foo.ts', '/repo')).toBe('src/core/foo.ts');
  });

  test('parseLcov returns line coverage by source', () => {
    const parsed = parseLcov(LCOV, '/repo');
    expect(parsed.get('src/core/alpha.ts')).toMatchObject({
      linesFound: 4,
      linesHit: 4,
      coveragePct: 100,
    });
    expect(parsed.get('src/core/beta.ts')).toMatchObject({
      linesFound: 10,
      linesHit: 8,
      coveragePct: 80,
    });
  });

  test('evaluateCoverage fails below minimum and raises clean baselines', () => {
    const suite = {
      name: 'suite-a',
      sources: ['src/core/alpha.ts', 'src/core/beta.ts'],
      tests: ['test/alpha.test.ts'],
      minCoverage: 90,
    };
    const report = evaluateCoverage(suite, parseLcov(LCOV, '/repo'), {}, 90);
    expect(report.status).toBe('failed');
    expect(report.blockers).toContain('suite-a: src/core/beta.ts coverage 80% < 90%');
    expect(report.baselines[baselineKey('suite-a', 'src/core/alpha.ts')]).toBe(100);
    expect(report.ratchetUpdates).toContainEqual({
      key: 'suite-a::src/core/alpha.ts',
      previous: null,
      current: 100,
    });
  });

  test('evaluateCoverage catches missing LCOV records', () => {
    const report = evaluateCoverage(
      { name: 'suite-a', sources: ['src/core/missing.ts'], tests: ['test/missing.test.ts'] },
      parseLcov(LCOV, '/repo'),
      {},
      90,
    );
    expect(report.safeToContinue).toBe(false);
    expect(report.blockers[0]).toContain('missing LCOV record');
    expect(report.rows[0].coveragePct).toBe(0);
  });

  test('evaluateCoverage catches ratchet regression even above the minimum', () => {
    const baselines = { 'suite-a::src/core/beta.ts': 85 };
    const report = evaluateCoverage(
      { name: 'suite-a', sources: ['src/core/beta.ts'], tests: ['test/beta.test.ts'], minCoverage: 75 },
      parseLcov(LCOV, '/repo'),
      baselines,
      90,
    );
    expect(report.status).toBe('failed');
    expect(report.blockers).toContain('suite-a: src/core/beta.ts coverage regressed 80% < 85%');
    expect(report.rows[0].ratchetStatus).toBe('regressed');
  });

  test('evaluateCoverage marks equal baselines as ok', () => {
    const report = evaluateCoverage(
      { name: 'suite-a', sources: ['src/core/alpha.ts'], tests: ['test/alpha.test.ts'] },
      parseLcov(LCOV, '/repo'),
      { 'suite-a::src/core/alpha.ts': 100 },
      90,
    );
    expect(report.status).toBe('ok');
    expect(report.rows[0].ratchetStatus).toBe('ok');
    expect(report.ratchetUpdates).toEqual([]);
  });

  test('normalizeBaselines accepts wrapped or raw baseline maps', () => {
    expect(normalizeBaselines({ baselines: { a: '90.123', b: 100, c: 'bad' } })).toEqual({
      a: 90.12,
      b: 100,
    });
    expect(normalizeBaselines({ d: 99 })).toEqual({ d: 99 });
    expect(normalizeBaselines(null)).toEqual({});
  });

  test('selectSuites returns all suites by default and named suites on request', () => {
    const config: CoverageRatchetConfig = {
      suites: [
        { name: 'a', sources: ['a.ts'], tests: ['a.test.ts'] },
        { name: 'b', sources: ['b.ts'], tests: ['b.test.ts'] },
      ],
    };
    expect(selectSuites(config).map((suite) => suite.name)).toEqual(['a', 'b']);
    expect(selectSuites(config, ['b']).map((suite) => suite.name)).toEqual(['b']);
    expect(() => selectSuites(config, ['c'])).toThrow('unknown coverage suite');
  });

  test('validateConfig catches empty, duplicate, and incomplete suites', () => {
    expect(validateConfig({ suites: [] })).toContain('config.suites must contain at least one suite');
    expect(validateConfig({
      suites: [
        { name: 'dup', sources: ['a.ts'], tests: ['a.test.ts'] },
        { name: 'dup', sources: [], tests: [] },
      ],
    })).toEqual([
      'duplicate suite name: dup',
      'dup.sources must contain at least one source',
      'dup.tests must contain at least one test',
    ]);
  });

  test('sanitizeSuiteName produces filesystem-safe stable names', () => {
    expect(sanitizeSuiteName('Large Page / Embed Recovery')).toBe('large-page-embed-recovery');
    expect(sanitizeSuiteName('')).toBe('suite');
  });

  test('mergeReports preserves blockers, rows, updates, and latest baselines', () => {
    const ok = evaluateCoverage(
      { name: 'ok', sources: ['src/core/alpha.ts'], tests: ['test/alpha.test.ts'] },
      parseLcov(LCOV, '/repo'),
      {},
      90,
    );
    const failed = evaluateCoverage(
      { name: 'failed', sources: ['src/core/beta.ts'], tests: ['test/beta.test.ts'] },
      parseLcov(LCOV, '/repo'),
      {},
      90,
    );
    const merged = mergeReports([ok, failed]);
    expect(merged.status).toBe('failed');
    expect(merged.rows.length).toBe(2);
    expect(merged.ratchetUpdates.length).toBe(2);
    expect(Object.keys(merged.baselines)).toContain('ok::src/core/alpha.ts');
    expect(merged.blockers[0]).toContain('failed: src/core/beta.ts coverage 80% < 90%');
  });
});
