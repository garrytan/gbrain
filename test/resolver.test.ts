import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { checkResolvable } from "../src/core/check-resolvable.ts";
import { PROTECTED_JOB_NAMES } from "../src/core/minions/protected-names.ts";

const SKILLS_DIR = join(import.meta.dir, "..", "skills");
const RESOLVER_PATH = join(SKILLS_DIR, "RESOLVER.md");
const OPERATIONS_PATH = join(import.meta.dir, "..", "src", "core", "operations.ts");

describe("RESOLVER.md", () => {
  test("exists", () => {
    expect(existsSync(RESOLVER_PATH)).toBe(true);
  });

  const resolverContent = existsSync(RESOLVER_PATH)
    ? readFileSync(RESOLVER_PATH, "utf-8")
    : "";

  test("references only existing skill files", () => {
    // Delegates to checkResolvable — no reimplemented parsing logic
    const report = checkResolvable(SKILLS_DIR);
    const missingFiles = report.issues.filter(i => i.type === "missing_file");
    expect(missingFiles.length).toBe(0);
  });

  test("has categorized sections", () => {
    expect(resolverContent).toContain("## Always-on");
    expect(resolverContent).toContain("## Brain operations");
    expect(resolverContent).toContain("## Content & media ingestion");
    expect(resolverContent).toContain("## Operational");
  });

  test("has disambiguation rules", () => {
    expect(resolverContent).toContain("## Disambiguation rules");
  });

  test("references conventions", () => {
    expect(resolverContent).toContain("conventions/quality.md");
    expect(resolverContent).toContain("_brain-filing-rules.md");
  });

  test("every manifest skill is reachable from resolver", () => {
    // Delegates to checkResolvable — the shared function handles all validation
    const report = checkResolvable(SKILLS_DIR);
    const unreachable = report.issues.filter(i => i.type === "unreachable");
    if (unreachable.length > 0) {
      const names = unreachable.map(i => `${i.skill}: ${i.action}`).join("\n  ");
      throw new Error(`Unreachable skills:\n  ${names}`);
    }
    expect(report.summary.unreachable).toBe(0);
  });
});

// D5/C — resolver round-trip: every quoted trigger in a RESOLVER.md table row
// must appear in the target skill's frontmatter `triggers:` list. Catches
// trigger/frontmatter drift that `checkResolvable` reachability doesn't.
describe("RESOLVER.md trigger round-trip (D5/C)", () => {
  type Row = { triggers: string[]; skillPath: string };

  const rows: Row[] = (() => {
    if (!existsSync(RESOLVER_PATH)) return [];
    const content = readFileSync(RESOLVER_PATH, "utf-8");
    // Tolerate trailing annotations after the backtick path (e.g.,
    // `` `skills/maintain/SKILL.md` (extraction sections) |``). The path cell
    // starts with a backtick-quoted `.md` ref; anything between that and the
    // closing `|` is free-form prose and is intentionally ignored.
    const rowRe = /^\s*\|\s*([^|]+?)\s*\|\s*`([^`]+\.md)`[^|]*\|\s*$/gm;
    const out: Row[] = [];
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(content)) !== null) {
      const rawTriggers = m[1];
      const skillPath = m[2];
      const triggerStrings = Array.from(rawTriggers.matchAll(/"([^"]+)"/g)).map(t => t[1]);
      if (triggerStrings.length > 0) {
        out.push({ triggers: triggerStrings, skillPath });
      }
    }
    return out;
  })();

  test("at least one routing row parses from RESOLVER.md", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  for (const row of rows) {
    test(`every RESOLVER trigger for ${row.skillPath} is declared in its frontmatter`, () => {
      const skillFullPath = join(SKILLS_DIR, "..", row.skillPath);
      expect(existsSync(skillFullPath)).toBe(true);

      const skillContent = readFileSync(skillFullPath, "utf-8");
      const fmMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        throw new Error(`No YAML frontmatter in ${row.skillPath}`);
      }
      const frontmatter = fmMatch[1];
      // Parse frontmatter triggers: list. Match "..." OR '...' items separately
      // so apostrophes inside double-quoted values don't truncate the capture.
      const triggersBlock = frontmatter.match(/triggers:\s*\n((?:\s*-\s*(?:"[^"]*"|'[^']*')\s*\n?)+)/);
      const declaredTriggers = triggersBlock
        ? Array.from(triggersBlock[1].matchAll(/-\s*(?:"([^"]*)"|'([^']*)')/g))
            .map(m => m[1] ?? m[2])
        : [];

      // Fuzzy match: RESOLVER.md phrases are natural-language summaries of the
      // skill's intent; frontmatter triggers are the agent-facing phrase set.
      // Match is case-insensitive, trailing-punctuation-insensitive, and supports
      // "/"-split compounds (e.g., "pause/resume agent" → ["pause", "resume agent"]).
      const normalize = (s: string) => s.toLowerCase().replace(/[?!.,]+$/, "").trim();
      const declaredLower = declaredTriggers.map(normalize);

      function matchesAny(phrase: string): boolean {
        const p = normalize(phrase);
        if (declaredLower.includes(p)) return true;
        for (const ft of declaredLower) {
          if (ft.includes(p) || p.includes(ft)) return true;
        }
        // Slash-split compound: every part should have some fuzzy frontmatter hit
        if (p.includes("/")) {
          const parts = p.split("/").map(s => s.trim()).filter(Boolean);
          const allParts = parts.every(part =>
            declaredLower.some(ft => ft.includes(part) || part.includes(ft))
          );
          if (allParts) return true;
        }
        return false;
      }

      const missing = row.triggers.filter(t => !matchesAny(t));
      if (missing.length > 0) {
        throw new Error(
          `RESOLVER.md routes ${JSON.stringify(missing)} to ${row.skillPath}, but the ` +
          `skill's frontmatter has no fuzzy match. Declared: ${JSON.stringify(declaredTriggers)}`
        );
      }
    });
  }
});

// D13 — skill-example-name validator: any `name="<word>"` reference inside a
// SKILL.md body must resolve to either a declared operation in operations.ts
// or a known Minions handler name in PROTECTED_JOB_NAMES. Catches T2-class
// bugs where docs reference handler names that don't exist (e.g., the
// `name="research"` / `name="orchestrate"` bug from PR #381 pre-reframe).
describe("Skill example-name validator (D13)", () => {
  const opNames: string[] = (() => {
    if (!existsSync(OPERATIONS_PATH)) return [];
    const content = readFileSync(OPERATIONS_PATH, "utf-8");
    return Array.from(content.matchAll(/^\s+name:\s*'([a-z_]+)',/gm)).map(m => m[1]);
  })();

  const knownNames = new Set<string>([...opNames, ...PROTECTED_JOB_NAMES]);

  test("operation names extracted from operations.ts", () => {
    // Sanity check: operations.ts should declare dozens of ops
    expect(opNames.length).toBeGreaterThan(10);
  });

  test("PROTECTED_JOB_NAMES is non-empty", () => {
    expect(PROTECTED_JOB_NAMES.size).toBeGreaterThan(0);
  });

  function walkSkills(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) {
        out.push(...walkSkills(p));
      } else if (entry === "SKILL.md") {
        out.push(p);
      }
    }
    return out;
  }

  const skillFiles = walkSkills(SKILLS_DIR);

  test("at least one SKILL.md found", () => {
    expect(skillFiles.length).toBeGreaterThan(0);
  });

  for (const skillFile of skillFiles) {
    const rel = skillFile.replace(SKILLS_DIR, "skills");
    test(`${rel}: every name="<word>" reference resolves to a real op or handler`, () => {
      const content = readFileSync(skillFile, "utf-8");
      // Strip YAML frontmatter so `name: <skillname>` isn't mis-captured.
      const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
      // Match only `name=` (with equals, not colon) to avoid YAML false positives
      // if the frontmatter strip ever breaks. Captures quoted word values.
      const refs = Array.from(body.matchAll(/name\s*=\s*["']([a-z_][a-z_0-9]*)["']/gi))
        .map(m => m[1]);
      const unique = [...new Set(refs)];
      const unknown = unique.filter(n => !knownNames.has(n));
      if (unknown.length > 0) {
        throw new Error(
          `${rel}: references name="..." values not declared in src/core/operations.ts or ` +
          `PROTECTED_JOB_NAMES: ${JSON.stringify(unknown)}. ` +
          `Known: ${JSON.stringify([...knownNames].sort())}`
        );
      }
    });
  }
});
