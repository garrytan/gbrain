#!/usr/bin/env bun
/**
 * scripts/coverage-baseline-gate.ts — whole-corpus coverage regression gate
 * (containment sprint). Compares the merged summary against the committed
 * baseline AS IT EXISTS ON origin/master — never the working tree, so a PR
 * cannot weaken its own bar by editing the baseline file.
 *
 * Usage:
 *   bun scripts/coverage-baseline-gate.ts --summary <json> --corpus <prCorpus|fullCorpus>
 *
 * Behavior:
 *   - Baseline source: `git show origin/master:scripts/coverage-baseline.json`.
 *       * unresolvable ref            → exit 2 (infrastructure)
 *       * path absent on master      → 'ungated first landing', exit 0
 *       * present on master but the working-tree file was DELETED → exit 2
 *         (deletion defense: removing the file must not silently un-gate)
 *   - Like-for-like: ONLY the section named by --corpus is compared. A null
 *     corpus section → 'ungated first landing', exit 0 (sections are seeded
 *     by scripts/update-coverage-baseline.ts from real runs).
 *   - Regression: global pct drop > 0.5pp, or > 1.0pp on any dirs entry
 *     present in both baseline and summary → fail.
 *   - Shrinking-denominator defense: when the baseline corpus section has a
 *     numeric neverLoadedCount, a run whose neverLoaded.count EXCEEDS it is
 *     a regression too — deleting tests that load a module removes its files
 *     from the pct denominator and RAISES total %, which the pct checks
 *     alone cannot see. A null/absent baseline field skips the check.
 *   - Baseline "provisional": true OR summary degraded → report-only
 *     (verdict printed, exit 0) regardless of enforcement.
 *   - COVERAGE_GATE_ENFORCE: anything but '1' = report-only (WOULD
 *     PASS/WOULD FAIL, exit 0); '1' = exit 1 on fail.
 *   - Exit codes: 0 pass/report-only; 1 gate fail (enforcing); 2
 *     infrastructure error.
 *
 * Test seams (production ignores them when unset):
 *   COVERAGE_BASELINE_JSON_OVERRIDE   literal baseline JSON text used instead
 *                                     of git show; the sentinel value
 *                                     'ABSENT_ON_MASTER' simulates a missing
 *                                     path on master, 'GIT_FAILURE' simulates
 *                                     an unresolvable ref.
 *   COVERAGE_BASELINE_WORKTREE_PATH   working-tree baseline path checked by
 *                                     the deletion defense (default
 *                                     scripts/coverage-baseline.json next to
 *                                     this script).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CorpusSection {
  global: { lines: number; covered: number; pct: number };
  dirs: Record<string, { lines: number; covered: number; pct: number }>;
  files: Record<string, { lines: number; covered: number; pct: number }>;
  /** neverLoaded.count at seeding time; null/absent skips the check. */
  neverLoadedCount?: number | null;
}

export interface RegressionReport {
  regressions: string[];
  pass: boolean;
}

const GLOBAL_THRESHOLD_PP = 0.5;
const DIR_THRESHOLD_PP = 1.0;
const EPS = 1e-9;

/**
 * Pure comparison: baseline corpus section vs summary totals/dirs.
 * Returns human-readable regression lines; pass when none.
 */
export function compareCorpus(
  baseline: CorpusSection,
  summaryTotal: { pct: number },
  summaryDirs: Record<string, { pct: number }>,
  summaryNeverLoadedCount?: number | null,
): RegressionReport {
  const regressions: string[] = [];
  const globalDrop = baseline.global.pct - summaryTotal.pct;
  if (globalDrop > GLOBAL_THRESHOLD_PP + EPS) {
    regressions.push(
      `global: ${baseline.global.pct}% → ${summaryTotal.pct}% (-${globalDrop.toFixed(2)}pp > ${GLOBAL_THRESHOLD_PP}pp)`,
    );
  }
  for (const dir of Object.keys(baseline.dirs).sort()) {
    const sum = summaryDirs[dir];
    if (!sum) continue; // dir absent from this run's corpus — not comparable
    const drop = baseline.dirs[dir]!.pct - sum.pct;
    if (drop > DIR_THRESHOLD_PP + EPS) {
      regressions.push(`${dir}: ${baseline.dirs[dir]!.pct}% → ${sum.pct}% (-${drop.toFixed(2)}pp > ${DIR_THRESHOLD_PP}pp)`);
    }
  }
  // Shrinking-denominator defense: a growing never-loaded count means files
  // dropped OUT of the coverage denominator (tests deleted), which raises
  // pct for free — a regression the pct thresholds cannot see. Skipped when
  // either side lacks a numeric count (older baseline/summary shapes).
  const baseNL = baseline.neverLoadedCount;
  if (typeof baseNL === "number" && typeof summaryNeverLoadedCount === "number" && summaryNeverLoadedCount > baseNL) {
    regressions.push(
      `neverLoaded: ${baseNL} → ${summaryNeverLoadedCount} src files never loaded by any test ` +
        `(count may not grow — deleting tests shrinks the coverage denominator)`,
    );
  }
  return { regressions, pass: regressions.length === 0 };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function infraFail(msg: string): never {
  process.stderr.write(`coverage-baseline-gate: infrastructure error: ${msg}\n`);
  process.exit(2);
}

type BaselineFetch =
  | { status: "ok"; text: string }
  | { status: "absent" }
  | { status: "git-failure"; msg: string };

function fetchBaselineFromMaster(): BaselineFetch {
  const override = process.env.COVERAGE_BASELINE_JSON_OVERRIDE;
  if (override !== undefined && override !== "") {
    if (override === "ABSENT_ON_MASTER") return { status: "absent" };
    if (override === "GIT_FAILURE") return { status: "git-failure", msg: "simulated by COVERAGE_BASELINE_JSON_OVERRIDE" };
    return { status: "ok", text: override };
  }
  const res = spawnSync("git", ["show", "origin/master:scripts/coverage-baseline.json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) return { status: "git-failure", msg: String(res.error) };
  if (res.status === 0) return { status: "ok", text: res.stdout };
  const stderr = res.stderr || "";
  // Path errors mean the ref resolved but the file is not on master yet.
  if (/does not exist in|exists on disk, but not in/.test(stderr)) return { status: "absent" };
  return { status: "git-failure", msg: stderr.trim() };
}

interface BaselineJson {
  provisional?: boolean;
  prCorpus?: CorpusSection | null;
  fullCorpus?: CorpusSection | null;
  watchlist?: string[];
}

interface SummaryJson {
  corpus?: string;
  degraded?: boolean;
  total?: { lines: number; covered: number; pct: number };
  dirs?: Record<string, { lines: number; covered: number; pct: number }>;
  neverLoaded?: { count?: number };
}

function main(): void {
  const argv = process.argv.slice(2);
  let summaryPath = "";
  let corpus = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--summary") summaryPath = argv[++i] ?? "";
    else if (a === "--corpus") corpus = argv[++i] ?? "";
    else infraFail(`unknown argument: ${a}`);
  }
  if (!summaryPath) infraFail("--summary <json> is required");
  if (corpus !== "prCorpus" && corpus !== "fullCorpus") {
    infraFail("--corpus must be prCorpus or fullCorpus");
  }
  if (!existsSync(summaryPath)) infraFail(`summary JSON not found: ${summaryPath}`);
  let summary: SummaryJson;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryJson;
  } catch (err) {
    infraFail(`summary JSON unparseable: ${String(err)}`);
  }
  if (!summary.total) infraFail("summary JSON has no total section");
  if (summary.corpus && summary.corpus !== "unknown" && summary.corpus !== corpus) {
    process.stderr.write(
      `coverage-baseline-gate: warning: summary.corpus='${summary.corpus}' but --corpus=${corpus}; comparing the ${corpus} baseline section anyway\n`,
    );
  }

  const fetched = fetchBaselineFromMaster();
  if (fetched.status === "git-failure") infraFail(`cannot read baseline from origin/master: ${fetched.msg}`);
  if (fetched.status === "absent") {
    console.log("PASS: ungated first landing — scripts/coverage-baseline.json is not on origin/master yet.");
    process.exit(0);
  }

  // Deletion defense: baseline exists on master; the working-tree copy must
  // still exist too, or a PR could delete the file to dodge the gate.
  const worktreePath =
    process.env.COVERAGE_BASELINE_WORKTREE_PATH || join(import.meta.dir, "coverage-baseline.json");
  if (!existsSync(worktreePath)) {
    infraFail(
      `baseline exists on origin/master but the working-tree copy is missing (${worktreePath}) — restore scripts/coverage-baseline.json`,
    );
  }

  let baseline: BaselineJson;
  try {
    baseline = JSON.parse(fetched.text) as BaselineJson;
  } catch (err) {
    infraFail(`baseline JSON on origin/master is unparseable: ${String(err)}`);
  }

  const section = baseline[corpus as "prCorpus" | "fullCorpus"];
  if (section === null || section === undefined) {
    console.log(`PASS: ungated first landing — baseline has no ${corpus} section yet (seeded by update-coverage-baseline.ts).`);
    process.exit(0);
  }

  const report = compareCorpus(section, summary.total, summary.dirs ?? {}, summary.neverLoaded?.count);
  console.log(`Baseline comparison (${corpus}): baseline global ${section.global.pct}% vs run ${summary.total.pct}%`);
  for (const r of report.regressions) console.log(`  REGRESSION: ${r}`);
  if (report.pass) {
    console.log("  no regressions beyond thresholds (global 0.5pp, per-dir 1.0pp, never-loaded count non-increasing)");
  }

  // Provisional baseline / degraded data: report-only regardless of enforcement.
  if (baseline.provisional === true) {
    console.log(`REPORT-ONLY (baseline is provisional): ${report.pass ? "WOULD PASS" : "WOULD FAIL"}`);
    process.exit(0);
  }
  if (summary.degraded === true) {
    console.log("DEGRADED: coverage data is degraded — gate downgraded to report-only for this run.");
    console.log(`Verdict: ${report.pass ? "WOULD PASS" : "WOULD FAIL"}`);
    process.exit(0);
  }

  const enforcing = process.env.COVERAGE_GATE_ENFORCE === "1";
  if (!enforcing) {
    console.log(`Report-only (COVERAGE_GATE_ENFORCE != '1'): ${report.pass ? "WOULD PASS" : "WOULD FAIL"}`);
    process.exit(0);
  }
  if (report.pass) {
    console.log("PASS: no coverage regression vs origin/master baseline.");
    process.exit(0);
  }
  console.log("FAIL: coverage regression vs origin/master baseline.");
  process.exit(1);
}

if (import.meta.main) main();
