/**
 * ci-cache-hash.test.ts — adversarial coverage of the auto-cache hash.
 *
 * The cache key controls false-pass risk. If a test-affecting file is
 * accidentally deny-listed (or a file change fails to invalidate the
 * hash), broken code ships under a green CI check. This suite is the
 * primary safety net.
 *
 * Strategy: each test spins up a synthetic git repo, copies the
 * ci-cache-hash.sh script in, populates a small file set covering the
 * deny-list edges, runs the script, modifies one file, runs again,
 * asserts hash behavior.
 *
 * Critical invariants (the false-pass guards):
 *   - CLAUDE.md edit → DIFFERENT hash
 *   - AGENTS.md edit → DIFFERENT hash
 *   - skills/foo/SKILL.md edit → DIFFERENT hash
 *   - src/core/db.ts edit → DIFFERENT hash
 *   - test/foo.test.ts edit → DIFFERENT hash
 *
 * Safe deny-list invariants:
 *   - CHANGELOG.md edit → same hash
 *   - README.md edit → same hash
 *   - docs/guide.md edit → same hash
 *   - TODOS.md edit → same hash
 *   - LICENSE edit → same hash
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT_SRC = resolve(REPO_ROOT, "scripts/ci-cache-hash.sh");

interface Sandbox {
  dir: string;
  scriptPath: string;
}

function makeSandbox(files: Record<string, string>): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "ci-cache-hash-"));
  // Init git repo
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });

  // Copy script under scripts/ so cd "$(dirname "$0")/.." lands at sandbox root
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(SCRIPT_SRC, join(dir, "scripts/ci-cache-hash.sh"));

  // Write each fixture file under its declared path
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }

  // Stage + commit so git ls-files returns them
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: dir });

  return { dir, scriptPath: join(dir, "scripts/ci-cache-hash.sh") };
}

function hash(s: Sandbox): string {
  const r = spawnSync("bash", [s.scriptPath], {
    cwd: s.dir,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`ci-cache-hash exit ${r.status}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function modify(s: Sandbox, path: string, content: string) {
  writeFileSync(join(s.dir, path), content);
  // The script reads `git ls-files -s` which reflects the INDEX, not
  // the working tree. Stage + commit so the change is visible to the
  // hash. This matches what CI sees on a checked-out PR (committed
  // tree, not working tree).
  execFileSync("git", ["add", path], { cwd: s.dir });
  execFileSync("git", ["commit", "--quiet", "-m", `modify ${path}`], {
    cwd: s.dir,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Baseline fixtures used across most cases.
// ──────────────────────────────────────────────────────────────────────
const BASELINE_FILES: Record<string, string> = {
  "CHANGELOG.md": "# Changelog\n\n## [1.0.0]\n",
  "TODOS.md": "- [ ] thing\n",
  "README.md": "# Project\n",
  "LICENSE": "MIT\n",
  "CLAUDE.md": "# CLAUDE.md\n\nproject instructions\n",
  "AGENTS.md": "# AGENTS.md\n\nopenclaw entry\n",
  "package.json": '{"name":"test","version":"0.0.0"}\n',
  "bun.lock": "lockfile-v1\n",
  "tsconfig.json": '{"compilerOptions":{"strict":true}}\n',
  "src/core/db.ts": "export const db = 1;\n",
  "src/cli.ts": "console.log('hi');\n",
  "test/foo.test.ts": "import {test} from 'bun:test';\ntest('x', () => {});\n",
  "scripts/check-x.sh": "#!/bin/bash\necho ok\n",
  ".github/workflows/test.yml": "name: Test\n",
  "skills/foo/SKILL.md": "---\nname: foo\n---\nFoo skill\n",
  "docs/guide.md": "# Guide\n",
  "docs/sub/notes.md": "Notes\n",
  "docs/raw.txt": "raw text\n",
};

describe("ci-cache-hash.sh — determinism", () => {
  let sb: Sandbox;
  beforeAll(() => {
    sb = makeSandbox(BASELINE_FILES);
  });
  afterAll(() => {
    if (sb) rmSync(sb.dir, { recursive: true, force: true });
  });

  it("same tree → same hash (run twice)", () => {
    const h1 = hash(sb);
    const h2 = hash(sb);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hash is 16-char lowercase hex", () => {
    const h = hash(sb);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("ci-cache-hash.sh — CRITICAL false-pass guards (must invalidate)", () => {
  // Each test gets its own sandbox so modifications don't leak across cases.

  function withSandbox(test: (sb: Sandbox) => void) {
    const sb = makeSandbox(BASELINE_FILES);
    try {
      test(sb);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  }

  it("CLAUDE.md edit MUST change hash (8+ test files reference it)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "CLAUDE.md", "# CLAUDE.md\n\nNEW INSTRUCTIONS\n");
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });

  it("AGENTS.md edit MUST change hash (resolver tests read it)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "AGENTS.md", "# AGENTS.md\n\nNEW DISPATCH\n");
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });

  it("skills/foo/SKILL.md edit MUST change hash (skill conformance tests)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "skills/foo/SKILL.md", "---\nname: foo\n---\nNEW SKILL BODY\n");
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });

  it("src/core/db.ts edit MUST change hash", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "src/core/db.ts", "export const db = 2;\n");
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });

  it("test/foo.test.ts edit MUST change hash", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(
        sb,
        "test/foo.test.ts",
        "import {test} from 'bun:test';\ntest('y', () => {});\n",
      );
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });

  it("package.json edit MUST change hash", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "package.json", '{"name":"test","version":"0.0.1"}\n');
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });

  it("bun.lock edit MUST change hash (dependency drift catches false-pass)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "bun.lock", "lockfile-v2\n");
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });

  it(".github/workflows/test.yml edit MUST change hash (CI shape change is test-affecting)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, ".github/workflows/test.yml", "name: Test\n# changed\n");
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });
});

describe("ci-cache-hash.sh — SAFE deny-list invariants (must NOT invalidate)", () => {
  function withSandbox(test: (sb: Sandbox) => void) {
    const sb = makeSandbox(BASELINE_FILES);
    try {
      test(sb);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  }

  it("CHANGELOG.md edit produces SAME hash (deny-listed)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "CHANGELOG.md", "# Changelog\n\n## [1.1.0]\nnew release\n");
      const after = hash(sb);
      expect(after).toBe(before);
    });
  });

  it("README.md edit produces SAME hash (deny-listed)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "README.md", "# Project\n\nupdated tagline\n");
      const after = hash(sb);
      expect(after).toBe(before);
    });
  });

  it("TODOS.md edit produces SAME hash (deny-listed)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "TODOS.md", "- [x] thing\n");
      const after = hash(sb);
      expect(after).toBe(before);
    });
  });

  it("LICENSE edit produces SAME hash (deny-listed)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "LICENSE", "Apache-2.0\n");
      const after = hash(sb);
      expect(after).toBe(before);
    });
  });

  it("docs/guide.md edit produces SAME hash (deny-listed via docs/**/*.md)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "docs/guide.md", "# Guide v2\n");
      const after = hash(sb);
      expect(after).toBe(before);
    });
  });

  it("docs/sub/notes.md edit produces SAME hash (nested docs match)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "docs/sub/notes.md", "Updated notes\n");
      const after = hash(sb);
      expect(after).toBe(before);
    });
  });

  it("docs/raw.txt edit produces SAME hash (deny-listed via docs/**/*.txt)", () => {
    withSandbox((sb) => {
      const before = hash(sb);
      modify(sb, "docs/raw.txt", "new raw text\n");
      const after = hash(sb);
      expect(after).toBe(before);
    });
  });
});

describe("ci-cache-hash.sh — edge cases", () => {
  function withSandbox(
    files: Record<string, string>,
    test: (sb: Sandbox) => void,
  ) {
    const sb = makeSandbox(files);
    try {
      test(sb);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  }

  it("untracked file does NOT affect hash (git ls-files only)", () => {
    withSandbox(BASELINE_FILES, (sb) => {
      const before = hash(sb);
      // Write a new file but don't `git add` it.
      writeFileSync(join(sb.dir, "src/untracked.ts"), "const x = 1;\n");
      const after = hash(sb);
      expect(after).toBe(before);
    });
  });

  it("rename detection: same content, new path → DIFFERENT hash", () => {
    withSandbox(BASELINE_FILES, (sb) => {
      const before = hash(sb);
      execFileSync("git", ["mv", "src/cli.ts", "src/main.ts"], { cwd: sb.dir });
      const after = hash(sb);
      // Same content, new path. Our hash includes the path, so it changes.
      // This is correct: a rename can absolutely affect test outcomes
      // (imports change, file resolution changes, etc.).
      expect(after).not.toBe(before);
    });
  });

  it("new file under unknown path (e.g. prompts/x.md) DOES affect hash (deny-list default)", () => {
    withSandbox(BASELINE_FILES, (sb) => {
      const before = hash(sb);
      // Add a NEW file in a path that isn't deny-listed and didn't exist
      // before. Default behavior: include in hash. Closes the "missed file
      // type" false-pass class (e.g. someone adds `prompts/*.md` that
      // tests read).
      mkdirSync(join(sb.dir, "prompts"), { recursive: true });
      writeFileSync(join(sb.dir, "prompts/extract-takes.md"), "system prompt\n");
      execFileSync("git", ["add", "prompts/extract-takes.md"], { cwd: sb.dir });
      execFileSync("git", ["commit", "--quiet", "-m", "add prompts"], {
        cwd: sb.dir,
      });
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });

  it("symlink target change affects hash (git hash-object follows symlink contents)", () => {
    // Note: git stores symlinks as the link target string, so changing
    // the LINK TARGET changes the git blob sha. Our hash will catch
    // that. We can't easily test "change of target's content" without
    // creating an out-of-tree file, so this case pins the link-target
    // path change.
    withSandbox(BASELINE_FILES, (sb) => {
      // Create a symlink and commit.
      symlinkSync("./db.ts", join(sb.dir, "src/core/db-link.ts"));
      execFileSync("git", ["add", "src/core/db-link.ts"], { cwd: sb.dir });
      execFileSync("git", ["commit", "--quiet", "-m", "add link"], {
        cwd: sb.dir,
      });
      const before = hash(sb);
      // Point the symlink elsewhere — and commit so it lands in the
      // index that `git ls-files -s` reads.
      rmSync(join(sb.dir, "src/core/db-link.ts"));
      symlinkSync("./cli.ts", join(sb.dir, "src/core/db-link.ts"));
      execFileSync("git", ["add", "src/core/db-link.ts"], { cwd: sb.dir });
      execFileSync("git", ["commit", "--quiet", "-m", "repoint link"], {
        cwd: sb.dir,
      });
      const after = hash(sb);
      expect(after).not.toBe(before);
    });
  });

  it("locale-stable: LC_ALL=de_DE.UTF-8 produces the same hash as default", () => {
    withSandbox(BASELINE_FILES, (sb) => {
      const defaultHash = spawnSync("bash", [sb.scriptPath], {
        cwd: sb.dir,
        encoding: "utf8",
      }).stdout.trim();
      const altLocale = spawnSync("bash", [sb.scriptPath], {
        cwd: sb.dir,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" },
      }).stdout.trim();
      expect(altLocale).toBe(defaultHash);
    });
  });
});

describe("ci-cache-hash.sh — usage errors", () => {
  it("--bogus arg exits 2", () => {
    const r = spawnSync("bash", [SCRIPT_SRC, "--bogus"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  it("--verbose flag works (writes diagnostics to stderr, hash to stdout)", () => {
    const r = spawnSync("bash", [SCRIPT_SRC, "--verbose"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{16}$/);
    expect(r.stderr).toContain("files in hash");
  });
});
