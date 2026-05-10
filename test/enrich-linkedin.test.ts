import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import matter from "gray-matter";

describe("enrich-linkedin script", () => {
  const testDir = path.join(process.cwd(), "test-data-linkedin");
  const testFile = path.join(testDir, "test-person.md");
  const profileDir = path.join(testDir, "linkedin-profiles");
  const profileFile = path.join(profileDir, "test-person-linkedin.md");

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      testFile,
      `---
type: person
title: Test Person
company: test
---

# Test Person

This is a test person.

## State
- Role: Test
`
    );
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("appends linkedin to aliases, updates State, and creates profile file", () => {
    const payload = JSON.stringify({
      currentRole: "CEO at Test",
      location: "San Francisco",
      education: "University of Test",
      summary: "A passionate test person."
    });
    
    execSync(`cd /Users/brandon/gbrain && bun run scripts/enrich-linkedin.ts ${testFile} "https://linkedin.com/in/test" '${payload}'`);
    
    // Check main file
    const content = fs.readFileSync(testFile, "utf8");
    const parsed = matter(content);
    
    expect(parsed.data.aliases).toContain("https://linkedin.com/in/test");
    expect(parsed.content).toContain("- LinkedIn: [Profile](https://linkedin.com/in/test) | [Raw Extraction](linkedin-profiles/test-person-linkedin.md)");
    expect(parsed.content).toContain("- Current Role: CEO at Test");
    expect(parsed.content).toContain("- Location: San Francisco");
    expect(parsed.content).toContain("- Education: University of Test");

    // Check profile file
    expect(fs.existsSync(profileFile)).toBe(true);
    const profileContent = fs.readFileSync(profileFile, "utf8");
    const profileParsed = matter(profileContent);
    
    expect(profileParsed.data.type).toBe("linkedin-profile");
    expect(profileParsed.data.person).toBe("../test-person.md");
    expect(profileParsed.content).toContain("### currentRole");
    expect(profileParsed.content).toContain("CEO at Test");
    expect(profileParsed.content).toContain("### summary");
    expect(profileParsed.content).toContain("A passionate test person.");
  });
});
