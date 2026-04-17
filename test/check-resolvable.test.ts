import { describe, test, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
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

// ---------------------------------------------------------------------------
// Regression: path traversal in manifest.json / RESOLVER.md
//
// checkResolvable takes skillsDir from the caller and joins it with string
// values from manifest.json and RESOLVER.md. Those inputs can be edited in
// a PR, in a committed file, or by a downstream consumer of the library.
// A payload like `"path": "../../../etc/passwd"` or a RESOLVER.md row with
// `skills/../../etc/hosts/SKILL.md` must not cause the function to read
// (or even stat) files outside skillsDir.
// ---------------------------------------------------------------------------

describe("checkResolvable — path traversal containment", () => {
  function makeSandbox(): string {
    const sandbox = mkdtempSync(join(tmpdir(), "gbrain-pt-"));
    const skillsDir = join(sandbox, "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Minimal legitimate skill so the report is comparable against real runs
    mkdirSync(join(skillsDir, "query"), { recursive: true });
    writeFileSync(
      join(skillsDir, "query", "SKILL.md"),
      "---\ntriggers:\n  - foo\n---\n# query\n"
    );
    writeFileSync(
      join(skillsDir, "RESOLVER.md"),
      "## Brain\n| Trigger | Skill |\n|---|---|\n| foo | `skills/query/SKILL.md` |\n"
    );
    return sandbox;
  }

  test("malicious manifest path is rejected as invalid_path, not read", () => {
    const sandbox = makeSandbox();
    const skillsDir = join(sandbox, "skills");

    // Pre-seed an outside-of-skills sentinel file that a traversal would hit
    // if the check were missing. We never expect the code to read it.
    const sentinel = join(sandbox, "SECRET.md");
    writeFileSync(sentinel, "---\ntriggers:\n  - ohno\n---\n# DO NOT READ\n");

    writeFileSync(
      join(skillsDir, "manifest.json"),
      JSON.stringify({
        skills: [
          { name: "query", path: "query/SKILL.md" },
          { name: "evil", path: "../SECRET.md" },
        ],
      })
    );

    try {
      const report = checkResolvable(skillsDir);

      const invalid = report.issues.filter(i => i.type === "invalid_path");
      expect(invalid.length).toBeGreaterThan(0);
      expect(invalid.some(i => i.skill === "evil")).toBe(true);

      // The sentinel file's unique trigger must NOT have made it into the
      // report's trigger analysis — if it did, the code read it.
      const overlap = report.issues.find(i =>
        i.type === "mece_overlap" && i.message.includes("ohno")
      );
      expect(overlap).toBeUndefined();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("absolute path in manifest is rejected", () => {
    const sandbox = makeSandbox();
    const skillsDir = join(sandbox, "skills");

    writeFileSync(
      join(skillsDir, "manifest.json"),
      JSON.stringify({
        skills: [
          { name: "absolute", path: "/etc/hosts" },
        ],
      })
    );

    try {
      const report = checkResolvable(skillsDir);
      const invalid = report.issues.filter(i => i.type === "invalid_path");
      expect(invalid.some(i => i.skill === "absolute")).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("malicious RESOLVER.md entry is rejected, no stat on outside path", () => {
    const sandbox = makeSandbox();
    const skillsDir = join(sandbox, "skills");

    // Empty manifest so we only exercise the RESOLVER code path
    writeFileSync(join(skillsDir, "manifest.json"), JSON.stringify({ skills: [] }));

    // Overwrite RESOLVER.md with a traversal row. The parser's regex
    // (`skills/[^`]+/SKILL\.md`) still matches, but the resolver must
    // refuse to stat the resulting path.
    writeFileSync(
      join(skillsDir, "RESOLVER.md"),
      "## Evil\n| Trigger | Skill |\n|---|---|\n" +
      "| bad | `skills/../../etc/hosts/SKILL.md` |\n"
    );

    try {
      const report = checkResolvable(skillsDir);

      // The resolver row should surface as invalid_path, not missing_file —
      // missing_file would imply we did an existsSync on /etc/hosts/SKILL.md.
      const invalid = report.issues.filter(i => i.type === "invalid_path");
      expect(invalid.length).toBeGreaterThan(0);
      expect(invalid.some(i => i.message.includes("escapes the skills directory"))).toBe(true);

      const missing = report.issues.filter(i => i.type === "missing_file");
      expect(missing.some(m => m.skill.includes("/etc/hosts"))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("benign normalized paths still resolve (e.g. foo/../query)", () => {
    const sandbox = makeSandbox();
    const skillsDir = join(sandbox, "skills");

    writeFileSync(
      join(skillsDir, "manifest.json"),
      JSON.stringify({
        skills: [
          // Legit skill expressed via a normalized-to-inside path
          { name: "query", path: "tmp/../query/SKILL.md" },
        ],
      })
    );

    try {
      const report = checkResolvable(skillsDir);
      // Must NOT treat this as invalid — it resolves inside skillsDir
      const invalidForQuery = report.issues.filter(
        i => i.type === "invalid_path" && i.skill === "query"
      );
      expect(invalidForQuery.length).toBe(0);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
