// coverage-diff-gate.test.ts — behavioral, fixture-locked tests for
// scripts/coverage-diff-gate.ts (containment-sprint coverage machinery).
//
// The gate's git, classify, and exemption-list inputs are injected via its
// documented test seams (COVERAGE_GATE_DIFF_FILE / COVERAGE_GATE_CLASSIFY /
// COVERAGE_GATE_COMMITS_FILE / COVERAGE_GATE_EXEMPTIONS_OVERRIDE) so every
// test is hermetic: no git calls, no select-e2e subprocess.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGateScopedPath, parseExemptions, parseUnifiedDiff } from "../../scripts/coverage-diff-gate.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Simulates the exemption list AS IT EXISTS ON origin/master (the gate
// resolves the list from master, never the working tree).
const MASTER_EXEMPTIONS =
  [
    "# fixture exemption list (simulated origin/master content)",
    "src/core/postgres-engine.ts",
    "src/core/pglite-engine.ts",
    "src/core/postgres-engine/",
    "src/core/pglite-engine/",
    "src/core/migrate.ts",
    "src/cli.ts",
  ].join("\n") + "\n";

let tmp: string;
let emptyCommitsFile: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "coverage-diff-gate-test-"));
  emptyCommitsFile = join(tmp, "commits-empty.txt");
  writeFileSync(emptyCommitsFile, "feat: something unrelated\n", "utf8");
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

function summaryFixture(overrides: Record<string, unknown> = {}): string {
  const summary = {
    generatedAt: "2026-08-15T00:00:00.000Z",
    corpus: "prCorpus",
    lanes: { expected: [], complete: [] },
    degraded: false,
    total: { lines: 3, covered: 2, pct: 66.67 },
    dirs: { src: { lines: 3, covered: 2, pct: 66.67 } },
    files: { "src/fixture-gate-a.ts": { lines: 3, covered: 2, pct: 66.67 } },
    functionCoverage: "informational",
    neverLoaded: { count: 0, files: [] },
    lineHits: { "src/fixture-gate-a.ts": { "10": 3, "11": 0, "12": 5 } },
    ...overrides,
  };
  return writeFixture("summary.json", JSON.stringify(summary, null, 2) + "\n");
}

function diffHunk(file: string, start: number, count: number): string {
  const added = Array.from({ length: count }, (_, i) => `+line ${start + i}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start - 1},0 +${start},${count} @@`,
    added,
    "",
  ].join("\n");
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGate(opts: {
  summary: string;
  diff: string;
  enforce?: string;
  classify?: string;
  commitsFile?: string;
  exemptions?: string;
}): RunResult {
  const diffFile = writeFixture("diff.patch", opts.diff);
  const res = Bun.spawnSync(["bun", join(REPO_ROOT, "scripts", "coverage-diff-gate.ts"), "--summary", opts.summary], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      COVERAGE_GATE_DIFF_FILE: diffFile,
      COVERAGE_GATE_CLASSIFY: opts.classify ?? "SRC",
      COVERAGE_GATE_COMMITS_FILE: opts.commitsFile ?? emptyCommitsFile,
      COVERAGE_GATE_ENFORCE: opts.enforce ?? "0",
      COVERAGE_GATE_EXEMPTIONS_OVERRIDE: opts.exemptions ?? MASTER_EXEMPTIONS,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

describe("parseUnifiedDiff (unit)", () => {
  it("extracts new-side line numbers per hunk, defaults count to 1, skips deletions", () => {
    const text = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +5,3 @@ ctx",
      "+x",
      "+y",
      "+z",
      "@@ -9,0 +12 @@",
      "+w",
      "@@ -20,4 +20,0 @@", // pure deletion — contributes nothing
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,10 +0,0 @@",
    ].join("\n");
    const parsed = parseUnifiedDiff(text);
    expect(parsed.get("src/a.ts")).toEqual([5, 6, 7, 12]);
    expect(parsed.has("src/gone.ts")).toBe(false);
  });
});

describe("gate scope + exemptions (unit)", () => {
  it("scopes to src/ .ts minus test/generated/declaration files", () => {
    expect(isGateScopedPath("src/core/foo.ts")).toBe(true);
    expect(isGateScopedPath("src/cli.ts")).toBe(true);
    expect(isGateScopedPath("src/core/foo.test.ts")).toBe(false);
    expect(isGateScopedPath("src/core/foo.generated.ts")).toBe(false);
    expect(isGateScopedPath("src/types/foo.d.ts")).toBe(false);
    expect(isGateScopedPath("scripts/foo.ts")).toBe(false);
    expect(isGateScopedPath("test/foo.ts")).toBe(false);
  });

  it("parses exact + directory-prefix exemption entries", () => {
    const ex = parseExemptions("# comment\nsrc/core/migrate.ts\nsrc/core/pglite-engine/\n\n");
    expect(ex.exact.has("src/core/migrate.ts")).toBe(true);
    expect(ex.prefixes).toEqual(["src/core/pglite-engine/"]);
  });
});

describe("verdicts (report-only default)", () => {
  it("covered added lines → WOULD PASS, exit 0", () => {
    // Lines 10 and 12 are covered (hits 3 and 5); line 11 untouched.
    const diff = diffHunk("src/fixture-gate-a.ts", 10, 1) + diffHunk("src/fixture-gate-a.ts", 12, 1);
    const res = runGate({ summary: summaryFixture(), diff });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("WOULD PASS");
    expect(res.stdout).toContain("2/2 = 100.00%");
  });

  it("uncovered added lines below 80% → WOULD FAIL with uncovered line numbers, exit 0", () => {
    const diff = diffHunk("src/fixture-gate-a.ts", 10, 3); // 10 covered, 11 uncovered, 12 covered
    const res = runGate({ summary: summaryFixture(), diff });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("WOULD FAIL");
    expect(res.stdout).toContain("2/3 = 66.67%");
    expect(res.stdout).toContain("L11");
  });

  it("non-executable added lines are excluded from the denominator", () => {
    // Lines 100-102 are absent from DA — non-executable, so 0/0 → vacuous pass.
    const diff = diffHunk("src/fixture-gate-a.ts", 100, 3);
    const res = runGate({ summary: summaryFixture(), diff });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("WOULD PASS");
  });
});

describe("enforcement (COVERAGE_GATE_ENFORCE=1)", () => {
  it("pass → exit 0", () => {
    const diff = diffHunk("src/fixture-gate-a.ts", 10, 1);
    const res = runGate({ summary: summaryFixture(), diff, enforce: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("PASS: changed-line coverage gate.");
  });

  it("fail → exit 1", () => {
    const diff = diffHunk("src/fixture-gate-a.ts", 10, 3);
    const res = runGate({ summary: summaryFixture(), diff, enforce: "1" });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("FAIL");
  });
});

describe("never-loaded files", () => {
  it("a changed file with no coverage record is ONE violation, not a physical-line count", () => {
    const diff = diffHunk("src/fixture-gate-ghost.ts", 1, 50);
    const res = runGate({ summary: summaryFixture(), diff, enforce: "1" });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("never loaded by any test in the PR corpus — add a test that imports it");
    expect(res.stdout).toContain("Never-loaded gate-scoped files: 1");
    // The 50 physical lines must NOT enter the covered/uncovered arithmetic.
    expect(res.stdout).not.toContain("0/50");
  });
});

describe("scope short-circuits", () => {
  it("zero gate-scoped changes → explicit PASS, exit 0", () => {
    const diff =
      diffHunk("src/foo.test.ts", 1, 2) + diffHunk("src/bar.generated.ts", 1, 2) + diffHunk("src/types/x.d.ts", 1, 2);
    const res = runGate({ summary: summaryFixture(), diff, enforce: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("PASS: no gate-scoped changes.");
  });

  it("classify EMPTY / DOC_ONLY → gate not applicable, exit 0 even with uncovered diff", () => {
    const diff = diffHunk("src/fixture-gate-a.ts", 10, 3);
    for (const classify of ["EMPTY", "DOC_ONLY"]) {
      const res = runGate({ summary: summaryFixture(), diff, enforce: "1", classify });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`PASS: change classified ${classify}`);
    }
  });
});

describe("exemptions", () => {
  it("exempt files are reported with their tag but never gated", () => {
    const diff =
      diffHunk("src/core/migrate.ts", 5, 4) +
      diffHunk("src/cli.ts", 5, 4) +
      diffHunk("src/core/postgres-engine/part.ts", 5, 4) +
      diffHunk("src/fixture-gate-a.ts", 10, 1); // covered — keeps the gate scoped
    const res = runGate({ summary: summaryFixture(), diff, enforce: "1" });
    expect(res.code).toBe(0); // exempt uncovered lines don't count
    expect(res.stdout).toContain("| src/core/migrate.ts | 4 | - | - | [e2e-exempt] |");
    expect(res.stdout).toContain("| src/core/postgres-engine/part.ts | 4 | - | - | [e2e-exempt] |");
    expect(res.stdout).toContain("| src/cli.ts | 4 | - | - | [subprocess-undercount] |");
  });

  it("only-exempt changes → no gate-scoped changes, tags still reported", () => {
    const diff = diffHunk("src/core/migrate.ts", 5, 2);
    const res = runGate({ summary: summaryFixture(), diff, enforce: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("PASS: no gate-scoped changes.");
    expect(res.stdout).toContain("[e2e-exempt]");
  });

  it("a working-tree-only exemption entry does NOT exempt (list resolves from origin/master)", () => {
    // Governance: the exemption LIST is read from origin/master, so a PR
    // adding its own file to scripts/coverage-gate-exemptions.txt cannot
    // self-exempt. The seam simulates master's content WITHOUT the entry
    // (deterministic — no dependency on the real origin/master), while the
    // REAL working-tree file temporarily carries the entry; the gate must
    // ignore the working-tree addition (inert until merged).
    const worktreeExemptions = join(REPO_ROOT, "scripts", "coverage-gate-exemptions.txt");
    const original = readFileSync(worktreeExemptions, "utf8");
    writeFileSync(worktreeExemptions, original + "src/fixture-gate-ghost.ts\n", "utf8");
    try {
      const diff = diffHunk("src/fixture-gate-ghost.ts", 1, 5);
      const res = runGate({ summary: summaryFixture(), diff, enforce: "1", exemptions: MASTER_EXEMPTIONS });
      expect(res.code).toBe(1); // never-loaded violation — NOT exempted
      expect(res.stdout).toContain("never loaded by any test in the PR corpus");
      expect(res.stdout).not.toContain("| src/fixture-gate-ghost.ts | 5 | - | - | [e2e-exempt] |");
    } finally {
      writeFileSync(worktreeExemptions, original, "utf8");
    }
  });
});

describe("downgrades + escape hatch", () => {
  it("degraded summary → DEGRADED banner, report-only even when enforcing", () => {
    const diff = diffHunk("src/fixture-gate-a.ts", 10, 3); // would fail
    const res = runGate({ summary: summaryFixture({ degraded: true }), diff, enforce: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("DEGRADED");
    expect(res.stdout).toContain("WOULD FAIL");
  });

  it("[coverage-exempt:] trailer → loud bypass, exit 0 even when enforcing", () => {
    const commits = writeFixture(
      "commits-exempt.txt",
      "fix: emergency hotfix\n\n[coverage-exempt: incident escape hatch]\n",
    );
    const diff = diffHunk("src/fixture-gate-a.ts", 10, 3); // would fail
    const res = runGate({ summary: summaryFixture(), diff, enforce: "1", commitsFile: commits });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("BYPASSED");
    expect(res.stdout).toContain("WARNING");
  });
});

describe("infrastructure errors", () => {
  it("missing summary JSON → exit 2", () => {
    const res = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "scripts", "coverage-diff-gate.ts"), "--summary", join(tmp, "nope.json")],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, COVERAGE_GATE_CLASSIFY: "SRC" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr.toString()).toContain("infrastructure error");
  });

  it("missing --summary flag → exit 2", () => {
    const res = Bun.spawnSync(["bun", join(REPO_ROOT, "scripts", "coverage-diff-gate.ts")], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode).toBe(2);
  });
});
