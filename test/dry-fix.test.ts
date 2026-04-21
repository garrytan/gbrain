import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  autoFixDryViolations,
  isInsideCodeFence,
  detectBlockShape,
  expandBullet,
  expandBlockquote,
  expandParagraph,
} from "../src/core/dry-fix.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixtures: string[] = [];

afterEach(() => {
  for (const f of fixtures) {
    try { rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fixtures = [];
});

function makeSkillsFixture(files: Record<string, string>, opts: { gitInit?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gbrain-dryfix-"));
  fixtures.push(dir);
  const skillNames = Object.keys(files);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ skills: skillNames.map(n => ({ name: n, path: `${n}/SKILL.md` })) }, null, 2)
  );
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), body);
  }
  if (opts.gitInit) {
    execSync("git init --quiet", { cwd: dir });
    execSync("git config user.email test@test", { cwd: dir });
    execSync("git config user.name test", { cwd: dir });
    execSync("git add -A && git commit --quiet -m init", { cwd: dir });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Pure function tests: expanders and guards
// ---------------------------------------------------------------------------

describe("detectBlockShape", () => {
  test("bullet with dash", () => {
    expect(detectBlockShape(["- a bullet"], 0)).toBe("bullet");
  });
  test("bullet with numeric", () => {
    expect(detectBlockShape(["1. numbered"], 0)).toBe("bullet");
  });
  test("indented bullet", () => {
    expect(detectBlockShape(["  - nested"], 0)).toBe("bullet");
  });
  test("blockquote", () => {
    expect(detectBlockShape(["> quoted"], 0)).toBe("blockquote");
  });
  test("paragraph default", () => {
    expect(detectBlockShape(["plain text"], 0)).toBe("paragraph");
  });
});

describe("expandBullet", () => {
  test("single-line bullet", () => {
    const lines = ["before", "", "- single bullet", "", "after"];
    const block = expandBullet(lines, 2);
    expect(block).toEqual({ startLine: 2, endLine: 2 });
  });

  test("bullet with sub-bullets", () => {
    const lines = [
      "- top-level bullet",
      "  - sub one",
      "  - sub two",
      "- next sibling",
    ];
    const block = expandBullet(lines, 0);
    expect(block).toEqual({ startLine: 0, endLine: 2 });
  });

  test("stops at blank line", () => {
    const lines = ["- item", "continuation", "", "- next"];
    const block = expandBullet(lines, 0);
    expect(block).toEqual({ startLine: 0, endLine: 1 });
  });
});

describe("expandBlockquote", () => {
  test("contiguous quote lines", () => {
    const lines = ["> line 1", "> line 2", "not quote"];
    const block = expandBlockquote(lines, 0);
    expect(block).toEqual({ startLine: 0, endLine: 1 });
  });

  test("returns null for Convention callout (don't rewrite reference)", () => {
    const lines = ["> **Convention:** See `skills/conventions/quality.md`."];
    expect(expandBlockquote(lines, 0)).toBeNull();
  });

  test("returns null for Filing rule callout", () => {
    const lines = ["> **Filing rule:** Read `skills/_brain-filing-rules.md`."];
    expect(expandBlockquote(lines, 0)).toBeNull();
  });
});

describe("expandParagraph", () => {
  test("expands to blank boundaries", () => {
    const lines = ["", "line a", "line b", "", "other"];
    const block = expandParagraph(lines, 1);
    expect(block).toEqual({ startLine: 1, endLine: 2 });
  });

  test("handles start of file", () => {
    const lines = ["first line", "second", ""];
    const block = expandParagraph(lines, 0);
    expect(block).toEqual({ startLine: 0, endLine: 1 });
  });
});

describe("isInsideCodeFence", () => {
  test("inside fenced block", () => {
    const content = "pre\n```\nfenced notability gate\n```\npost\n";
    const offset = content.indexOf("fenced notability");
    expect(isInsideCodeFence(content, offset)).toBe(true);
  });

  test("outside fenced block", () => {
    const content = "notability gate\n```\ncode\n```\n";
    const offset = content.indexOf("notability");
    expect(isInsideCodeFence(content, offset)).toBe(false);
  });

  test("after closed fence (regression guard)", () => {
    const content = "```\nexample\n```\n\nreal notability gate here\n";
    const offset = content.indexOf("real notability");
    expect(isInsideCodeFence(content, offset)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: autoFixDryViolations
// ---------------------------------------------------------------------------

describe("autoFixDryViolations", () => {
  test("replaces paragraph-form heading (Iron Law)", () => {
    const dir = makeSkillsFixture({
      a: "# A\n\n## Iron Law: Back-Linking (MANDATORY)\n\nbody text.\n",
    }, { gitInit: true });
    const report = autoFixDryViolations(dir);
    expect(report.fixed).toHaveLength(1);
    expect(report.fixed[0].status).toBe("applied");
    const updated = readFileSync(join(dir, "a", "SKILL.md"), "utf-8");
    expect(updated).toContain("> **Convention:** See `skills/conventions/quality.md`");
    expect(updated).not.toContain("## Iron Law: Back-Linking");
  });

  test("replaces bullet-item inlined rule", () => {
    const dir = makeSkillsFixture({
      b: "# B\n\n- First\n- Check the notability gate before creating a page\n- Last\n",
    }, { gitInit: true });
    const report = autoFixDryViolations(dir);
    expect(report.fixed).toHaveLength(1);
    const updated = readFileSync(join(dir, "b", "SKILL.md"), "utf-8");
    expect(updated).toContain("> **Convention:** See `skills/conventions/quality.md`");
    expect(updated).toContain("- First"); // surrounding bullets preserved
    expect(updated).toContain("- Last");
  });

  test("does NOT rewrite a Convention callout (block_is_callout)", () => {
    const dir = makeSkillsFixture({
      c: "> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking rules.\n",
    }, { gitInit: true });
    const report = autoFixDryViolations(dir);
    // proximity suppression means no violation to fix in the first place
    expect(report.fixed).toHaveLength(0);
  });

  test("skips match inside fenced code block", () => {
    const dir = makeSkillsFixture({
      d: "# D\n\nExample:\n```\n## Iron Law: Back-Linking (MANDATORY)\n```\ntext.\n",
    }, { gitInit: true });
    const report = autoFixDryViolations(dir);
    const sk = report.skipped.find(s => s.reason === "inside_code_fence");
    expect(sk).toBeDefined();
    expect(report.fixed).toHaveLength(0);
  });

  test("skips when pattern matches more than once", () => {
    const dir = makeSkillsFixture({
      e: "## Iron Law: Back-Linking (MANDATORY)\n\nThe Iron Law Back-Link applies to every entity.\n",
    }, { gitInit: true });
    const report = autoFixDryViolations(dir);
    const sk = report.skipped.find(s => s.reason === "ambiguous_multiple_matches");
    expect(sk).toBeDefined();
  });

  test("skips when delegation already within 10 lines (idempotent)", () => {
    const dir = makeSkillsFixture({
      f: "> **Convention:** See `skills/conventions/quality.md`.\n\nCheck the notability gate.\n",
    }, { gitInit: true });
    const report = autoFixDryViolations(dir);
    const sk = report.skipped.find(s => s.reason === "already_delegated");
    expect(sk).toBeDefined();
    expect(report.fixed).toHaveLength(0);
  });

  test("skips when working tree is dirty", () => {
    const dir = makeSkillsFixture({
      g: "## Iron Law: Back-Linking (MANDATORY)\n\nbody.\n",
    }, { gitInit: true });
    // dirty the file: add another line post-commit
    const p = join(dir, "g", "SKILL.md");
    writeFileSync(p, readFileSync(p, "utf-8") + "\nextra edit\n");
    const report = autoFixDryViolations(dir);
    const sk = report.skipped.find(s => s.reason === "working_tree_dirty");
    expect(sk).toBeDefined();
    // file unchanged
    expect(readFileSync(p, "utf-8")).toContain("## Iron Law: Back-Linking");
  });

  test("refuses to write when skill is NOT inside a git repo (no_git_backup)", () => {
    // no gitInit — writing would destroy user data with no rollback
    const dir = makeSkillsFixture({
      ng: "## Iron Law: Back-Linking (MANDATORY)\n\nbody.\n",
    }, { gitInit: false });
    const p = join(dir, "ng", "SKILL.md");
    const before = readFileSync(p, "utf-8");
    const report = autoFixDryViolations(dir);
    const sk = report.skipped.find(s => s.reason === "no_git_backup");
    expect(sk).toBeDefined();
    expect(report.fixed).toHaveLength(0);
    expect(readFileSync(p, "utf-8")).toBe(before);
  });

  test("preserves trailing newline when block is at EOF", () => {
    const dir = makeSkillsFixture({
      eof: "## Iron Law: Back-Linking (MANDATORY)\n",
    }, { gitInit: true });
    const report = autoFixDryViolations(dir);
    expect(report.fixed).toHaveLength(1);
    const after = readFileSync(join(dir, "eof", "SKILL.md"), "utf-8");
    expect(after.endsWith("\n")).toBe(true);
  });

  test("dry-run mode does not write files", () => {
    const dir = makeSkillsFixture({
      h: "# H\n\n## Iron Law: Back-Linking (MANDATORY)\n\nbody.\n",
    }, { gitInit: true });
    const before = readFileSync(join(dir, "h", "SKILL.md"), "utf-8");
    const report = autoFixDryViolations(dir, { dryRun: true });
    expect(report.fixed).toHaveLength(1);
    expect(report.fixed[0].status).toBe("proposed");
    const after = readFileSync(join(dir, "h", "SKILL.md"), "utf-8");
    expect(after).toBe(before);
  });

  test("ENOENT on skill file does not crash", () => {
    const dir = makeSkillsFixture({
      i: "## Iron Law: Back-Linking (MANDATORY)\n",
    }, { gitInit: true });
    // remove the skill file after fixture creation but before fix runs
    rmSync(join(dir, "i", "SKILL.md"));
    const report = autoFixDryViolations(dir);
    // file_missing is silently skipped (already reported as missing_file elsewhere)
    expect(report.fixed).toHaveLength(0);
  });

  test("notability gate accepts _brain-filing-rules.md as delegation", () => {
    const dir = makeSkillsFixture({
      j: "> **Filing rule:** Read `skills/_brain-filing-rules.md`.\n\nCheck the notability gate.\n",
    }, { gitInit: true });
    const report = autoFixDryViolations(dir);
    // suppressed by proximity + filing-rule delegation
    expect(report.fixed).toHaveLength(0);
  });
});
