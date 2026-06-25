import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Static SKILL.md conformance: verify the canonical contract that
// programmatic callers (SRW's parseSkillEnvelope in
// agentic-temporal-os) rely on stays in lockstep with the skill body.
//
// The runtime parser test (round-trip against a recorded fixture)
// lives in agentic-temporal-os's
// internal/temporal/testdata/skill_envelope_golden.txt; that fixture
// is the same shape this test checks SKILL.md documents.

const SKILL_PATH = join(
  import.meta.dir,
  "..",
  "skills",
  "perplexity-research",
  "SKILL.md",
);

function loadSkillBody(): string {
  return readFileSync(SKILL_PATH, "utf-8");
}

describe("perplexity-research SKILL.md envelope contract", () => {
  const body = loadSkillBody();

  test("documents the --output-envelope flag in Recognized flags", () => {
    expect(body).toContain("## Recognized flags");
    expect(body).toContain("--output-envelope");
  });

  test("declares the Output envelope schema fields", () => {
    expect(body).toContain("## Output envelope");
    for (const field of [
      "envelope_version",
      "brain_page_slug",
      "citations",
      "key_deltas",
      "cost_cents",
      "latency_ms",
    ]) {
      expect(body).toContain(field);
    }
  });

  test("locks envelope_version to 1", () => {
    expect(body).toMatch(/"envelope_version":\s*1/);
  });

  test("requires brain_page_slug to match the slug regex", () => {
    expect(body).toContain("^[a-zA-Z0-9_\\-/]+$");
  });

  test("documents the cost_cents fallback table", () => {
    expect(body).toContain("`sonar-pro` = 4");
    expect(body).toContain("`sonar` = 1");
  });

  test("default-mode (no --output-envelope flag) is unchanged", () => {
    expect(body).toContain(
      "If `--output-envelope` is **not** passed, do not emit the block",
    );
    // Mining cron callers must keep working as today.
    for (const caller of [
      "signal-detector",
      "daily-task-prep",
      "concept-synthesis",
    ]) {
      expect(body).toContain(caller);
    }
  });

  test("recognized flags list covers every flag SRW passes", () => {
    for (const flag of [
      "--topic",
      "--context-slugs",
      "--inline-context",
      "--recency",
      "--model",
      "--run-id",
      "--output-envelope",
    ]) {
      expect(body).toContain(flag);
    }
  });
});
