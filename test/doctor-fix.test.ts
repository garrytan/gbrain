/**
 * CLI integration tests for `gbrain doctor --fix` / `--dry-run`.
 * Spawns the actual CLI against tmpdir skill fixtures to prove the
 * arg-parsing wiring and stdout/file-state contract hold end-to-end.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { spawnSync, execSync } from "child_process";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let fixtures: string[] = [];

afterEach(() => {
  for (const f of fixtures) {
    try { rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fixtures = [];
});

function makeGitFixture(skills: Record<string, string>): string {
  // doctor finds repo root by looking for skills/RESOLVER.md — so wrap the
  // fixture in a dir with skills/ inside and a RESOLVER.md stub.
  const root = mkdtempSync(join(tmpdir(), "gbrain-doctorfix-"));
  fixtures.push(root);
  const skillsDir = join(root, "skills");
  mkdirSync(skillsDir, { recursive: true });
  const names = Object.keys(skills);
  const rows = names.map(n => `| "${n}" | \`skills/${n}/SKILL.md\` |`).join("\n");
  writeFileSync(
    join(skillsDir, "RESOLVER.md"),
    `## Test\n| Trigger | Skill |\n|-----|-----|\n${rows}\n`
  );
  writeFileSync(
    join(skillsDir, "manifest.json"),
    JSON.stringify({ skills: names.map(n => ({ name: n, path: `${n}/SKILL.md` })) }, null, 2)
  );
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(join(skillsDir, name), { recursive: true });
    const fm = `---\nname: ${name}\ndescription: test\ntriggers:\n  - "${name}"\n---\n`;
    writeFileSync(join(skillsDir, name, "SKILL.md"), fm + body);
  }
  execSync("git init --quiet", { cwd: root });
  execSync("git config user.email t@t", { cwd: root });
  execSync("git config user.name t", { cwd: root });
  execSync("git add -A && git commit --quiet -m init", { cwd: root });
  return root;
}

function runDoctor(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("bun", [CLI, "doctor", "--fast", ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? -1 };
}

describe("gbrain doctor --fix CLI integration", () => {
  test("--fix --dry-run proposes a fix and does not write", () => {
    const root = makeGitFixture({
      demo: "## Iron Law: Back-Linking (MANDATORY)\n\nbody paragraph.\n",
    });
    const before = readFileSync(join(root, "skills", "demo", "SKILL.md"), "utf-8");
    const { stdout } = runDoctor(root, ["--fix", "--dry-run"]);
    expect(stdout).toContain("[PROPOSED]");
    expect(stdout).toContain("Iron Law back-linking");
    expect(stdout).toContain("Run without --dry-run to apply.");
    const after = readFileSync(join(root, "skills", "demo", "SKILL.md"), "utf-8");
    expect(after).toBe(before);
  });

  test("--fix applies, subsequent --fast run shows no DRY violation for fixed pattern", () => {
    const root = makeGitFixture({
      demo: "## Iron Law: Back-Linking (MANDATORY)\n\nbody.\n",
    });
    const { stdout: fixOut } = runDoctor(root, ["--fix"]);
    expect(fixOut).toContain("[APPLIED]");
    const updated = readFileSync(join(root, "skills", "demo", "SKILL.md"), "utf-8");
    expect(updated).toContain("> **Convention:** See `skills/conventions/quality.md`");
    expect(updated).not.toContain("## Iron Law: Back-Linking");

    // Re-run --fast (not --fix) — commit the fix first so the dirty guard
    // doesn't fire and we're testing detection cleanly.
    execSync("git add -A && git commit --quiet -m fixup", { cwd: root });
    const { stdout: checkOut } = runDoctor(root, ["--json"]);
    const dryCount = (checkOut.match(/"type":"dry_violation"/g) || []).length;
    expect(dryCount).toBe(0);
  });

  test("--fix with nothing to fix prints no-op message", () => {
    const root = makeGitFixture({
      clean: "# CleanSkill\n\nNo cross-cutting patterns here.\n",
    });
    const { stdout } = runDoctor(root, ["--fix"]);
    expect(stdout).toContain("no DRY violations to repair");
  });
});
