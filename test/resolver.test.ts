import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { checkResolvable } from "../src/core/check-resolvable.ts";

const SKILLS_DIR = join(import.meta.dir, "..", "skills");
const RESOLVER_PATH = join(SKILLS_DIR, "RESOLVER.md");

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
