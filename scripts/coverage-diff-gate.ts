#!/usr/bin/env bun
/**
 * scripts/coverage-diff-gate.ts — changed-line coverage gate (containment
 * sprint). Verifies that lines ADDED/CHANGED by this branch are executed by
 * the merged PR test corpus.
 *
 * Usage:
 *   bun scripts/coverage-diff-gate.ts --summary <merged json> [--base <ref>]
 *     --summary  JSON artifact written by scripts/merge-lcov.ts (its
 *                lineHits extension key is the per-line input; this gate
 *                never re-parses lcov text and never stdout-parses tools)
 *     --base     diff base ref (default origin/master)
 *
 * Behavior:
 *   a. `bun scripts/select-e2e.ts --classify-only`: EMPTY|DOC_ONLY → PASS.
 *   b. Diff scope: `git diff --unified=0 <base>...HEAD -- src`, filtered in
 *      code to *.ts minus *.test.ts / *.generated.ts / *.d.ts. (The in-code
 *      filter, not a 'src/**\/*.ts' pathspec, because git's default fnmatch
 *      for that pattern misses top-level files like src/cli.ts.) Paths in
 *      scripts/coverage-gate-exemptions.txt AS IT EXISTS ON origin/master
 *      (mirroring the baseline-gate's governance — a PR cannot add its own
 *      files to the list and self-exempt; working-tree additions are inert
 *      until merged) are excluded from the gate but still REPORTED with
 *      their tag. If the file is absent on master (first landing) the
 *      working-tree copy is used; if git itself fails, exit 2 infra unless
 *      report-only (which warns and falls back to the working tree).
 *   c. Zero gate-scoped changed lines → PASS.
 *   d. Per changed file with a coverage record: added line present in DA
 *      with hits>0 → covered; present with 0 → uncovered; absent from DA →
 *      non-executable (excluded). A gate-scoped changed file with NO record
 *      is ONE violation ("never loaded by any test in the PR corpus — add a
 *      test that imports it"); its physical line count is deliberately NOT
 *      used.
 *   e. Verdict: covered/(covered+uncovered) >= 0.80 AND zero never-loaded
 *      violations.
 *   f. Escape hatch: any commit body in <base>..HEAD containing
 *      '[coverage-exempt:' → PASS with a loud warning.
 *   g. Degraded summary → report-only for this run (DEGRADED banner,
 *      verdict printed, exit 0).
 *   h. COVERAGE_GATE_ENFORCE: anything but '1' = report-only (WOULD
 *      PASS/WOULD FAIL + per-file table, exit 0); '1' = exit 1 on fail.
 *   i. Exit codes: 0 pass/report-only; 1 gate fail (enforcing); 2
 *      infrastructure error (missing summary, git failure, unresolvable
 *      base).
 *
 * Test seams (fixture injection; production ignores them when unset):
 *   COVERAGE_GATE_CLASSIFY      literal EMPTY|DOC_ONLY|SRC (skips select-e2e)
 *   COVERAGE_GATE_DIFF_FILE     path to unified-diff text (skips git diff)
 *   COVERAGE_GATE_COMMITS_FILE  path to commit-message text (skips git log)
 *   COVERAGE_GATE_EXEMPTIONS_OVERRIDE  literal exemptions-file CONTENT; wins
 *                               over both origin/master and the working tree
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse `git diff --unified=0` text into new-side added/changed line numbers
 * per file. Deletions (`+++ /dev/null`) are skipped; a hunk `@@ -a,b +c,d @@`
 * contributes lines c..c+d-1 (d defaults to 1; d=0 contributes nothing).
 */
export function parseUnifiedDiff(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      current = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    if (!current) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = parseInt(m[1]!, 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2]!, 10);
    if (count <= 0) continue;
    const arr = out.get(current) ?? [];
    for (let i = 0; i < count; i++) arr.push(start + i);
    out.set(current, arr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

export interface Exemptions {
  exact: Set<string>;
  prefixes: string[];
}

export function parseExemptions(text: string): Exemptions {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.endsWith("/")) prefixes.push(line);
    else exact.add(line);
  }
  return { exact, prefixes };
}

export function isExempt(path: string, ex: Exemptions): boolean {
  if (ex.exact.has(path)) return true;
  return ex.prefixes.some((p) => path.startsWith(p));
}

/** Gate scope: src/ TypeScript, excluding tests/generated/declarations. */
export function isGateScopedPath(path: string): boolean {
  return (
    path.startsWith("src/") &&
    path.endsWith(".ts") &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".generated.ts") &&
    !path.endsWith(".d.ts")
  );
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface FileRow {
  file: string;
  added: number;
  covered: number | null;
  uncovered: number | null;
  uncoveredLines: number[];
  status: string;
}

function formatLineList(lines: number[]): string {
  const shown = lines.slice(0, 20).map((l) => `L${l}`);
  const extra = lines.length > 20 ? `, +${lines.length - 20} more` : "";
  return shown.join(", ") + extra;
}

function printTable(rows: FileRow[]): void {
  if (rows.length === 0) return;
  console.log("");
  console.log("| file | added lines | covered | uncovered | status |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) {
    const cov = r.covered === null ? "-" : String(r.covered);
    const unc =
      r.uncovered === null
        ? "-"
        : r.uncoveredLines.length > 0
          ? `${r.uncovered} (${formatLineList(r.uncoveredLines)})`
          : String(r.uncovered);
    console.log(`| ${r.file} | ${r.added} | ${cov} | ${unc} | ${r.status} |`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function infraFail(msg: string): never {
  process.stderr.write(`coverage-diff-gate: infrastructure error: ${msg}\n`);
  process.exit(2);
}

function runGit(args: string[]): string {
  const res = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    infraFail(`git ${args.join(" ")} failed: ${res.error ? String(res.error) : (res.stderr || "").trim()}`);
  }
  return res.stdout;
}

const EXEMPTIONS_REPO_PATH = "scripts/coverage-gate-exemptions.txt";

/**
 * Resolve the exemption LIST from origin/master, never the working tree —
 * mirroring coverage-baseline-gate.ts's governance. Otherwise a PR could add
 * its own files to the list and self-exempt from the 80% gate the moment
 * enforcement graduates. Working-tree additions are INERT until merged.
 *
 * Resolution order:
 *   1. COVERAGE_GATE_EXEMPTIONS_OVERRIDE (test seam; literal file content).
 *   2. `git show origin/master:scripts/coverage-gate-exemptions.txt`.
 *   3. Path absent on master (first landing) → working-tree copy.
 *   4. git itself failed (unresolvable ref, ...) → exit 2 infra when
 *      enforcing; report-only warns and falls back to the working tree so
 *      the report still prints.
 */
function resolveExemptionsText(enforcing: boolean): string {
  const override = process.env.COVERAGE_GATE_EXEMPTIONS_OVERRIDE;
  if (override !== undefined) return override;

  const res = spawnSync("git", ["show", `origin/master:${EXEMPTIONS_REPO_PATH}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!res.error && res.status === 0) return res.stdout;

  const stderr = res.error ? String(res.error) : res.stderr || "";
  const worktreePath = join(import.meta.dir, "coverage-gate-exemptions.txt");
  const readWorktree = (): string => {
    if (!existsSync(worktreePath)) infraFail(`exemptions file missing: ${worktreePath}`);
    return readFileSync(worktreePath, "utf8");
  };

  // Path errors mean the ref resolved but the file is not on master yet.
  if (!res.error && /does not exist in|exists on disk, but not in/.test(stderr)) {
    return readWorktree();
  }
  if (enforcing) {
    infraFail(`cannot read ${EXEMPTIONS_REPO_PATH} from origin/master: ${stderr.trim()}`);
  }
  process.stderr.write(
    `coverage-diff-gate: warning: cannot read ${EXEMPTIONS_REPO_PATH} from origin/master (${stderr.trim()}) — report-only run falls back to the working-tree copy\n`,
  );
  return readWorktree();
}

interface SummaryJson {
  degraded?: boolean;
  files?: Record<string, { lines: number; covered: number; pct: number }>;
  lineHits?: Record<string, Record<string, number>>;
}

function main(): void {
  const argv = process.argv.slice(2);
  let summaryPath = "";
  let base = "origin/master";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--summary") summaryPath = argv[++i] ?? "";
    else if (a === "--base") base = argv[++i] ?? "origin/master";
    else infraFail(`unknown argument: ${a}`);
  }
  if (!summaryPath) infraFail("--summary <merged json> is required");
  if (!existsSync(summaryPath)) infraFail(`summary JSON not found: ${summaryPath}`);
  const enforcing = process.env.COVERAGE_GATE_ENFORCE === "1";
  let summary: SummaryJson;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryJson;
  } catch (err) {
    infraFail(`summary JSON unparseable: ${String(err)}`);
  }

  // (a) change classification — doc-only/empty diffs are not gated.
  let classification = process.env.COVERAGE_GATE_CLASSIFY ?? "";
  if (!classification) {
    const res = spawnSync("bun", ["scripts/select-e2e.ts", "--classify-only"], { encoding: "utf8" });
    if (res.error || res.status !== 0) {
      infraFail(`select-e2e --classify-only failed: ${res.error ? String(res.error) : (res.stderr || "").trim()}`);
    }
    classification = res.stdout.trim();
  } else {
    classification = classification.trim();
  }
  if (classification === "EMPTY" || classification === "DOC_ONLY") {
    console.log(`PASS: change classified ${classification} — coverage diff gate not applicable.`);
    process.exit(0);
  }

  // (b) diff scope.
  const diffFile = process.env.COVERAGE_GATE_DIFF_FILE;
  let diffText: string;
  if (diffFile) {
    if (!existsSync(diffFile)) infraFail(`COVERAGE_GATE_DIFF_FILE not found: ${diffFile}`);
    diffText = readFileSync(diffFile, "utf8");
  } else {
    diffText = runGit(["diff", "--unified=0", `${base}...HEAD`, "--", "src"]);
  }
  const changed = parseUnifiedDiff(diffText);

  const exemptions = parseExemptions(resolveExemptionsText(enforcing));

  const rows: FileRow[] = [];
  let covered = 0;
  let uncovered = 0;
  let neverLoadedViolations = 0;
  let gatedChangedLines = 0;

  const lineHits = summary.lineHits;
  const filesWithRecords = new Set([
    ...Object.keys(summary.files ?? {}),
    ...Object.keys(lineHits ?? {}),
  ]);

  const scopedFiles = [...changed.keys()].filter(isGateScopedPath).sort();
  for (const file of scopedFiles) {
    const addedLines = changed.get(file)!;
    if (isExempt(file, exemptions)) {
      // Exempt: reported, never gated. src/cli.ts gets its own honest tag.
      const tag = file === "src/cli.ts" ? "[subprocess-undercount]" : "[e2e-exempt]";
      rows.push({ file, added: addedLines.length, covered: null, uncovered: null, uncoveredLines: [], status: tag });
      continue;
    }
    gatedChangedLines += addedLines.length;
    if (!filesWithRecords.has(file)) {
      // (d) no coverage record at all: ONE violation; do NOT count physical lines.
      neverLoadedViolations++;
      rows.push({
        file,
        added: addedLines.length,
        covered: null,
        uncovered: null,
        uncoveredLines: [],
        status: "VIOLATION: never loaded by any test in the PR corpus — add a test that imports it",
      });
      continue;
    }
    if (!lineHits) {
      infraFail("summary JSON has no lineHits key — regenerate it with the current scripts/merge-lcov.ts");
    }
    const da = lineHits[file] ?? {};
    let fileCovered = 0;
    const fileUncoveredLines: number[] = [];
    for (const line of addedLines) {
      const hits = da[String(line)];
      if (hits === undefined) continue; // non-executable — excluded
      if (hits > 0) fileCovered++;
      else fileUncoveredLines.push(line);
    }
    covered += fileCovered;
    uncovered += fileUncoveredLines.length;
    rows.push({
      file,
      added: addedLines.length,
      covered: fileCovered,
      uncovered: fileUncoveredLines.length,
      uncoveredLines: fileUncoveredLines,
      status: "gated",
    });
  }

  // (c) zero gate-scoped changed lines.
  if (gatedChangedLines === 0) {
    printTable(rows); // exempt-only changes still get reported
    console.log("PASS: no gate-scoped changes.");
    process.exit(0);
  }

  // (e) verdict.
  const denom = covered + uncovered;
  const ratio = denom === 0 ? 1 : covered / denom;
  const pass = ratio >= 0.8 - 1e-9 && neverLoadedViolations === 0;
  const pctStr = (ratio * 100).toFixed(2);

  printTable(rows);
  console.log(`Changed-line coverage: ${covered}/${denom} = ${pctStr}% (threshold 80%)`);
  if (neverLoadedViolations > 0) {
    console.log(`Never-loaded gate-scoped files: ${neverLoadedViolations} (each is a violation)`);
  }

  // (f) escape hatch trailer.
  const commitsFile = process.env.COVERAGE_GATE_COMMITS_FILE;
  let commitsText: string;
  if (commitsFile) {
    if (!existsSync(commitsFile)) infraFail(`COVERAGE_GATE_COMMITS_FILE not found: ${commitsFile}`);
    commitsText = readFileSync(commitsFile, "utf8");
  } else {
    commitsText = runGit(["log", `${base}..HEAD`, "--format=%B"]);
  }
  if (commitsText.includes("[coverage-exempt:")) {
    console.log("");
    console.log("WARNING: '[coverage-exempt:' trailer found in a commit body — coverage diff gate BYPASSED for this branch.");
    console.log(`PASS (escape hatch): verdict without the trailer would have been ${pass ? "PASS" : "FAIL"}.`);
    process.exit(0);
  }

  // (g) degraded coverage data → report-only for this run.
  if (summary.degraded === true) {
    console.log("");
    console.log("DEGRADED: coverage data is degraded (lane incomplete/malformed) — gate downgraded to report-only for this run.");
    console.log(`Verdict: ${pass ? "WOULD PASS" : "WOULD FAIL"}`);
    process.exit(0);
  }

  // (h) enforcement.
  if (!enforcing) {
    console.log(`Report-only (COVERAGE_GATE_ENFORCE != '1'): ${pass ? "WOULD PASS" : "WOULD FAIL"}`);
    process.exit(0);
  }
  if (pass) {
    console.log("PASS: changed-line coverage gate.");
    process.exit(0);
  }
  console.log("FAIL: changed-line coverage below 80% or never-loaded files present.");
  process.exit(1);
}

if (import.meta.main) main();
