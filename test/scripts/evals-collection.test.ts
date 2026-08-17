/**
 * Guard for the evals/ → CI-matrix collection (scripts/test-shard.sh).
 *
 * evals/**\/*.test.ts files run in the keyless 10-shard matrix. This repo's
 * eval HARNESSES are key-requiring by default (Anthropic/OpenAI), so a new
 * test file dropped under evals/ could silently start spending tokens in CI
 * or fail keyless. Growth is therefore allowlist-gated: every collected
 * evals file must be named here, and adding one asserts you checked it runs
 * with NO API keys and NO network (mirror of the serial runner's
 * EXCLUSIVE_FILES guard).
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

// Keyless-verified evals test files. Verify before adding:
//   env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY bun test <file>
const KEYLESS_ALLOWLIST = new Set([
  // pure-function scoring/CI-parsing helpers; imports no gateway (verified)
  "evals/functional-area-resolver/harness-runner.test.ts",
]);

describe("evals/ collection into the CI matrix", () => {
  const collected = (): string[] => {
    const lists: string[] = [];
    // Union across all shards = the full collected set.
    for (let i = 1; i <= 10; i++) {
      const out = execFileSync(
        "bash",
        ["scripts/test-shard.sh", "--dry-run-list", String(i), "10"],
        { cwd: REPO_ROOT, encoding: "utf-8" },
      );
      lists.push(out);
    }
    return lists
      .join("\n")
      .split("\n")
      .map((s) => s.trim())
      .filter((f) => f.startsWith("evals/"));
  };

  it("every collected evals file is on the keyless allowlist", () => {
    const files = collected();
    expect(files.length).toBeGreaterThan(0); // the collection itself works
    const unlisted = files.filter((f) => !KEYLESS_ALLOWLIST.has(f));
    expect(unlisted).toEqual([]);
  });

  it("every allowlisted file is actually collected (no dead entries)", () => {
    const files = new Set(collected());
    for (const f of KEYLESS_ALLOWLIST) {
      expect(files.has(f)).toBe(true);
    }
  });
});
