import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const BANNED_NAME = "wintermute";
const BANNED_PATHS = ["/data/brain/", "/data/.openclaw/"];

const ALLOW_LIST = new Set([
  "scripts/check-privacy.sh",
  "scripts/check-privacy.ts",
  "CLAUDE.md",
  "llms-full.txt",
  "docs/UPGRADING_DOWNSTREAM_AGENTS.md",
  "test/integrations.test.ts",
  "docs/GBRAIN_RECOMMENDED_SCHEMA.md",
  "docs/GBRAIN_V0.md",
  "docs/guides/minions-shell-jobs.md",
  "scripts/smoke-test.sh",
  "skills/migrations/v0.9.0.md",
  "skills/migrations/v0.14.0.md",
  "test/storage-status.test.ts",
  "CHANGELOG.md",
  "skills/migrations/v0.25.1.md",
  "test/recency-decay.test.ts",
  "scripts/check-test-real-names.sh",
  "scripts/check-proposal-pii.sh",
  "test/scripts/check-proposal-pii.test.ts",
  "skills/functional-area-resolver/SKILL.md",
  "src/core/skillpack/harvest-lint.ts",
  "test/skillpack-harvest-lint.test.ts",
  "test/skillpack-harvest.test.ts",
  "test/e2e/skillpack-flow.test.ts",
  "skills/skillpack-harvest/SKILL.md",
  "test/eval-replay-gate.test.ts",
]);

function usage(): string {
  return `scripts/check-privacy.sh - scan for the banned OpenClaw fork name.

USAGE:
  scripts/check-privacy.sh           Scan all tracked files in the working tree.
  scripts/check-privacy.sh --staged  Scan only files staged for commit.
  scripts/check-privacy.sh --help    Show this message.
`;
}

function runGit(args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function trackedFiles(mode: "working" | "staged"): string[] {
  const stdout =
    mode === "staged"
      ? runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
      : runGit(["ls-files"]);
  if (stdout === null) {
    console.error("check-privacy: git not found or not a git worktree");
    process.exit(2);
  }
  return stdout.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
}

function shouldScan(file: string): boolean {
  const base = basename(file);
  return (
    /\.(md|ts|mjs|js|py|sh|json|yaml|yml|txt)$/i.test(file) ||
    base.startsWith("README") ||
    base.startsWith("CHANGELOG") ||
    base.startsWith("CLAUDE") ||
    base.startsWith("AGENTS")
  );
}

function matchingLines(content: string, predicate: (line: string) => boolean): string[] {
  const out: string[] = [];
  content.split(/\r?\n/).forEach((line, idx) => {
    if (predicate(line)) out.push(`${idx + 1}:${line}`);
  });
  return out;
}

let mode: "working" | "staged" = "working";
for (const arg of process.argv.slice(2)) {
  if (arg === "--staged") mode = "staged";
  else if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(1);
  } else {
    console.error(`Unknown argument: ${arg}`);
    console.error(usage());
    process.exit(2);
  }
}

let found = false;
for (const file of trackedFiles(mode)) {
  const normalized = file.replace(/\\/g, "/");
  if (!shouldScan(normalized) || ALLOW_LIST.has(normalized)) continue;

  const abs = join(process.cwd(), normalized);
  if (!existsSync(abs) || !statSync(abs).isFile()) continue;

  const content = readFileSync(abs, "utf8");
  const nameMatches = matchingLines(content, (line) =>
    line.toLowerCase().includes(BANNED_NAME),
  );
  if (nameMatches.length > 0) {
    console.error(`[check-privacy] BANNED NAME in ${normalized}:`);
    for (const line of nameMatches) console.error(`  ${line}`);
    found = true;
  }

  for (const bannedPath of BANNED_PATHS) {
    const pathMatches = matchingLines(content, (line) => line.includes(bannedPath));
    if (pathMatches.length > 0) {
      console.error(`[check-privacy] BANNED PATH '${bannedPath}' in ${normalized}:`);
      for (const line of pathMatches) console.error(`  ${line}`);
      found = true;
    }
  }
}

if (found) {
  console.error("");
  console.error("The private OpenClaw fork name is banned in public artifacts.");
  console.error(
    "CLAUDE.md:550. Replace with 'your OpenClaw', 'OpenClaw reference deployment', or 'openclaw-reference'.",
  );
  process.exit(1);
}
