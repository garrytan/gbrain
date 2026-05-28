import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const targetDir = process.argv[2] ?? "test";
const allowlistFile = join(root, "scripts", "check-test-isolation.allowlist");

const envMutationRe =
  /process\.env\.[A-Za-z_][A-Za-z_0-9]*[ \t]*=[^=]|process\.env\[[^\]]+\][ \t]*=[^=]|delete[ \t]+process\.env\.|delete[ \t]+process\.env\[|Object\.assign[ \t]*\([ \t]*process\.env|Reflect\.set[ \t]*\([ \t]*process\.env/;
const mockModuleRe = /mock\.module[ \t]*\(/;
const pgliteNewRe = /new PGLiteEngine[ \t]*\(/;
const beforeAllRe = /beforeAll[ \t]*\(/;
const afterAllRe = /afterAll[ \t]*\(/;
const disconnectRe = /\.disconnect[ \t]*\(/;

function toRepoPath(path: string): string {
  return relative(root, path).replace(/\\/g, "/");
}

function readAllowlist(): Set<string> {
  if (!existsSync(allowlistFile)) return new Set();
  return new Set(
    readFileSync(allowlistFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".test.ts") && !entry.endsWith(".serial.test.ts")) {
      const rel = toRepoPath(full);
      if (!rel.includes("/e2e/")) out.push(full);
    }
  }
  return out.sort();
}

function matchingLines(lines: string[], re: RegExp): string[] {
  const out: string[] = [];
  lines.forEach((line, idx) => {
    if (re.test(line)) out.push(`${idx + 1}:${line}`);
  });
  return out;
}

let violations = 0;
let fileCount = 0;
const allowlist = readAllowlist();

function emitViolation(file: string, rule: string, detail: string, lines: string[]) {
  console.log(`ERROR: ${file}`);
  console.log(`       rule ${rule}: ${detail}`);
  for (const line of lines.slice(0, 3)) {
    console.log(`         ${line}`);
  }
  violations++;
}

for (const file of walk(resolve(root, targetDir))) {
  const rel = toRepoPath(file);
  fileCount++;
  if (allowlist.has(rel)) continue;

  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);

  const envLines = matchingLines(lines, envMutationRe);
  if (envLines.length > 0) {
    emitViolation(
      rel,
      "R1",
      "process.env mutation; use withEnv() or rename to *.serial.test.ts",
      envLines,
    );
  }

  const mockLines = matchingLines(lines, mockModuleRe);
  if (mockLines.length > 0) {
    emitViolation(
      rel,
      "R2",
      "mock.module() leaks across files in the shard process; rename to *.serial.test.ts",
      mockLines,
    );
  }

  if (pgliteNewRe.test(content)) {
    let lastBeforeAll = -1000;
    const bad: string[] = [];
    lines.forEach((line, idx) => {
      const lineNo = idx + 1;
      if (beforeAllRe.test(line)) lastBeforeAll = lineNo;
      if (pgliteNewRe.test(line) && lineNo - lastBeforeAll > 50) {
        bad.push(`${lineNo}:${line}`);
      }
    });
    if (bad.length > 0) {
      emitViolation(
        rel,
        "R3",
        "new PGLiteEngine(...) outside beforeAll() context (>50 lines); move into beforeAll",
        bad,
      );
    }

    if (!afterAllRe.test(content) || !disconnectRe.test(content)) {
      emitViolation(
        rel,
        "R4",
        "creates PGLiteEngine but missing afterAll(() => engine.disconnect()); engine leaks across files in the shard process",
        [],
      );
    }
  }
}

if (violations > 0) {
  console.log("");
  console.log(`check-test-isolation: FAIL (${violations} violation(s))`);
  console.log("");
  console.log("Fix:");
  console.log("  - For env mutations, use withEnv() from test/helpers/with-env.ts");
  console.log("  - For mock.module(), rename to *.serial.test.ts (quarantine)");
  console.log("  - For PGLiteEngine, follow the canonical pattern in");
  console.log("    test/helpers/reset-pglite.ts JSDoc and CLAUDE.md.");
  console.log("");
  console.log("Or, if this is a baseline file from before the lint shipped,");
  console.log("add it to scripts/check-test-isolation.allowlist (with a TODO");
  console.log("comment naming the sweep PR that will remove it).");
  process.exit(1);
}

console.log(`check-test-isolation: OK (${fileCount} non-serial unit files scanned)`);
