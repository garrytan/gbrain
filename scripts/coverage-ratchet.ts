#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  evaluateCoverage,
  mergeReports,
  normalizeBaselines,
  parseLcov,
  sanitizeSuiteName,
  selectSuites,
  validateConfig,
  type CoverageGateReport,
  type CoverageRatchetConfig,
  type CoverageRatchetSuite,
} from '../src/core/coverage-ratchet.ts';

interface CliArgs {
  configPath: string;
  suiteNames: string[];
  updateRatchet: boolean;
  json: boolean;
  coverageDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: 'coverage-ratchet.config.json',
    suiteNames: [],
    updateRatchet: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') args.configPath = argv[++i] ?? '';
    else if (arg.startsWith('--config=')) args.configPath = arg.slice('--config='.length);
    else if (arg === '--suite') args.suiteNames.push(argv[++i] ?? '');
    else if (arg.startsWith('--suite=')) args.suiteNames.push(arg.slice('--suite='.length));
    else if (arg === '--update-ratchet') args.updateRatchet = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--coverage-dir') args.coverageDir = argv[++i] ?? '';
    else if (arg.startsWith('--coverage-dir=')) args.coverageDir = arg.slice('--coverage-dir='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }
  if (!args.configPath) throw new Error('--config requires a path');
  if (args.suiteNames.some((name) => !name)) throw new Error('--suite requires a name');
  if (args.coverageDir === '') throw new Error('--coverage-dir requires a path');
  return args;
}

function printHelp() {
  console.log(`Usage: bun run scripts/coverage-ratchet.ts [--config path] [--suite name] [--update-ratchet] [--json]`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeBaselines(path: string, baselines: Record<string, number>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ schema: 'gbrain.coverage-ratchet.baselines.v1', baselines }, null, 2) + '\n',
  );
}

function runCoverage(
  suite: CoverageRatchetSuite,
  cwd: string,
  coverageRoot: string,
): { ok: true; lcov: string } | { ok: false; report: CoverageGateReport; stdout: string; stderr: string } {
  const suiteDir = join(coverageRoot, sanitizeSuiteName(suite.name));
  rmSync(suiteDir, { recursive: true, force: true });
  mkdirSync(suiteDir, { recursive: true });
  const result = spawnSync(
    'bun',
    [
      'test',
      '--coverage',
      '--coverage-reporter=lcov',
      '--coverage-dir',
      suiteDir,
      ...suite.tests,
    ],
    { cwd, encoding: 'utf8' },
  );
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0) {
    return {
      ok: false,
      stdout,
      stderr,
      report: {
        status: 'failed',
        safeToContinue: false,
        rows: [],
        blockers: [`${suite.name}: bun test failed with status ${result.status ?? 'unknown'}`],
        ratchetUpdates: [],
        baselines: {},
      },
    };
  }
  const lcovPath = join(suiteDir, 'lcov.info');
  if (!existsSync(lcovPath)) {
    return {
      ok: false,
      stdout,
      stderr,
      report: {
        status: 'failed',
        safeToContinue: false,
        rows: [],
        blockers: [`${suite.name}: missing LCOV output at ${lcovPath}`],
        ratchetUpdates: [],
        baselines: {},
      },
    };
  }
  return { ok: true, lcov: readFileSync(lcovPath, 'utf8') };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const configPath = resolve(cwd, args.configPath);
  const config = readJson<CoverageRatchetConfig>(configPath);
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) throw new Error(configErrors.join('\n'));

  const coverageRoot = resolve(cwd, args.coverageDir ?? config.coverageDir ?? '.tmp/coverage-ratchet');
  const baselinePath = resolve(cwd, config.baselineFile ?? 'coverage-ratchet.baselines.json');
  const baselines = normalizeBaselines(existsSync(baselinePath) ? readJson<unknown>(baselinePath) : {});
  const suites = selectSuites(config, args.suiteNames);
  const defaultMinCoverage = config.minCoverage ?? 90;

  let currentBaselines = baselines;
  const reports: CoverageGateReport[] = [];
  for (const suite of suites) {
    const coverage = runCoverage(suite, cwd, coverageRoot);
    if (!coverage.ok) {
      reports.push({ ...coverage.report, baselines: currentBaselines });
      if (!args.json) {
        process.stderr.write(coverage.stdout);
        process.stderr.write(coverage.stderr);
      }
      continue;
    }
    const report = evaluateCoverage(suite, parseLcov(coverage.lcov, cwd), currentBaselines, defaultMinCoverage);
    reports.push(report);
    currentBaselines = report.baselines;
  }

  const merged = mergeReports(reports);
  if (args.updateRatchet && merged.safeToContinue) {
    writeBaselines(baselinePath, merged.baselines);
  }

  if (args.json) {
    console.log(JSON.stringify({ ...merged, baselineFile: baselinePath }, null, 2));
  } else {
    for (const row of merged.rows) {
      console.log(`${row.suite}: ${row.source} ${row.coveragePct}% (${row.linesHit}/${row.linesFound})`);
    }
    for (const blocker of merged.blockers) {
      console.error(`blocker: ${blocker}`);
    }
    if (args.updateRatchet && merged.safeToContinue && merged.ratchetUpdates.length > 0) {
      console.error(`[coverage-ratchet] updated ${merged.ratchetUpdates.length} baseline(s) in ${baselinePath}`);
    }
  }
  return merged.safeToContinue ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
