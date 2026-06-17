#!/usr/bin/env bun
// scripts/select-e2e.ts
//
// Fail-closed diff-based E2E test selector. Reads the working-tree diff vs
// origin/master plus untracked files, classifies the change set as
// EMPTY / DOC_ONLY / SRC, and emits the relevant E2E test files on stdout.
//
// CONTRACT (fail-closed):
//   - When in doubt, run all E2E. The map narrows from "all"; it never widens
//     from "none". An unmapped src/ change emits ALL test/e2e/*.test.ts.
//   - Doc-only diffs emit nothing (the only case where stdout is empty).
//   - Empty diff emits ALL (clean branch shouldn't run nothing).
//
// Selection algorithm:
//   1. Read changed files from three git sources, union them:
//        - git diff --name-only origin/master...HEAD   (committed)
//        - git diff --name-only HEAD                   (unstaged + staged)
//        - git ls-files --others --exclude-standard    (untracked, NOT .gitignore'd)
//   2. EMPTY  -> emit ALL test/e2e/*.test.ts
//      DOC_ONLY (every path matches doc allowlist) -> emit nothing
//      SRC (at least one path is outside doc allowlist):
//        a. Any escape-hatch path matched -> emit ALL
//        b. Else union map matches; include directly-modified test/e2e/*.test.ts
//        c. If still empty -> FAIL-CLOSED -> emit ALL
//
// On git command failure: print error to stderr and exit 2 so callers see the
// failure (xargs -r will run nothing AND the human sees the error).
//
// Usage:
//   bun run scripts/select-e2e.ts
//   bun run scripts/select-e2e.ts | xargs -r bash scripts/run-e2e.sh

import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { E2E_TEST_MAP } from "./e2e-test-map.ts";

// Doc allowlist (inclusive). A path counts as doc-only ONLY if it matches one
// of these patterns. Unrecognized paths fall through to SRC, never silently
// doc-only. skills/ is intentionally NOT here — skills are product input.
const DOC_ROOT_FILES = new Set([
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "TODOS.md",
  "LICENSE",
  "VERSION",
]);

function isDocPath(p: string): boolean {
  if (DOC_ROOT_FILES.has(p)) return true;
  // Any *.md at repo root.
  if (!p.includes("/") && p.endsWith(".md")) return true;
  // Anything under docs/.
  if (p.startsWith("docs/")) return true;
  return false;
}

// Escape-hatch triggers. Any match -> emit ALL.
const ESCAPE_HATCH_FILES = new Set([
  "src/schema.sql",
  "src/core/migrate.ts",
  "src/core/db.ts",
  "src/core/engine-factory.ts",
  "src/core/operations.ts",
  "package.json",
  "bun.lock",
  "Dockerfile.ci",
  "docker-compose.ci.yml",
  "scripts/ci-local.sh",
  "scripts/run-e2e.sh",
  "scripts/select-e2e.ts",
  "scripts/e2e-test-map.ts",
  "test/e2e/helpers.ts",
]);

const ESCAPE_HATCH_PREFIXES = [
  "src/commands/migrations/",
  "test/e2e/fixtures/",
  "skills/",
  ".github/workflows/",
];

function isEscapeHatch(p: string): boolean {
  if (ESCAPE_HATCH_FILES.has(p)) return true;
  for (const prefix of ESCAPE_HATCH_PREFIXES) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

// Minimal glob matcher: supports ** (any segments) and * (one segment, no /).
// Throws on unsupported syntax so map mistakes surface loudly.
export function matchGlob(glob: string, path: string): boolean {
  if (glob.includes("?") || glob.includes("[") || glob.includes("{")) {
    throw new Error(
      `select-e2e: unsupported glob syntax in "${glob}" (only ** and * are supported)`
    );
  }
  // Build a regex: ** -> .*, * -> [^/]*, escape other regex meta-chars.
  let regex = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      regex += ".*";
      i += 2;
    } else if (c === "*") {
      regex += "[^/]*";
      i += 1;
    } else if (/[.+^${}()|\\]/.test(c)) {
      regex += "\\" + c;
      i += 1;
    } else {
      regex += c;
      i += 1;
    }
  }
  return new RegExp("^" + regex + "$").test(path);
}

function listAllE2ETests(repoRoot: string): string[] {
  const dir = join(repoRoot, "test/e2e");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => `test/e2e/${f}`)
    .sort();
}

// Pure function — exposed for unit tests. Decides what to emit given the
// inputs, without touching git or filesystem (callers pass arrays in).
export interface SelectInputs {
  changedFiles: string[]; // union of three git sources
  allE2ETests: string[]; // glob result of test/e2e/*.test.ts
  map: Record<string, string[]>; // E2E_TEST_MAP
}

export type Classification = "EMPTY" | "DOC_ONLY" | "SRC";

export function classify(changedFiles: string[]): Classification {
  if (changedFiles.length === 0) return "EMPTY";
  for (const f of changedFiles) {
    if (!isDocPath(f)) return "SRC";
  }
  return "DOC_ONLY";
}

export function selectTests(inputs: SelectInputs): string[] {
  const { changedFiles, allE2ETests, map } = inputs;
  const cls = classify(changedFiles);
  const allSorted = allE2ETests.slice().sort();

  if (cls === "EMPTY") return allSorted;
  if (cls === "DOC_ONLY") return [];

  // SRC case.
  // 3a. Any escape-hatch -> ALL.
  for (const f of changedFiles) {
    if (isEscapeHatch(f)) return allSorted;
  }

  // 3b. Union map matches; include directly-modified test files.
  const result = new Set<string>();
  for (const f of changedFiles) {
    if (isDocPath(f)) continue;
    // Direct test file modification: include it.
    if (f.startsWith("test/e2e/") && f.endsWith(".test.ts")) {
      result.add(f);
      continue;
    }
    for (const [glob, tests] of Object.entries(map)) {
      if (matchGlob(glob, f)) {
        for (const t of tests) result.add(t);
      }
    }
  }

  // 3c. Fail-closed: if no map entry matched any src/ path AND no test files
  // were directly modified, run everything.
  if (result.size === 0) return allSorted;

  // Sort for determinism (helps tests + readability).
  return Array.from(result).sort();
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    process.stderr.write(
      `select-e2e: git ${args.join(" ")} failed: ${stderr}\n`
    );
    process.exit(2);
  }
  return result.stdout || "";
}

function readChangedFiles(repoRoot: string): string[] {
  const sources = [
    runGit(["diff", "--name-only", "origin/master...HEAD"], repoRoot),
    runGit(["diff", "--name-only", "HEAD"], repoRoot),
    runGit(["ls-files", "--others", "--exclude-standard"], repoRoot),
  ];
  const set = new Set<string>();
  for (const out of sources) {
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) set.add(trimmed);
    }
  }
  return Array.from(set).sort();
}

// Entrypoint. Skipped under test (Bun.main check).
if (import.meta.main) {
  const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).stdout?.trim();
  if (!repoRoot) {
    process.stderr.write("select-e2e: not a git repository\n");
    process.exit(2);
  }

  const changedFiles = readChangedFiles(repoRoot);

  // --classify-only: print EMPTY|DOC_ONLY|SRC + exit. Used by ci-local.sh's
  // Tier 2 fast-path so doc-only diffs skip the unit phase entirely.
  if (process.argv.includes("--classify-only")) {
    process.stdout.write(classify(changedFiles) + "\n");
    process.exit(0);
  }

  const allE2ETests = listAllE2ETests(repoRoot);
  const tests = selectTests({
    changedFiles,
    allE2ETests,
    map: E2E_TEST_MAP,
  });

  process.stdout.write(tests.join(" "));
  if (tests.length > 0) process.stdout.write("\n");
}
