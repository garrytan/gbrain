#!/usr/bin/env bun
/**
 * scripts/merge-lcov.ts — merge per-lane bun lcov.info files into one
 * artifact pair: a regenerated merged lcov + a JSON summary for the
 * coverage gates (containment sprint).
 *
 * Usage:
 *   bun scripts/merge-lcov.ts --out-lcov <path> --out-json <path> \
 *     [--manifest-expect <lane,lane,...>] <dir-or-file>...
 *
 * Behavior:
 *   - Recursively finds every lcov.info under the input dirs (a file input
 *     is used directly). Only LOADED files appear in bun's lcov output; a
 *     src file that never appears was never imported by any test. Any
 *     lcov.info under a `coverage-merged` path segment is skipped: report-
 *     job re-runs download the prior run's merged artifact via the
 *     `coverage-*` glob, and re-merging it would double every hit count.
 *   - Parses SF/DA/FN/FNDA/LF/LH/TN/end_of_record. Unknown record types
 *     (e.g. BRDA) warn to stderr and are SKIPPED — never passed through.
 *   - A malformed/truncated lcov.info warns, is skipped WHOLE, and marks
 *     the summary degraded — the merge never aborts on bad lane data.
 *   - SF normalization: absolute paths become repo-relative POSIX paths
 *     (repo root = process.cwd(); any absolute prefix ending in the repo
 *     directory name is also stripped), then deduped/merged.
 *   - Merge math: DA hits summed per file:line; FNDA hits summed per
 *     function name. All output records are REGENERATED from parsed data
 *     (fresh FN/FNDA/FNF/FNH/LF/LH). bun/JSC omits function names, so
 *     function records are informational only — line records are the only
 *     gate input (summary carries functionCoverage: 'informational').
 *   - Lane manifests: each lane dir may contain lane-manifest.json
 *     {lane, sha, lcovCount, complete}. With --manifest-expect, a
 *     missing/incomplete manifest for an expected lane marks degraded.
 *     A manifest whose lane name contains 'shard' with lcovCount != 1
 *     marks degraded: the shard lane runs ONE bun process via xargs -x;
 *     a second bun process reusing the coverage dir would have OVERWRITTEN
 *     lcov.info, so any other count means the xargs-batching tripwire
 *     fired and line data was silently lost.
 *   - JSON metrics count src/ files ONLY (test/, scripts/, node_modules
 *     records are kept in the merged out-lcov but excluded from
 *     totals/dirs/files). neverLoaded lists src/**\/*.ts files (non-test,
 *     non-generated, non-*.d.ts) absent from the merged data — a COUNT +
 *     sorted list, deliberately NEVER a fake all-files percentage
 *     (physical lines != executable lines).
 *   - lineHits (EXTENSION KEY, consumed by scripts/coverage-diff-gate.ts):
 *     per-src-file per-line merged DA hits, so the gates read ONE JSON
 *     artifact and never re-parse lcov text.
 *
 * Env:
 *   COVERAGE_CORPUS  names the corpus ('prCorpus'|'fullCorpus'; default
 *                    'unknown').
 *   GENERATED_AT     overrides the generatedAt timestamp (fixture-locked
 *                    tests).
 *
 * Exit codes: 0 success (including degraded — degraded is DATA, carried in
 * the summary for the gates to downgrade on); 2 usage/IO error.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface LcovFileRecord {
  sf: string;
  /** [line, hits] pairs, in file order (may repeat lines across records). */
  da: Array<[number, number]>;
  /** [line, name] pairs. */
  fn: Array<[number, string]>;
  /** [hits, name] pairs. */
  fnda: Array<[number, string]>;
}

export interface ParseResult {
  records: LcovFileRecord[];
  warnings: string[];
  /** True when the file is malformed/truncated; caller must skip it whole. */
  malformed: boolean;
}

/** Record types we parse but do not carry through (they are recomputed). */
const KNOWN_RECOMPUTED = new Set(["TN", "FNF", "FNH", "LF", "LH"]);

/**
 * Parse one lcov.info text. Never throws. On any malformed/truncated
 * structure, returns malformed:true — the caller drops the whole file.
 */
export function parseLcovText(text: string): ParseResult {
  const warnings: string[] = [];
  const warnedTypes = new Set<string>();
  const records: LcovFileRecord[] = [];
  let current: LcovFileRecord | null = null;

  const fail = (msg: string): ParseResult => {
    warnings.push(msg);
    return { records: [], warnings, malformed: true };
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;

    if (line === "end_of_record") {
      if (!current) return fail(`line ${i + 1}: end_of_record without SF`);
      records.push(current);
      current = null;
      continue;
    }

    const colon = line.indexOf(":");
    if (colon < 0) return fail(`line ${i + 1}: unparseable line ${JSON.stringify(line)}`);
    const type = line.slice(0, colon);
    const rest = line.slice(colon + 1);

    if (type === "SF") {
      if (current) return fail(`line ${i + 1}: SF while previous record open (missing end_of_record)`);
      if (rest.trim() === "") return fail(`line ${i + 1}: SF with empty path`);
      current = { sf: rest.trim(), da: [], fn: [], fnda: [] };
      continue;
    }
    if (KNOWN_RECOMPUTED.has(type)) continue; // parsed + ignored; regenerated on output
    if (type === "DA") {
      if (!current) return fail(`line ${i + 1}: DA outside an SF record`);
      const parts = rest.split(",");
      const ln = Number(parts[0]);
      const hits = Number(parts[1]);
      if (!Number.isFinite(ln) || !Number.isFinite(hits)) {
        return fail(`line ${i + 1}: malformed DA record ${JSON.stringify(line)}`);
      }
      current.da.push([ln, hits]);
      continue;
    }
    if (type === "FN") {
      if (!current) return fail(`line ${i + 1}: FN outside an SF record`);
      const comma = rest.indexOf(",");
      const ln = Number(comma < 0 ? rest : rest.slice(0, comma));
      const name = comma < 0 ? "" : rest.slice(comma + 1);
      if (!Number.isFinite(ln)) return fail(`line ${i + 1}: malformed FN record`);
      current.fn.push([ln, name]);
      continue;
    }
    if (type === "FNDA") {
      if (!current) return fail(`line ${i + 1}: FNDA outside an SF record`);
      const comma = rest.indexOf(",");
      const hits = Number(comma < 0 ? rest : rest.slice(0, comma));
      const name = comma < 0 ? "" : rest.slice(comma + 1);
      if (!Number.isFinite(hits)) return fail(`line ${i + 1}: malformed FNDA record`);
      current.fnda.push([hits, name]);
      continue;
    }
    // Unknown record type: warn once per type per file, skip (no pass-through).
    if (!warnedTypes.has(type)) {
      warnedTypes.add(type);
      warnings.push(`unknown lcov record type ${JSON.stringify(type)} — skipped`);
    }
  }
  if (current) return fail("truncated file: SF record without end_of_record");
  return { records, warnings, malformed: false };
}

// ---------------------------------------------------------------------------
// SF normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an SF path to repo-relative POSIX. Repo root = repoRootAbs
 * (process.cwd() in production). Also strips any absolute prefix ending in
 * the repo directory name (CI checkouts live under a different absolute
 * root than the machine that reads the artifact).
 */
export function normalizeSf(sfRaw: string, repoRootAbs: string): string {
  let p = sfRaw.replace(/\\/g, "/");
  const root = repoRootAbs.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p === root) return "";
  if (p.startsWith(root + "/")) p = p.slice(root.length + 1);
  else if (p.startsWith("/") || /^[A-Za-z]:\//.test(p)) {
    const repoDirName = root.slice(root.lastIndexOf("/") + 1);
    const marker = "/" + repoDirName + "/";
    const idx = p.lastIndexOf(marker);
    if (idx >= 0) p = p.slice(idx + marker.length);
    // else: absolute path outside any recognizable repo prefix — keep as-is;
    // it will not match src/ and stays out of the JSON metrics.
  }
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export interface MergedFile {
  /** line -> summed hits */
  da: Map<number, number>;
  /** function name -> first (lowest) line seen */
  fnLine: Map<string, number>;
  /** function name -> summed hits */
  fnda: Map<string, number>;
}

export type Merged = Map<string, MergedFile>;

export function mergeRecord(merged: Merged, sfNormalized: string, rec: LcovFileRecord): void {
  let f = merged.get(sfNormalized);
  if (!f) {
    f = { da: new Map(), fnLine: new Map(), fnda: new Map() };
    merged.set(sfNormalized, f);
  }
  for (const [line, hits] of rec.da) f.da.set(line, (f.da.get(line) ?? 0) + hits);
  for (const [line, name] of rec.fn) {
    const prev = f.fnLine.get(name);
    if (prev === undefined || line < prev) f.fnLine.set(name, line);
  }
  for (const [hits, name] of rec.fnda) f.fnda.set(name, (f.fnda.get(name) ?? 0) + hits);
}

/** Regenerate a merged lcov text from parsed data (fresh counters). */
export function emitLcov(merged: Merged): string {
  const out: string[] = [];
  const files = [...merged.keys()].sort();
  for (const file of files) {
    const f = merged.get(file)!;
    out.push("TN:");
    out.push(`SF:${file}`);
    const fnEntries = [...f.fnLine.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    for (const [name, line] of fnEntries) out.push(`FN:${line},${name}`);
    const fndaEntries = [...f.fnda.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [name, hits] of fndaEntries) out.push(`FNDA:${hits},${name}`);
    out.push(`FNF:${f.fnLine.size}`);
    out.push(`FNH:${[...f.fnda.values()].filter((h) => h > 0).length}`);
    const daLines = [...f.da.keys()].sort((a, b) => a - b);
    for (const line of daLines) out.push(`DA:${line},${f.da.get(line)!}`);
    out.push(`LF:${f.da.size}`);
    out.push(`LH:${[...f.da.values()].filter((h) => h > 0).length}`);
    out.push("end_of_record");
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

// ---------------------------------------------------------------------------
// src/ inventory for neverLoaded
// ---------------------------------------------------------------------------

/**
 * All gate-relevant source files on disk: src/**\/*.ts, excluding *.test.ts,
 * *.generated.ts, *.d.ts. Repo-relative POSIX, sorted.
 */
export function listSrcTsFiles(repoRootAbs: string): string[] {
  const srcAbs = join(repoRootAbs, "src");
  if (!existsSync(srcAbs)) return [];
  const out: string[] = [];
  const walk = (dirAbs: string, relFromSrc: string): void => {
    for (const ent of readdirSync(dirAbs, { withFileTypes: true })) {
      const rel = relFromSrc ? `${relFromSrc}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === "node_modules") continue;
        walk(join(dirAbs, ent.name), rel);
      } else if (
        ent.name.endsWith(".ts") &&
        !ent.name.endsWith(".test.ts") &&
        !ent.name.endsWith(".generated.ts") &&
        !ent.name.endsWith(".d.ts")
      ) {
        out.push(`src/${rel}`);
      }
    }
  };
  walk(srcAbs, "");
  return out.sort();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface CovTriple {
  lines: number;
  covered: number;
  pct: number;
}

export function pctOf(covered: number, lines: number): number {
  if (lines === 0) return 0;
  return Math.round((covered / lines) * 10000) / 100;
}

/** Top-level src dir bucket: src/core/x/y.ts -> 'src/core'; src/cli.ts -> 'src'. */
export function topLevelSrcDir(file: string): string {
  const parts = file.split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

// ---------------------------------------------------------------------------
// Lane manifests
// ---------------------------------------------------------------------------

export interface LaneManifest {
  lane: string;
  sha?: string;
  lcovCount?: number;
  complete?: boolean;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function warn(msg: string): void {
  process.stderr.write(`merge-lcov: warning: ${msg}\n`);
}

function usage(msg: string): never {
  process.stderr.write(`merge-lcov: ${msg}\n`);
  process.stderr.write(
    "usage: bun scripts/merge-lcov.ts --out-lcov <path> --out-json <path> [--manifest-expect <lane,lane,...>] <dir-or-file>...\n",
  );
  process.exit(2);
}

/**
 * Self-merge guard: the CI report job downloads coverage artifacts via the
 * `coverage-*` glob, and on a re-run the PRIOR report job's own
 * `coverage-merged` artifact matches that glob too. Re-merging our own merged
 * output into itself would double every hit count, so any lcov.info whose
 * path contains a `coverage-merged` segment is skipped.
 */
export function isMergedArtifactPath(p: string): boolean {
  return p.split(/[\\/]/).includes("coverage-merged");
}

function walkForInputs(dirAbs: string, lcovFiles: string[], manifestFiles: string[]): void {
  for (const ent of readdirSync(dirAbs, { withFileTypes: true })) {
    const p = join(dirAbs, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules") continue;
      walkForInputs(p, lcovFiles, manifestFiles);
    } else if (ent.name === "lcov.info") {
      if (isMergedArtifactPath(p)) {
        // Expected on report-job re-runs — skipped, NOT degraded.
        warn(`skipping ${p}: under a coverage-merged path segment (self-merge guard)`);
        continue;
      }
      lcovFiles.push(p);
    } else if (ent.name === "lane-manifest.json") {
      manifestFiles.push(p);
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let outLcov = "";
  let outJson = "";
  let manifestExpect: string[] = [];
  const inputs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out-lcov") outLcov = argv[++i] ?? "";
    else if (a === "--out-json") outJson = argv[++i] ?? "";
    else if (a === "--manifest-expect") {
      manifestExpect = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a.startsWith("--")) usage(`unknown flag: ${a}`);
    else inputs.push(a);
  }
  if (!outLcov || !outJson) usage("--out-lcov and --out-json are required");
  if (inputs.length === 0) usage("at least one <dir-or-file> input is required");

  let degraded = false;
  const lcovFiles: string[] = [];
  const manifestFiles: string[] = [];
  for (const input of inputs) {
    if (!existsSync(input)) {
      warn(`input path not found: ${input} — marking degraded`);
      degraded = true;
      continue;
    }
    const st = statSync(input);
    if (st.isFile()) {
      if (isMergedArtifactPath(input)) {
        warn(`skipping ${input}: under a coverage-merged path segment (self-merge guard)`);
        continue;
      }
      lcovFiles.push(input);
    } else {
      walkForInputs(input, lcovFiles, manifestFiles);
    }
  }

  // --- lane manifests ---
  const manifests: LaneManifest[] = [];
  for (const mf of manifestFiles) {
    try {
      const parsed = JSON.parse(readFileSync(mf, "utf8")) as Partial<LaneManifest>;
      if (typeof parsed.lane !== "string" || parsed.lane === "") {
        warn(`manifest ${mf} has no lane name — marking degraded`);
        degraded = true;
        continue;
      }
      manifests.push({
        lane: parsed.lane,
        sha: typeof parsed.sha === "string" ? parsed.sha : undefined,
        lcovCount: typeof parsed.lcovCount === "number" ? parsed.lcovCount : undefined,
        complete: parsed.complete === true,
      });
    } catch {
      warn(`manifest ${mf} is not valid JSON — marking degraded`);
      degraded = true;
    }
  }
  for (const m of manifests) {
    // xargs-batching tripwire: a shard lane must have written EXACTLY ONE
    // lcov.info (one bun process). Anything else means data was overwritten
    // or never written.
    if (m.lane.includes("shard") && m.lcovCount !== 1) {
      warn(`shard lane '${m.lane}' has lcovCount=${m.lcovCount ?? "missing"} (expected 1) — marking degraded`);
      degraded = true;
    }
  }
  for (const expected of manifestExpect) {
    const m = manifests.find((x) => x.lane === expected);
    if (!m) {
      warn(`expected lane '${expected}' has no lane-manifest.json — marking degraded`);
      degraded = true;
    } else if (m.complete !== true) {
      warn(`expected lane '${expected}' manifest is not complete — marking degraded`);
      degraded = true;
    }
  }

  // --- parse + merge ---
  const repoRoot = process.cwd();
  const merged: Merged = new Map();
  let parsedFiles = 0;
  for (const lf of lcovFiles) {
    let text: string;
    try {
      text = readFileSync(lf, "utf8");
    } catch (err) {
      warn(`cannot read ${lf}: ${String(err)} — skipped, marking degraded`);
      degraded = true;
      continue;
    }
    const res = parseLcovText(text);
    for (const w of res.warnings) warn(`${lf}: ${w}`);
    if (res.malformed) {
      warn(`${lf}: malformed/truncated — file skipped whole, marking degraded`);
      degraded = true;
      continue;
    }
    parsedFiles++;
    for (const rec of res.records) {
      const sf = normalizeSf(rec.sf, repoRoot);
      if (sf === "") continue;
      mergeRecord(merged, sf, rec);
    }
  }
  if (parsedFiles === 0) warn("no lcov.info data merged (zero parseable inputs)");

  // --- JSON metrics: src/ files only ---
  const srcFiles = [...merged.keys()].filter((f) => f.startsWith("src/")).sort();
  const files: Record<string, CovTriple> = {};
  const dirAgg = new Map<string, { lines: number; covered: number }>();
  const lineHits: Record<string, Record<string, number>> = {};
  let totalLines = 0;
  let totalCovered = 0;
  for (const f of srcFiles) {
    const m = merged.get(f)!;
    const lines = m.da.size;
    const covered = [...m.da.values()].filter((h) => h > 0).length;
    files[f] = { lines, covered, pct: pctOf(covered, lines) };
    totalLines += lines;
    totalCovered += covered;
    const dir = topLevelSrcDir(f);
    const agg = dirAgg.get(dir) ?? { lines: 0, covered: 0 };
    agg.lines += lines;
    agg.covered += covered;
    dirAgg.set(dir, agg);
    const hits: Record<string, number> = {};
    for (const line of [...m.da.keys()].sort((a, b) => a - b)) hits[String(line)] = m.da.get(line)!;
    lineHits[f] = hits;
  }
  const dirs: Record<string, CovTriple> = {};
  for (const dir of [...dirAgg.keys()].sort()) {
    const agg = dirAgg.get(dir)!;
    dirs[dir] = { lines: agg.lines, covered: agg.covered, pct: pctOf(agg.covered, agg.lines) };
  }

  const loaded = new Set(srcFiles);
  const neverLoadedFiles = listSrcTsFiles(repoRoot).filter((f) => !loaded.has(f));

  const summary = {
    generatedAt: process.env.GENERATED_AT || new Date().toISOString(),
    corpus: process.env.COVERAGE_CORPUS || "unknown",
    lanes: {
      expected: manifestExpect,
      complete: manifests
        .filter((m) => m.complete === true)
        .map((m) => m.lane)
        .sort(),
    },
    degraded,
    total: { lines: totalLines, covered: totalCovered, pct: pctOf(totalCovered, totalLines) },
    dirs,
    files,
    functionCoverage: "informational" as const,
    neverLoaded: { count: neverLoadedFiles.length, files: neverLoadedFiles },
    lineHits,
  };

  try {
    mkdirSync(dirname(outLcov), { recursive: true });
    mkdirSync(dirname(outJson), { recursive: true });
    writeFileSync(outLcov, emitLcov(merged), "utf8");
    writeFileSync(outJson, JSON.stringify(summary, null, 2) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`merge-lcov: cannot write outputs: ${String(err)}\n`);
    process.exit(2);
  }

  process.stderr.write(
    `merge-lcov: merged ${lcovFiles.length} lcov file(s) (${parsedFiles} parseable) → ` +
      `${srcFiles.length} src file(s), total ${summary.total.pct}% ` +
      `(${totalCovered}/${totalLines} lines), degraded=${degraded}\n`,
  );
}

if (import.meta.main) main();
