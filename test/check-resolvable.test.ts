import { describe, test, expect } from "bun:test";
import { join } from "path";
import { checkResolvable, parseResolverEntries } from "../src/core/check-resolvable.ts";

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
