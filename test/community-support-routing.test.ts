import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const supportUrl = "https://github.com/garrytan/gbrain/blob/master/SUPPORT.md";

describe("community support routing", () => {
  test("SUPPORT.md routes non-project correspondence away from public issues", () => {
    const supportPath = join(repoRoot, "SUPPORT.md");
    expect(existsSync(supportPath), "SUPPORT.md should exist").toBe(true);

    const support = read("SUPPORT.md").toLowerCase();
    expect(support).toContain("legal, ip, attribution, or partnership");
    expect(support).toContain("do not open a public issue");
    expect(support).toContain("security advisory");
  });

  test("GitHub issue chooser exposes the non-project correspondence route", () => {
    const config = read(".github/ISSUE_TEMPLATE/config.yml");
    expect(config).toContain("blank_issues_enabled: false");
    expect(config).toContain("Non-project correspondence");
    expect(config).toContain(supportUrl);
  });

  test("bug and feature templates tell reporters what belongs in issues", () => {
    for (const template of [
      ".github/ISSUE_TEMPLATE/bug_report.md",
      ".github/ISSUE_TEMPLATE/feature_request.md",
    ]) {
      const body = read(template).toLowerCase();
      expect(body, template).toContain("for non-project correspondence");
      expect(body, template).toContain(supportUrl.toLowerCase());
      expect(body, template).toContain("legal/ip/attribution");
    }
  });
});
