import { isAbsolute, relative, sep } from 'node:path';

export interface CoverageRatchetSuite {
  name: string;
  sources: string[];
  tests: string[];
  minCoverage?: number;
}

export interface CoverageRatchetConfig {
  schema?: string;
  minCoverage?: number;
  baselineFile?: string;
  coverageDir?: string;
  suites: CoverageRatchetSuite[];
}

export interface CoverageBaselineFile {
  schema?: string;
  baselines: Record<string, number>;
}

export interface LcovSourceCoverage {
  source: string;
  linesFound: number;
  linesHit: number;
  coveragePct: number;
}

export interface CoverageGateRow {
  suite: string;
  source: string;
  linesFound: number;
  linesHit: number;
  coveragePct: number;
  minCoveragePct: number;
  ratchetBaselinePct: number | null;
  ratchetStatus: 'new' | 'ok' | 'raised' | 'regressed';
}

export interface CoverageGateReport {
  status: 'ok' | 'failed';
  safeToContinue: boolean;
  rows: CoverageGateRow[];
  blockers: string[];
  ratchetUpdates: Array<{ key: string; previous: number | null; current: number }>;
  baselines: Record<string, number>;
}

export function normalizeRepoPath(path: string, cwd: string = process.cwd()): string {
  const withoutFileUrl = path.startsWith('file://') ? path.slice('file://'.length) : path;
  const relPath = isAbsolute(withoutFileUrl) ? relative(cwd, withoutFileUrl) : withoutFileUrl;
  return relPath.split(sep).join('/').replace(/^\.\//, '');
}

export function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseLcov(content: string, cwd: string = process.cwd()): Map<string, LcovSourceCoverage> {
  const out = new Map<string, LcovSourceCoverage>();
  let currentSource: string | null = null;
  let linesFound = 0;
  let linesHit = 0;

  function finishRecord() {
    if (!currentSource) return;
    const coveragePct = linesFound === 0 ? 100 : roundPct((linesHit / linesFound) * 100);
    const existing = out.get(currentSource);
    if (existing) {
      const mergedFound = existing.linesFound + linesFound;
      const mergedHit = existing.linesHit + linesHit;
      out.set(currentSource, {
        source: currentSource,
        linesFound: mergedFound,
        linesHit: mergedHit,
        coveragePct: mergedFound === 0 ? 100 : roundPct((mergedHit / mergedFound) * 100),
      });
    } else {
      out.set(currentSource, { source: currentSource, linesFound, linesHit, coveragePct });
    }
    currentSource = null;
    linesFound = 0;
    linesHit = 0;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('SF:')) {
      finishRecord();
      currentSource = normalizeRepoPath(line.slice(3), cwd);
      continue;
    }
    if (line.startsWith('LF:')) {
      linesFound = Number.parseInt(line.slice(3), 10) || 0;
      continue;
    }
    if (line.startsWith('LH:')) {
      linesHit = Number.parseInt(line.slice(3), 10) || 0;
      continue;
    }
    if (line === 'end_of_record') {
      finishRecord();
    }
  }
  finishRecord();
  return out;
}

export function baselineKey(suite: string, source: string): string {
  return `${suite}::${normalizeRepoPath(source)}`;
}

export function sanitizeSuiteName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'suite';
}

export function normalizeBaselines(input: unknown): Record<string, number> {
  const raw = typeof input === 'object' && input !== null && 'baselines' in input
    ? (input as { baselines?: unknown }).baselines
    : input;
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
    if (Number.isFinite(n)) out[key] = roundPct(n);
  }
  return out;
}

export function validateConfig(config: CoverageRatchetConfig): string[] {
  const errors: string[] = [];
  if (!Array.isArray(config.suites) || config.suites.length === 0) {
    errors.push('config.suites must contain at least one suite');
    return errors;
  }
  const names = new Set<string>();
  for (const suite of config.suites) {
    if (!suite.name || typeof suite.name !== 'string') errors.push('suite.name is required');
    if (suite.name && names.has(suite.name)) errors.push(`duplicate suite name: ${suite.name}`);
    if (suite.name) names.add(suite.name);
    if (!Array.isArray(suite.sources) || suite.sources.length === 0) {
      errors.push(`${suite.name || '<unnamed>'}.sources must contain at least one source`);
    }
    if (!Array.isArray(suite.tests) || suite.tests.length === 0) {
      errors.push(`${suite.name || '<unnamed>'}.tests must contain at least one test`);
    }
  }
  return errors;
}

export function selectSuites(config: CoverageRatchetConfig, wanted: string[] = []): CoverageRatchetSuite[] {
  if (wanted.length === 0) return config.suites;
  const byName = new Map(config.suites.map((suite) => [suite.name, suite]));
  const missing = wanted.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`unknown coverage suite(s): ${missing.join(', ')}`);
  }
  return wanted.map((name) => byName.get(name)!);
}

export function evaluateCoverage(
  suite: CoverageRatchetSuite,
  lcov: Map<string, LcovSourceCoverage>,
  baselines: Record<string, number>,
  defaultMinCoverage: number,
): CoverageGateReport {
  const rows: CoverageGateRow[] = [];
  const blockers: string[] = [];
  const ratchetUpdates: Array<{ key: string; previous: number | null; current: number }> = [];
  const nextBaselines = { ...baselines };
  const minCoverage = suite.minCoverage ?? defaultMinCoverage;

  for (const sourcePath of suite.sources) {
    const source = normalizeRepoPath(sourcePath);
    const coverage = lcov.get(source);
    const key = baselineKey(suite.name, source);
    const baseline = baselines[key] ?? null;

    if (!coverage) {
      blockers.push(`${suite.name}: missing LCOV record for ${source}`);
      rows.push({
        suite: suite.name,
        source,
        linesFound: 0,
        linesHit: 0,
        coveragePct: 0,
        minCoveragePct: minCoverage,
        ratchetBaselinePct: baseline,
        ratchetStatus: baseline === null ? 'new' : 'regressed',
      });
      continue;
    }

    let ratchetStatus: CoverageGateRow['ratchetStatus'] = baseline === null ? 'new' : 'ok';
    if (coverage.coveragePct < minCoverage) {
      blockers.push(`${suite.name}: ${source} coverage ${coverage.coveragePct}% < ${minCoverage}%`);
    }
    if (baseline !== null && coverage.coveragePct < baseline) {
      ratchetStatus = 'regressed';
      blockers.push(`${suite.name}: ${source} coverage regressed ${coverage.coveragePct}% < ${baseline}%`);
    } else if (coverage.coveragePct > (baseline ?? -1)) {
      ratchetStatus = baseline === null ? 'new' : 'raised';
      nextBaselines[key] = coverage.coveragePct;
      ratchetUpdates.push({ key, previous: baseline, current: coverage.coveragePct });
    }

    rows.push({
      suite: suite.name,
      source,
      linesFound: coverage.linesFound,
      linesHit: coverage.linesHit,
      coveragePct: coverage.coveragePct,
      minCoveragePct: minCoverage,
      ratchetBaselinePct: baseline,
      ratchetStatus,
    });
  }

  return {
    status: blockers.length === 0 ? 'ok' : 'failed',
    safeToContinue: blockers.length === 0,
    rows,
    blockers,
    ratchetUpdates,
    baselines: nextBaselines,
  };
}

export function mergeReports(reports: CoverageGateReport[]): CoverageGateReport {
  const baselines = reports.reduce<Record<string, number>>(
    (acc, report) => ({ ...acc, ...report.baselines }),
    {},
  );
  const blockers = reports.flatMap((report) => report.blockers);
  return {
    status: blockers.length === 0 ? 'ok' : 'failed',
    safeToContinue: blockers.length === 0,
    rows: reports.flatMap((report) => report.rows),
    blockers,
    ratchetUpdates: reports.flatMap((report) => report.ratchetUpdates),
    baselines,
  };
}
