import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { autoDetectSkillsDir } from "../src/core/repo-root.ts";
import { checkResolvable } from "../src/core/check-resolvable.ts";

describe("resolver health for sparse workspace skills", () => {
  test("root-level workspace detection downgrades unreachable skills to warnings", () => {
    const home = mkdtempSync(join(tmpdir(), "gbrain-workspace-skills-"));
    try {
      const workspace = join(home, ".openclaw", "workspace");
      const skillsDir = join(workspace, "skills");
      const caller = join(home, ...Array.from({ length: 12 }, (_, index) => `level-${index}`));
      mkdirSync(caller, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "AGENTS.md"), "# Workspace instructions\nNo routing table.\n");

      for (const name of ["foreign-skill-one", "foreign-skill-two", "foreign-skill-three", "foreign-skill-four"]) {
        const skillDir = join(skillsDir, name);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          join(skillDir, "SKILL.md"),
          `---\nname: ${name}\ndescription: workspace skill without triggers\n---\n# Skill\n`,
        );
      }

      const detected = autoDetectSkillsDir(caller, { HOME: home });
      expect(detected.source).toBe("openclaw_workspace_home_root");

      const report = checkResolvable(detected.dir!, { skillsDirSource: detected.source });
      expect(report.errors.filter(issue => issue.type === "unreachable")).toEqual([]);
      expect(report.warnings.filter(issue => issue.type === "unreachable")).toHaveLength(4);
      expect(report.warnings.filter(issue => issue.type === "mece_gap")).toHaveLength(4);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
