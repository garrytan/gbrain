// render-coverage-summary.test.ts — behavioral, fixture-locked tests for
// scripts/render-coverage-summary.ts (containment-sprint coverage
// machinery). The renderer consumes ONLY the JSON artifact (+ optional
// structural TSV); these tests assert the key markdown lines appear.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStructuralTsv } from "../../scripts/render-coverage-summary.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "render-coverage-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let fixtureSeq = 0;
function writeFixture(name: string, content: string): string {
  const p = join(tmp, `${fixtureSeq++}-${name}`);
  writeFileSync(p, content, "utf8");
  return p;
}

const NEVER_LOADED_FILES = Array.from({ length: 12 }, (_, i) => `src/never/loaded-${String(i).padStart(2, "0")}.ts`);

function summaryFixture(overrides: Record<string, unknown> = {}): string {
  const summary = {
    generatedAt: "2026-08-15T00:00:00.000Z",
    corpus: "prCorpus",
    lanes: { expected: ["shard-1", "serial"], complete: ["shard-1"] },
    degraded: false,
    total: { lines: 200, covered: 124, pct: 62 },
    dirs: {
      src: { lines: 50, covered: 40, pct: 80 },
      "src/core": { lines: 150, covered: 84, pct: 56 },
    },
    files: {
      "src/core/operations.ts": { lines: 100, covered: 10, pct: 10 },
      "src/other-file.ts": { lines: 100, covered: 5, pct: 5 },
    },
    functionCoverage: "informational",
    neverLoaded: { count: 12, files: NEVER_LOADED_FILES },
    ...overrides,
  };
  return writeFixture("summary.json", JSON.stringify(summary, null, 2) + "\n");
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runRender(args: string[]): RunResult {
  const res = Bun.spawnSync(["bun", join(REPO_ROOT, "scripts", "render-coverage-summary.ts"), ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

describe("render: key lines", () => {
  it("prints corpus, lane completeness, totals, dir table, worst files, neverLoaded, cli.ts note", () => {
    const res = runRender(["--summary", summaryFixture()]);
    expect(res.code).toBe(0);
    const out = res.stdout;
    expect(out).toContain("## Coverage summary");
    expect(out).toContain("- Corpus: `prCorpus`");
    expect(out).toContain("Lanes: 1/2 complete");
    expect(out).toContain("Total line coverage: **62%** (124/200 executable lines)");
    expect(out).toContain("Function coverage: informational only");
    expect(out).toContain("| src/core | 150 | 84 | 56% |");
    expect(out).toContain("### Never-loaded src files: 12");
    expect(out).toContain("- src/never/loaded-00.ts");
    expect(out).toContain("+2 more");
    expect(out).toContain("[subprocess-undercount]");
    expect(out).not.toContain("DEGRADED");
  });

  it("prioritizes watchlist files in the worst-covered table", () => {
    // src/core/operations.ts is on the committed watchlist
    // (scripts/coverage-baseline.json); src/other-file.ts is worse (5%) but
    // must sort AFTER the watchlist entry.
    const res = runRender(["--summary", summaryFixture()]);
    const out = res.stdout;
    const opsIdx = out.indexOf("| src/core/operations.ts | 10% | 100 | yes |");
    const otherIdx = out.indexOf("| src/other-file.ts | 5% | 100 |  |");
    expect(opsIdx).toBeGreaterThan(-1);
    expect(otherIdx).toBeGreaterThan(-1);
    expect(opsIdx).toBeLessThan(otherIdx);
  });

  it("prints the DEGRADED banner when the summary is degraded", () => {
    const res = runRender(["--summary", summaryFixture({ degraded: true })]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("**DEGRADED COVERAGE DATA**");
  });
});

describe("render: structural test-intent line", () => {
  const TSV = [
    "# Structural test suites — comment header",
    "# Columns: file\tsuite\tcases\tdetector",
    "test/a.test.ts\tsuite one\t3\treadFileSync",
    "test/b.test.ts\tsuite two\t2\texecSync",
    "",
  ].join("\n");

  it("counts suites and sums cases from the TSV", () => {
    const tsv = writeFixture("structural.tsv", TSV);
    const res = runRender(["--summary", summaryFixture(), "--structural", tsv]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(
      "Behavioral vs structural: structural suites 2 / cases 5 (see scripts/structural-suites.tsv)",
    );
  });

  it("parseStructuralTsv (unit) skips comments and non-numeric cases", () => {
    expect(parseStructuralTsv(TSV)).toEqual({ suites: 2, cases: 5 });
    expect(parseStructuralTsv("# only comments\n")).toEqual({ suites: 0, cases: 0 });
  });
});

describe("render: CLI contract", () => {
  it("missing summary → exit 2", () => {
    const res = runRender(["--summary", join(tmp, "nope.json")]);
    expect(res.code).toBe(2);
  });

  it("missing structural TSV → exit 2", () => {
    const res = runRender(["--summary", summaryFixture(), "--structural", join(tmp, "nope.tsv")]);
    expect(res.code).toBe(2);
  });
});
