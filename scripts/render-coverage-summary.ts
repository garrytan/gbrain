#!/usr/bin/env bun
/**
 * scripts/render-coverage-summary.ts — render the merged coverage summary
 * JSON as a GitHub-step-summary markdown block (containment sprint).
 *
 * Usage:
 *   bun scripts/render-coverage-summary.ts --summary <json> \
 *     [--structural scripts/structural-suites.tsv]
 *
 * Prints: corpus, lane completeness, DEGRADED banner (when set), total %,
 * per-dir table, top-10 worst-covered files (watchlist prioritized; the
 * watchlist is read from the working-tree scripts/coverage-baseline.json),
 * neverLoaded count + first 10, the src/cli.ts subprocess-undercount note,
 * and the behavioral-vs-structural test-intent line parsed from the TSV.
 *
 * This renderer consumes ONLY the JSON artifact (+ the structural TSV);
 * it never stdout-parses other tools.
 *
 * Exit codes: 0 success; 2 usage/IO error.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface StructuralCounts {
  suites: number;
  cases: number;
}

/**
 * Parse scripts/structural-suites.tsv (columns: file, suite, cases,
 * detector; '#' comments). Returns suite-row count + summed cases.
 */
export function parseStructuralTsv(text: string): StructuralCounts {
  let suites = 0;
  let cases = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    suites++;
    const n = Number(cols[2]);
    if (Number.isFinite(n)) cases += n;
  }
  return { suites, cases };
}

interface CovTriple {
  lines: number;
  covered: number;
  pct: number;
}

interface SummaryJson {
  generatedAt?: string;
  corpus?: string;
  lanes?: { expected?: string[]; complete?: string[] };
  degraded?: boolean;
  total?: CovTriple;
  dirs?: Record<string, CovTriple>;
  files?: Record<string, CovTriple>;
  neverLoaded?: { count: number; files: string[] };
}

function fail(msg: string): never {
  process.stderr.write(`render-coverage-summary: ${msg}\n`);
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  let summaryPath = "";
  let structuralPath = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--summary") summaryPath = argv[++i] ?? "";
    else if (a === "--structural") structuralPath = argv[++i] ?? "";
    else fail(`unknown argument: ${a}`);
  }
  if (!summaryPath) fail("--summary <json> is required");
  if (!existsSync(summaryPath)) fail(`summary JSON not found: ${summaryPath}`);
  let summary: SummaryJson;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryJson;
  } catch (err) {
    fail(`summary JSON unparseable: ${String(err)}`);
  }

  const out: string[] = [];
  out.push("## Coverage summary");
  out.push("");
  out.push(`- Corpus: \`${summary.corpus ?? "unknown"}\` (generated ${summary.generatedAt ?? "?"})`);
  const expected = summary.lanes?.expected ?? [];
  const complete = summary.lanes?.complete ?? [];
  const completeOfExpected = expected.filter((l) => complete.includes(l));
  if (expected.length > 0) {
    out.push(`- Lanes: ${completeOfExpected.length}/${expected.length} complete (expected: ${expected.join(", ")}; complete: ${complete.join(", ") || "none"})`);
  } else {
    out.push(`- Lanes: no expected-lane manifest check (complete: ${complete.join(", ") || "none"})`);
  }
  if (summary.degraded === true) {
    out.push("");
    out.push("> **DEGRADED COVERAGE DATA** — a lane was incomplete or an lcov file was malformed; gates run report-only for this run.");
  }
  out.push("");
  const total = summary.total ?? { lines: 0, covered: 0, pct: 0 };
  out.push(`- Total line coverage: **${total.pct}%** (${total.covered}/${total.lines} executable lines)`);
  out.push("- Function coverage: informational only (bun/JSC omits function names; line records are the gate input)");
  out.push("");

  // Per-directory table.
  const dirs = summary.dirs ?? {};
  out.push("### Per-directory line coverage");
  out.push("");
  out.push("| dir | lines | covered | pct |");
  out.push("|---|---|---|---|");
  for (const dir of Object.keys(dirs).sort()) {
    const d = dirs[dir]!;
    out.push(`| ${dir} | ${d.lines} | ${d.covered} | ${d.pct}% |`);
  }
  out.push("");

  // Worst-covered files, watchlist prioritized.
  const files = summary.files ?? {};
  let watchlist: string[] = [];
  const baselinePath = join(import.meta.dir, "coverage-baseline.json");
  if (existsSync(baselinePath)) {
    try {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { watchlist?: string[] };
      if (Array.isArray(baseline.watchlist)) watchlist = baseline.watchlist;
    } catch {
      // display-only nicety; a broken baseline never blocks rendering
    }
  }
  const watchSet = new Set(watchlist);
  const byPctAsc = (a: string, b: string) => files[a]!.pct - files[b]!.pct || (a < b ? -1 : 1);
  const watchRows = Object.keys(files).filter((f) => watchSet.has(f)).sort(byPctAsc);
  const otherRows = Object.keys(files).filter((f) => !watchSet.has(f)).sort(byPctAsc);
  const worst = [...watchRows, ...otherRows].slice(0, 10);
  out.push("### Worst-covered files (top 10, watchlist prioritized)");
  out.push("");
  out.push("| file | pct | lines | watchlist |");
  out.push("|---|---|---|---|");
  for (const f of worst) {
    const e = files[f]!;
    out.push(`| ${f} | ${e.pct}% | ${e.lines} | ${watchSet.has(f) ? "yes" : ""} |`);
  }
  out.push("");

  // Never-loaded inventory (count + head, never a fake percentage).
  const never = summary.neverLoaded ?? { count: 0, files: [] };
  out.push(`### Never-loaded src files: ${never.count}`);
  out.push("");
  for (const f of never.files.slice(0, 10)) out.push(`- ${f}`);
  if (never.count > 10) out.push(`- … +${never.count - 10} more`);
  out.push("");

  out.push(
    "Note: src/cli.ts is exercised mostly via CLI subprocesses; bun coverage does not propagate into child processes, so its numbers undercount ([subprocess-undercount]).",
  );
  out.push("");

  if (structuralPath) {
    if (!existsSync(structuralPath)) fail(`structural TSV not found: ${structuralPath}`);
    const counts = parseStructuralTsv(readFileSync(structuralPath, "utf8"));
    out.push(
      `Behavioral vs structural: structural suites ${counts.suites} / cases ${counts.cases} (see scripts/structural-suites.tsv)`,
    );
    out.push("");
  }

  process.stdout.write(out.join("\n"));
}

if (import.meta.main) main();
