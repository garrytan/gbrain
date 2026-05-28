import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { windowsGitBashCandidates } from "../scripts/run-bash.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("run-bash", () => {
  test("derives Git Bash candidates from Git for Windows cmd shim", () => {
    expect(
      windowsGitBashCandidates(
        "C:\\Users\\alice\\AppData\\Local\\Programs\\Git\\cmd\\git.exe",
      ),
    ).toEqual([
      "C:\\Users\\alice\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
      "C:\\Users\\alice\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe",
    ]);
  });

  test("package scripts route direct shell scripts through run-bash", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
    );

    expect(pkg.scripts.verify).toBe(
      "bun run scripts/run-bash.ts scripts/run-verify-parallel.sh",
    );
    expect(pkg.scripts.test).toBe(
      "bun run scripts/run-bash.ts scripts/run-unit-parallel.sh",
    );
    expect(pkg.scripts["check:privacy"]).toBe(
      "bun run scripts/run-bash.ts scripts/check-privacy.sh",
    );
  });
});
