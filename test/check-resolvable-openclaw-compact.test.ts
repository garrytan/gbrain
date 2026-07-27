/**
 * v0.41.7.0 — Regression suite for compact list-format resolvers.
 *
 * The bisect anchor for the OpenClaw scaling regression: pre-v0.41.7.0,
 * any agent that wrote the compact `- **name**: t1 | t2` shape (instead
 * of the markdown table) saw every skill reported as unreachable by
 * `gbrain doctor`. The OpenClaw deployment regression was 238 FAIL
 * errors → 0 errors after the parser fix.
 *
 * Two fixtures drive three regression tests:
 *
 *   1. test/fixtures/openclaw-compact-resolver/ — list-format only,
 *      ~10 skills with valid frontmatter triggers, plus a prose-bullet
 *      section that pins the D4 kebab-lowercase regex tighten.
 *
 *   2. test/fixtures/openclaw-mixed-merge/ — table-format
 *      skills/RESOLVER.md + parent ../AGENTS.md (compact list). Pins
 *      the v0.31.7 D-CX-14 multi-resolver merge case.
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";
import { checkResolvable } from "../src/core/check-resolvable.ts";

const COMPACT_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "openclaw-compact-resolver",
  "skills"
);

const MIXED_MERGE_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "openclaw-mixed-merge",
  "skills"
);

describe("v0.41.7.0 — compact list-format resolver (PR #1370 regression)", () => {
  const report = checkResolvable(COMPACT_FIXTURE);

  test("every skill in the manifest is reachable from the list-format resolver", () => {
    // The headline assertion: pre-v0.41.7.0 this was unreachable=N for
    // every skill in the fixture. Post-fix, unreachable === 0.
    expect(report.summary.unreachable).toBe(0);
    expect(report.summary.reachable).toBe(report.summary.total_skills);
    expect(report.summary.total_skills).toBeGreaterThanOrEqual(10);
  });

  test("zero error-severity issues", () => {
    // The headline 238 FAILs → 0 outcome. errors only; warnings are
    // separately gated below.
    if (report.errors.length > 0) {
      console.error(
        "Unexpected errors:\n",
        report.errors.map(e => `  - [${e.type}] ${e.skill}: ${e.message}`).join("\n")
      );
    }
    expect(report.errors.length).toBe(0);
    expect(report.ok).toBe(true);
  });

  test("zero mece_gap warnings (fixture stubs ship valid triggers)", () => {
    // D5 fixture upgrade: every SKILL.md stub carries valid frontmatter
    // triggers, so the mece_gap detection should stay silent. If this
    // assertion ever fires, a fixture file lost its triggers: array.
    const gaps = report.warnings.filter(w => w.type === "mece_gap");
    if (gaps.length > 0) {
      console.error(
        "Unexpected mece_gap warnings:\n",
        gaps.map(w => `  - ${w.skill}: ${w.message}`).join("\n")
      );
    }
    expect(gaps.length).toBe(0);
  });

  test("D4 REGRESSION: prose bullets do not surface as orphan triggers", () => {
    // The compact RESOLVER.md fixture intentionally embeds 4 prose
    // bullets (`- **Note**:`, `- **Convention**:`, `- **TODO**:`,
    // `- **Important**:`). The kebab-lowercase regex rejects them
    // before they reach the resolver entry stream, so we should NOT
    // see orphan_trigger warnings naming any of these.
    const proseBulletNames = ["Note", "Convention", "TODO", "Important"];
    const orphans = report.warnings.filter(w => w.type === "orphan_trigger");
    for (const name of proseBulletNames) {
      const hit = orphans.find(w => w.skill === name);
      expect(hit, `prose bullet "${name}" should not surface as orphan_trigger`).toBeUndefined();
    }
  });

  test("zero missing_file warnings (every list entry resolves to disk)", () => {
    const missing = report.warnings.filter(w => w.type === "missing_file");
    if (missing.length > 0) {
      console.error(
        "Unexpected missing_file warnings:\n",
        missing.map(w => `  - ${w.skill}: ${w.message}`).join("\n")
      );
    }
    expect(missing.length).toBe(0);
  });
});

describe("v0.41.7.0 — D-CX-14 mixed-merge (table + parent AGENTS.md)", () => {
  const report = checkResolvable(MIXED_MERGE_FIXTURE);

  test("every skill is reachable across both resolver files", () => {
    // 5 skills routed from skills/RESOLVER.md (table format)
    // + 3 skills routed from ../AGENTS.md (compact list format)
    // = 8 total. All reachable via the v0.31.7 multi-file merge.
    expect(report.summary.total_skills).toBe(8);
    expect(report.summary.unreachable).toBe(0);
    expect(report.summary.reachable).toBe(8);
  });

  test("zero error-severity issues across the merged resolver set", () => {
    if (report.errors.length > 0) {
      console.error(
        "Unexpected errors:\n",
        report.errors.map(e => `  - [${e.type}] ${e.skill}: ${e.message}`).join("\n")
      );
    }
    expect(report.errors.length).toBe(0);
    expect(report.ok).toBe(true);
  });

  test("both table and list shapes contribute skills to the merge", () => {
    // Sanity check: if the merge silently dropped one shape's entries,
    // we'd see unreachable > 0. This test exists to guard against the
    // regression where one shape's parser starts swallowing the other's
    // output via the dedup-by-skillPath path.
    const expectedTableSkills = ["query", "enrich", "briefing", "migrate", "setup"];
    const expectedListSkills = ["adversary-tracking", "civic-intelligence", "book-mirror"];
    for (const name of [...expectedTableSkills, ...expectedListSkills]) {
      const unreachable = report.errors.find(
        e => e.type === "unreachable" && e.skill === name
      );
      expect(unreachable, `${name} should be reachable`).toBeUndefined();
    }
  });
});
