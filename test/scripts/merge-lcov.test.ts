// merge-lcov.test.ts — behavioral, fixture-locked tests for
// scripts/merge-lcov.ts (containment-sprint coverage machinery).
//
// Fixtures are inline synthetic lcov strings written into tmp lane dirs;
// the script runs as a subprocess from the repo root (SF normalization and
// the neverLoaded scan resolve against process.cwd()).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isMergedArtifactPath, normalizeSf, parseLcovText } from "../../scripts/merge-lcov.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runMerge(args: string[], env: Record<string, string> = {}): RunResult {
  const res = Bun.spawnSync(["bun", join(REPO_ROOT, "scripts", "merge-lcov.ts"), ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, GENERATED_AT: "2026-08-15T00:00:00.000Z", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "merge-lcov-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function laneDir(name: string, lcovText: string, manifest?: object): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lcov.info"), lcovText, "utf8");
  if (manifest) writeFileSync(join(dir, "lane-manifest.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

function outPaths(name: string): { lcov: string; json: string } {
  return { lcov: join(tmp, `${name}.lcov.info`), json: join(tmp, `${name}.json`) };
}

interface SummaryShape {
  generatedAt: string;
  corpus: string;
  lanes: { expected: string[]; complete: string[] };
  degraded: boolean;
  total: { lines: number; covered: number; pct: number };
  dirs: Record<string, { lines: number; covered: number; pct: number }>;
  files: Record<string, { lines: number; covered: number; pct: number }>;
  functionCoverage: string;
  neverLoaded: { count: number; files: string[] };
  lineHits: Record<string, Record<string, number>>;
}

function readSummary(path: string): SummaryShape {
  return JSON.parse(readFileSync(path, "utf8")) as SummaryShape;
}

const LANE_A = [
  "TN:",
  "SF:src/fixture-cov-a.ts",
  "FN:1,alpha",
  "FNDA:2,alpha",
  "DA:1,1",
  "DA:2,0",
  "DA:3,5",
  "LF:3",
  "LH:2",
  "end_of_record",
  "",
].join("\n");

const LANE_B = [
  "TN:",
  "SF:src/fixture-cov-a.ts",
  "FN:1,alpha",
  "FNDA:3,alpha",
  "DA:1,2",
  "DA:2,0",
  "DA:4,7",
  "end_of_record",
  "",
].join("\n");

describe("merge: DA summing across lanes", () => {
  it("sums per-line hits, unions lines, regenerates counters", () => {
    const a = laneDir("sum-a", LANE_A);
    const b = laneDir("sum-b", LANE_B);
    const out = outPaths("sum");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, a, b]);
    expect(res.code).toBe(0);

    const lcov = readFileSync(out.lcov, "utf8");
    expect(lcov).toContain("SF:src/fixture-cov-a.ts");
    expect(lcov).toContain("DA:1,3"); // 1 + 2
    expect(lcov).toContain("DA:2,0"); // 0 + 0
    expect(lcov).toContain("DA:3,5"); // lane A only
    expect(lcov).toContain("DA:4,7"); // lane B only
    expect(lcov).toContain("FNDA:5,alpha"); // 2 + 3 summed per function name
    expect(lcov).toContain("FNF:1");
    expect(lcov).toContain("FNH:1");
    expect(lcov).toContain("LF:4");
    expect(lcov).toContain("LH:3");

    const json = readSummary(out.json);
    expect(json.files["src/fixture-cov-a.ts"]).toEqual({ lines: 4, covered: 3, pct: 75 });
    expect(json.lineHits["src/fixture-cov-a.ts"]).toEqual({ "1": 3, "2": 0, "3": 5, "4": 7 });
    expect(json.degraded).toBe(false);
    expect(json.functionCoverage).toBe("informational");
    expect(json.generatedAt).toBe("2026-08-15T00:00:00.000Z");
  });

  it("honors COVERAGE_CORPUS and defaults to 'unknown'", () => {
    const a = laneDir("corpus-a", LANE_A);
    const out = outPaths("corpus");
    runMerge(["--out-lcov", out.lcov, "--out-json", out.json, a], { COVERAGE_CORPUS: "prCorpus" });
    expect(readSummary(out.json).corpus).toBe("prCorpus");

    const out2 = outPaths("corpus2");
    const res = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "scripts", "merge-lcov.ts"), "--out-lcov", out2.lcov, "--out-json", out2.json, a],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, COVERAGE_CORPUS: "", GENERATED_AT: "2026-08-15T00:00:00.000Z" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(res.exitCode).toBe(0);
    expect(readSummary(out2.json).corpus).toBe("unknown");
  });
});

describe("merge: SF normalization", () => {
  it("merges absolute, repo-relative, and foreign-checkout-prefix SF paths into one record", () => {
    const abs = [
      `SF:${REPO_ROOT}/src/fixture-cov-n.ts`,
      "DA:1,1",
      "end_of_record",
      "",
    ].join("\n");
    const rel = ["SF:src/fixture-cov-n.ts", "DA:1,1", "DA:2,4", "end_of_record", ""].join("\n");
    const foreign = [
      `SF:/ci/runner/work/${basename(REPO_ROOT)}/src/fixture-cov-n.ts`,
      "DA:1,1",
      "end_of_record",
      "",
    ].join("\n");
    const a = laneDir("norm-a", abs);
    const b = laneDir("norm-b", rel);
    const c = laneDir("norm-c", foreign);
    const out = outPaths("norm");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, a, b, c]);
    expect(res.code).toBe(0);

    const json = readSummary(out.json);
    expect(Object.keys(json.files)).toEqual(["src/fixture-cov-n.ts"]);
    // 1+1+1 on line 1, 4 on line 2 — all three spellings merged.
    expect(json.lineHits["src/fixture-cov-n.ts"]).toEqual({ "1": 3, "2": 4 });
    const lcov = readFileSync(out.lcov, "utf8");
    expect(lcov.match(/^SF:/gm)?.length).toBe(1);
  });

  it("normalizeSf unit: strips cwd, strips any prefix ending in the repo dir name, keeps relatives", () => {
    expect(normalizeSf(`${REPO_ROOT}/src/a.ts`, REPO_ROOT)).toBe("src/a.ts");
    expect(normalizeSf(`/ci/work/${basename(REPO_ROOT)}/src/a.ts`, REPO_ROOT)).toBe("src/a.ts");
    expect(normalizeSf("src/a.ts", REPO_ROOT)).toBe("src/a.ts");
    expect(normalizeSf("./src/a.ts", REPO_ROOT)).toBe("src/a.ts");
    expect(normalizeSf("/somewhere/else/src/a.ts", REPO_ROOT)).toBe("/somewhere/else/src/a.ts");
  });
});

describe("merge: malformed input handling", () => {
  it("skips a malformed lcov file whole and marks degraded, keeping the good lane", () => {
    const good = laneDir("mal-good", LANE_A);
    const bad = laneDir("mal-bad", "DA:1,1\n"); // DA outside any SF record
    const out = outPaths("mal");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, good, bad]);
    expect(res.code).toBe(0); // never aborts
    expect(res.stderr).toContain("malformed");
    const json = readSummary(out.json);
    expect(json.degraded).toBe(true);
    expect(json.files["src/fixture-cov-a.ts"]).toEqual({ lines: 3, covered: 2, pct: 66.67 });
  });

  it("treats a truncated file (SF without end_of_record) as malformed", () => {
    const bad = laneDir("trunc-bad", "SF:src/fixture-trunc.ts\nDA:1,1\n");
    const out = outPaths("trunc");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, bad]);
    expect(res.code).toBe(0);
    const json = readSummary(out.json);
    expect(json.degraded).toBe(true);
    expect(json.files["src/fixture-trunc.ts"]).toBeUndefined(); // whole file skipped
  });

  it("parseLcovText unit: unknown record types warn and are skipped without malforming", () => {
    const res = parseLcovText("SF:src/x.ts\nBRDA:1,0,0,1\nDA:1,1\nend_of_record\n");
    expect(res.malformed).toBe(false);
    expect(res.warnings.some((w) => w.includes("BRDA"))).toBe(true);
    expect(res.records[0]?.da).toEqual([[1, 1]]);
  });

  it("parseLcovText unit: non-numeric DA is malformed", () => {
    const res = parseLcovText("SF:src/x.ts\nDA:one,1\nend_of_record\n");
    expect(res.malformed).toBe(true);
    expect(res.records).toEqual([]);
  });
});

describe("merge: lane manifests", () => {
  const GOOD_MANIFEST = { lane: "shard-1", sha: "deadbeef", lcovCount: 1, complete: true };

  it("complete expected lanes → not degraded; lanes.complete lists them", () => {
    const a = laneDir("man-ok", LANE_A, GOOD_MANIFEST);
    const out = outPaths("man-ok");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, "--manifest-expect", "shard-1", a]);
    expect(res.code).toBe(0);
    const json = readSummary(out.json);
    expect(json.degraded).toBe(false);
    expect(json.lanes.expected).toEqual(["shard-1"]);
    expect(json.lanes.complete).toEqual(["shard-1"]);
  });

  it("missing manifest for an expected lane → degraded", () => {
    const a = laneDir("man-miss", LANE_A, GOOD_MANIFEST);
    const out = outPaths("man-miss");
    const res = runMerge([
      "--out-lcov", out.lcov, "--out-json", out.json,
      "--manifest-expect", "shard-1,serial", a,
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("serial");
    const json = readSummary(out.json);
    expect(json.degraded).toBe(true);
    expect(json.lanes.expected).toEqual(["shard-1", "serial"]);
    expect(json.lanes.complete).toEqual(["shard-1"]);
  });

  it("incomplete manifest for an expected lane → degraded", () => {
    const a = laneDir("man-inc", LANE_A, { ...GOOD_MANIFEST, complete: false });
    const out = outPaths("man-inc");
    runMerge(["--out-lcov", out.lcov, "--out-json", out.json, "--manifest-expect", "shard-1", a]);
    const json = readSummary(out.json);
    expect(json.degraded).toBe(true);
    expect(json.lanes.complete).toEqual([]);
  });

  it("shard manifest with lcovCount != 1 → degraded (xargs-batching tripwire)", () => {
    const a = laneDir("man-two", LANE_A, { ...GOOD_MANIFEST, lcovCount: 2 });
    const out = outPaths("man-two");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, "--manifest-expect", "shard-1", a]);
    expect(res.stderr).toContain("lcovCount=2");
    expect(readSummary(out.json).degraded).toBe(true);
  });

  it("non-shard lane may carry many lcov files without tripping the tripwire", () => {
    const a = laneDir("man-serial", LANE_A, { lane: "serial", sha: "d", lcovCount: 12, complete: true });
    const out = outPaths("man-serial");
    runMerge(["--out-lcov", out.lcov, "--out-json", out.json, "--manifest-expect", "serial", a]);
    expect(readSummary(out.json).degraded).toBe(false);
  });
});

describe("merge: JSON metrics scope + hand-computed totals", () => {
  const LANE_C = [
    "SF:src/fixture-tot-one.ts",
    "DA:1,1",
    "DA:2,0",
    "end_of_record",
    "SF:src/core/fixture-tot-two.ts",
    "DA:10,3",
    "DA:11,1",
    "DA:12,0",
    "end_of_record",
    "SF:test/fixture-tot.test.ts",
    "DA:1,1",
    "end_of_record",
    "SF:scripts/fixture-tot-tool.ts",
    "DA:1,1",
    "end_of_record",
    "",
  ].join("\n");

  it("totals/dirs/files count src/ only; out-lcov keeps every record", () => {
    const c = laneDir("tot-c", LANE_C);
    const out = outPaths("tot");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, c]);
    expect(res.code).toBe(0);

    const json = readSummary(out.json);
    // Hand-computed: src lines 2+3=5, covered 1+2=3 → 60%.
    expect(json.total).toEqual({ lines: 5, covered: 3, pct: 60 });
    expect(json.dirs["src"]).toEqual({ lines: 2, covered: 1, pct: 50 });
    expect(json.dirs["src/core"]).toEqual({ lines: 3, covered: 2, pct: 66.67 });
    expect(Object.keys(json.files).sort()).toEqual([
      "src/core/fixture-tot-two.ts",
      "src/fixture-tot-one.ts",
    ]);
    expect(json.lineHits["test/fixture-tot.test.ts"]).toBeUndefined();

    // Non-src records stay in the merged lcov artifact.
    const lcov = readFileSync(out.lcov, "utf8");
    expect(lcov).toContain("SF:test/fixture-tot.test.ts");
    expect(lcov).toContain("SF:scripts/fixture-tot-tool.ts");
  });

  it("neverLoaded inventories real src files absent from the data — count + sorted list, no percentage", () => {
    const c = laneDir("never-c", LANE_C);
    const out = outPaths("never");
    runMerge(["--out-lcov", out.lcov, "--out-json", out.json, c]);
    const json = readSummary(out.json);
    // The fixture files are "loaded" (present in data); every real src file is not.
    expect(json.neverLoaded.count).toBe(json.neverLoaded.files.length);
    expect(json.neverLoaded.files).toContain("src/cli.ts");
    expect(json.neverLoaded.files).not.toContain("src/fixture-tot-one.ts");
    const sorted = [...json.neverLoaded.files].sort();
    expect(json.neverLoaded.files).toEqual(sorted);
    expect(json.neverLoaded.files.every((f) => !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))).toBe(true);
  });
});

describe("merge: self-merge guard (coverage-merged exclusion)", () => {
  it("skips lcov.info under a coverage-merged path segment without degrading", () => {
    // CI report-job re-runs download the PRIOR run's own coverage-merged
    // artifact via the coverage-* glob; re-merging it would double every hit
    // count. The guard drops it while keeping real lanes.
    laneDir("selfmerge/lane-a", LANE_A);
    laneDir(
      "selfmerge/coverage-merged",
      ["SF:src/fixture-prior-merged.ts", "DA:1,100", "end_of_record", ""].join("\n"),
    );
    const out = outPaths("selfmerge");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, join(tmp, "selfmerge")]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("self-merge guard");
    const json = readSummary(out.json);
    expect(json.files["src/fixture-prior-merged.ts"]).toBeUndefined(); // prior artifact dropped
    expect(json.files["src/fixture-cov-a.ts"]).toEqual({ lines: 3, covered: 2, pct: 66.67 }); // real lane kept
    expect(json.degraded).toBe(false); // expected on re-runs, not data loss
  });

  it("skips a direct lcov.info FILE input under a coverage-merged segment", () => {
    laneDir("selfmerge-direct/coverage-merged", LANE_A);
    const a = laneDir("selfmerge-direct/lane-a", LANE_A);
    const out = outPaths("selfmerge-direct");
    const res = runMerge([
      "--out-lcov", out.lcov, "--out-json", out.json,
      join(tmp, "selfmerge-direct", "coverage-merged", "lcov.info"),
      a,
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("self-merge guard");
    // Only the real lane merged: hits are lane-A's alone, not doubled.
    expect(readSummary(out.json).lineHits["src/fixture-cov-a.ts"]).toEqual({ "1": 1, "2": 0, "3": 5 });
  });

  it("isMergedArtifactPath unit: matches a path SEGMENT, not a substring", () => {
    expect(isMergedArtifactPath("/dl/coverage-merged/lcov.info")).toBe(true);
    expect(isMergedArtifactPath("dl/coverage-merged/nested/lcov.info")).toBe(true);
    expect(isMergedArtifactPath("/dl/coverage-merged-old/lcov.info")).toBe(false);
    expect(isMergedArtifactPath("/dl/coverage-shard1/lcov.info")).toBe(false);
  });
});

describe("merge: CLI contract", () => {
  it("missing required args → exit 2", () => {
    const res = runMerge(["--out-lcov", join(tmp, "x.lcov")]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage");
  });

  it("nonexistent input path warns and marks degraded, never aborts", () => {
    const a = laneDir("ghost-a", LANE_A);
    const out = outPaths("ghost");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, a, join(tmp, "does-not-exist")]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("not found");
    expect(readSummary(out.json).degraded).toBe(true);
  });
});
