import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const SKILLS_DIR = join(import.meta.dir, "..", "skills");
const MANIFEST_PATH = join(SKILLS_DIR, "manifest.json");

/** Simple YAML frontmatter parser — extracts fields between --- delimiters */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const yaml = match[1];
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && !key.startsWith(" ") && !key.startsWith("-")) {
        result[key] = value;
      }
    }
  }
  return result;
}

/** Get all skill directories (those containing SKILL.md) */
function getSkillDirs(): string[] {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
    .map((e) => e.name)
    .filter((name) => name !== "install"); // deprecated skill
}

function getManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as {
    skills: Array<{ name: string; path: string; description: string }>;
  };
}

describe("skills conformance", () => {
  const allSkillDirs = getSkillDirs();
  const activeSkillDirs = getManifest().skills.map((skill) => skill.path.split("/")[0]);

  test("manifest.json exists and is valid JSON", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    expect(manifest.skills).toBeDefined();
    expect(Array.isArray(manifest.skills)).toBe(true);
  });

  test("manifest advertises only the Cortex SaaS runtime catalog", () => {
    const manifest = getManifest();
    expect(manifest.skills.map((s) => s.name)).toEqual(["setup", "schema-author"]);
    const serialized = JSON.stringify(manifest).toLowerCase();
    expect(serialized).not.toContain("personal");
    expect(serialized).not.toContain("obsidian");
    expect(serialized).not.toContain("notion");
    expect(serialized).not.toContain("roam");
    expect(serialized).not.toContain("openclaw");
    expect(serialized).not.toContain("gbrain");
  });

  test("every manifest entry points to an existing SKILL.md", () => {
    const manifest = getManifest();
    for (const skill of manifest.skills) {
      const skillPath = join(SKILLS_DIR, skill.path);
      expect(existsSync(skillPath)).toBe(true);
    }
  });

  for (const dir of activeSkillDirs) {
    describe(`skills/${dir}/SKILL.md`, () => {
      const content = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");

      test("has YAML frontmatter", () => {
        expect(content.startsWith("---\n")).toBe(true);
        const fm = parseFrontmatter(content);
        expect(fm).not.toBeNull();
      });

      test("frontmatter has required fields (name, description)", () => {
        const fm = parseFrontmatter(content);
        expect(fm).not.toBeNull();
        expect(fm!.name).toBeDefined();
        expect(fm!.description).toBeDefined();
      });

      test("has a Contract section", () => {
        expect(content).toContain("## Contract");
      });

      test("has an Anti-Patterns section", () => {
        expect(content).toContain("## Anti-Patterns");
      });

      test("has an Output Format section", () => {
        expect(content).toContain("## Output Format");
      });
    });
  }

  test("no duplicate skill names in frontmatter", () => {
    const names: string[] = [];
    for (const dir of activeSkillDirs) {
      const content = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.name) {
        const name = String(fm.name);
        expect(names).not.toContain(name);
        names.push(name);
      }
    }
  });

  test("historical skill directories are not treated as public catalog entries", () => {
    expect(allSkillDirs.length).toBeGreaterThan(activeSkillDirs.length);
    expect(activeSkillDirs).toEqual(["setup", "schema-author"]);
  });
});
