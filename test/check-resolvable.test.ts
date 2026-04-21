import { describe, test, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  checkResolvable,
  parseResolverEntries,
  extractDelegationTargets,
} from "../src/core/check-resolvable.ts";

const SKILLS_DIR = join(import.meta.dir, "..", "skills");

describe("parseResolverEntries", () => {
  test("extracts skill paths from markdown table rows", () => {
    const content = `## Brain operations
| Trigger | Skill |
|---------|-------|
| "What do we know about" | \`skills/query/SKILL.md\` |
| Creating a person page | \`skills/enrich/SKILL.md\` |`;
    const entries = parseResolverEntries(content);
    expect(entries.length).toBe(2);
    expect(entries[0].skillPath).toBe("skills/query/SKILL.md");
    expect(entries[0].section).toBe("Brain operations");
    expect(entries[1].skillPath).toBe("skills/enrich/SKILL.md");
  });

  test("handles GStack entries (external skills)", () => {
    const content = `## Thinking skills
| Trigger | Skill |
|---------|-------|
| "Brainstorm" | GStack: office-hours |`;
    const entries = parseResolverEntries(content);
    expect(entries.length).toBe(1);
    expect(entries[0].isGStack).toBe(true);
  });

  test("handles identity/access rows (non-skill references)", () => {
    const content = `## Identity
| Trigger | Skill |
|---------|-------|
| Non-owner sends a message | Check \`ACCESS_POLICY.md\` before responding |`;
    const entries = parseResolverEntries(content);
    expect(entries.length).toBe(1);
    expect(entries[0].isGStack).toBe(true);
  });

  test("skips separator and header rows", () => {
    const content = `| Trigger | Skill |
|---------|-------|
| "query" | \`skills/query/SKILL.md\` |`;
    const entries = parseResolverEntries(content);
    expect(entries.length).toBe(1);
  });

  test("tracks section headings", () => {
    const content = `## Always-on
| Trigger | Skill |
|---------|-------|
| Every message | \`skills/signal-detector/SKILL.md\` |

## Brain operations
| Trigger | Skill |
|---------|-------|
| "What do we know" | \`skills/query/SKILL.md\` |`;
    const entries = parseResolverEntries(content);
    expect(entries[0].section).toBe("Always-on");
    expect(entries[1].section).toBe("Brain operations");
  });
});

describe("checkResolvable — real skills directory", () => {
  const report = checkResolvable(SKILLS_DIR);

  test("produces a report with summary", () => {
    expect(report.summary.total_skills).toBeGreaterThan(0);
    expect(typeof report.ok).toBe("boolean");
    expect(Array.isArray(report.issues)).toBe(true);
  });

  test("all manifest skills are reachable from RESOLVER.md", () => {
    const unreachableIssues = report.issues.filter(i => i.type === "unreachable");
    if (unreachableIssues.length > 0) {
      const names = unreachableIssues.map(i => i.skill).join(", ");
      console.warn(`Unreachable skills: ${names}`);
    }
    // Currently expect all 24 skills to be reachable
    expect(report.summary.unreachable).toBe(0);
  });

  test("no missing files referenced by RESOLVER.md", () => {
    const missingFiles = report.issues.filter(i => i.type === "missing_file");
    expect(missingFiles.length).toBe(0);
  });

  test("no orphan triggers (in resolver but not manifest)", () => {
    const orphans = report.issues.filter(i => i.type === "orphan_trigger");
    expect(orphans.length).toBe(0);
  });

  test("action strings are specific (contain file paths)", () => {
    for (const issue of report.issues) {
      expect(issue.action.length).toBeGreaterThan(10);
      // Action should mention a file or a specific fix
      expect(
        issue.action.includes("RESOLVER.md") ||
        issue.action.includes("SKILL.md") ||
        issue.action.includes("manifest") ||
        issue.action.includes("conventions/")
      ).toBe(true);
    }
  });

  test("unreachable issues have structured fix objects", () => {
    const unreachable = report.issues.filter(i => i.type === "unreachable");
    for (const issue of unreachable) {
      expect(issue.fix).toBeDefined();
      expect(issue.fix!.type).toBe("add_trigger");
      expect(issue.fix!.file).toContain("RESOLVER.md");
    }
  });

  test("whitelisted skills (ingest, signal-detector, brain-ops) don't trigger MECE overlap", () => {
    const overlaps = report.issues.filter(i => i.type === "mece_overlap");
    for (const issue of overlaps) {
      // The skill field lists the overlapping skills
      expect(issue.skill).not.toContain("signal-detector");
      expect(issue.skill).not.toContain("brain-ops");
    }
  });

  test("summary counts are consistent", () => {
    expect(report.summary.reachable + report.summary.unreachable).toBe(report.summary.total_skills);
  });
});

// ---------------------------------------------------------------------------
// DRY detection — proximity-based suppression
// ---------------------------------------------------------------------------

function makeSkillsFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gbrain-dry-"));
  // Minimal RESOLVER.md and manifest.json so checkResolvable doesn't bail.
  const skillNames = Object.keys(files);
  const resolverRows = skillNames.map(n => `| "${n}" | \`skills/${n}/SKILL.md\` |`).join("\n");
  writeFileSync(join(dir, "RESOLVER.md"), `## Test\n| Trigger | Skill |\n|-----|-----|\n${resolverRows}\n`);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ skills: skillNames.map(n => ({ name: n, path: `${n}/SKILL.md` })) }, null, 2)
  );
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    // Skill conformance tests (elsewhere) check for frontmatter + triggers;
    // checkResolvable itself only needs the body.
    const frontmatter = `---\nname: ${name}\ndescription: test\ntriggers:\n  - "${name}"\n---\n`;
    writeFileSync(join(dir, name, "SKILL.md"), frontmatter + body);
  }
  return dir;
}

describe("extractDelegationTargets", () => {
  test("parses > **Convention:** callouts", () => {
    const refs = extractDelegationTargets(
      "> **Convention:** See `skills/conventions/quality.md` for citation rules.\n"
    );
    expect(refs).toEqual([{ convention: "conventions/quality.md", line: 1 }]);
  });

  test("parses > **Filing rule:** callouts", () => {
    const refs = extractDelegationTargets(
      "> **Filing rule:** Read `skills/_brain-filing-rules.md` before any new page.\n"
    );
    expect(refs).toEqual([{ convention: "_brain-filing-rules.md", line: 1 }]);
  });

  test("parses inline backtick references", () => {
    const refs = extractDelegationTargets(
      "some prose.\nSee `skills/conventions/quality.md` for details.\n"
    );
    expect(refs).toEqual([{ convention: "conventions/quality.md", line: 2 }]);
  });

  test("ignores backticks pointing outside known delegation targets", () => {
    const refs = extractDelegationTargets(
      "See `skills/random/README.md` for unrelated notes.\n"
    );
    expect(refs).toHaveLength(0);
  });

  test("handles frontmatter-only skill (no body matches)", () => {
    const refs = extractDelegationTargets("---\nname: foo\n---\n");
    expect(refs).toHaveLength(0);
  });
});

describe("DRY detection — checkResolvable", () => {
  let dir: string;
  afterEachCleanup(() => dir && rmSync(dir, { recursive: true, force: true }));

  test("flags inlined notability rule with no reference", () => {
    dir = makeSkillsFixture({
      bad: "# BadSkill\n\nCheck the notability gate every time.\n",
    });
    const report = checkResolvable(dir);
    const dry = report.issues.filter(i => i.type === "dry_violation");
    expect(dry).toHaveLength(1);
    expect(dry[0].skill).toBe("bad");
  });

  test("suppresses DRY when > **Convention:** callout points at quality.md (notability)", () => {
    dir = makeSkillsFixture({
      good: `# GoodSkill\n\n> **Convention:** See \`skills/conventions/quality.md\` for rules.\n\nCheck the notability gate.\n`,
    });
    const report = checkResolvable(dir);
    const dry = report.issues.filter(i => i.type === "dry_violation");
    expect(dry).toHaveLength(0);
  });

  test("suppresses DRY when _brain-filing-rules.md is referenced for notability", () => {
    dir = makeSkillsFixture({
      good: `# GoodSkill\n\n> **Filing rule:** Read \`skills/_brain-filing-rules.md\`.\n\nCheck the notability gate.\n`,
    });
    const report = checkResolvable(dir);
    const dry = report.issues.filter(i => i.type === "dry_violation");
    expect(dry).toHaveLength(0);
  });

  test("does NOT suppress when reference is >40 lines from the match", () => {
    const filler = Array(50).fill("padding paragraph with no match.").join("\n");
    dir = makeSkillsFixture({
      distant: `> **Convention:** See \`skills/conventions/quality.md\`.\n\n${filler}\n\nCheck the notability gate now.\n`,
    });
    const report = checkResolvable(dir);
    const dry = report.issues.filter(i => i.type === "dry_violation");
    expect(dry).toHaveLength(1);
  });

  test("DOES suppress when reference is ~30 lines from the match", () => {
    const filler = Array(20).fill("padding paragraph with no match.").join("\n");
    dir = makeSkillsFixture({
      near: `> **Convention:** See \`skills/conventions/quality.md\`.\n\n${filler}\n\nCheck the notability gate now.\n`,
    });
    const report = checkResolvable(dir);
    const dry = report.issues.filter(i => i.type === "dry_violation");
    expect(dry).toHaveLength(0);
  });

  test("iron-law pattern does NOT accept _brain-filing-rules.md as delegation", () => {
    // iron-law's only accepted target is conventions/quality.md
    dir = makeSkillsFixture({
      filing: `> **Filing rule:** Read \`skills/_brain-filing-rules.md\`.\n\n## Iron Law: Back-Linking (MANDATORY)\n`,
    });
    const report = checkResolvable(dir);
    const dry = report.issues.filter(i => i.type === "dry_violation");
    expect(dry.length).toBeGreaterThanOrEqual(1);
  });
});

// bun:test has no beforeEach/afterEach at module scope cleanly interacting
// with closures; a small helper keeps cleanup readable and per-test.
function afterEachCleanup(fn: () => void) {
  const { afterEach } = require("bun:test");
  afterEach(fn);
}

