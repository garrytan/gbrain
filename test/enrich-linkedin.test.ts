import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import matter from "gray-matter";

describe("enrich-linkedin script", () => {
  const testDir = path.join(process.cwd(), "test-data-linkedin");
  const testFile = path.join(testDir, "test-person.md");

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

  test("appends linkedin to aliases and updates State", () => {
    execSync(`cd /Users/brandon/gbrain && bun run scripts/enrich-linkedin.ts ${testFile} "https://linkedin.com/in/test" "CEO at Test"`);
    
    const content = fs.readFileSync(testFile, "utf8");
    const parsed = matter(content);
    
    expect(parsed.data.aliases).toContain("https://linkedin.com/in/test");
    expect(parsed.content).toContain("- LinkedIn: [Profile](https://linkedin.com/in/test)");
    expect(parsed.content).toContain("- Current Role: CEO at Test");
  });
});
