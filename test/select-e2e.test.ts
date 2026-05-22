// test/select-e2e.test.ts
//
// Unit tests for the diff-based E2E selector. Pure-function tests — no git,
// no filesystem. The 3 codex regression guards (skills/, untracked,
// unmapped src/) are explicitly named.

import { describe, expect, test } from "bun:test";

import {
  E2E_TEST_MAP,
} from "../scripts/e2e-test-map.ts";
import {
  classify,
  matchGlob,
  selectTests,
} from "../scripts/select-e2e.ts";

const ALL_E2E = [
  "test/e2e/cycle.test.ts",
  "test/e2e/dream.test.ts",
  "test/e2e/code-indexing.test.ts",
  "test/e2e/engine-parity.test.ts",
  "test/e2e/graph-quality.test.ts",
  "test/e2e/http-transport.test.ts",
  "test/e2e/integrity-batch.test.ts",
  "test/e2e/jsonb-roundtrip.test.ts",
  "test/e2e/mcp.test.ts",
  "test/e2e/mechanical.test.ts",
  "test/e2e/migrate-chain.test.ts",
  "test/e2e/migration-flow.test.ts",
  "test/e2e/minions-concurrency.test.ts",
  "test/e2e/minions-resilience.test.ts",
  "test/e2e/minions-shell-pglite.test.ts",
  "test/e2e/minions-shell.test.ts",
  "test/e2e/multi-source.test.ts",
  "test/e2e/postgres-bootstrap.test.ts",
  "test/e2e/postgres-jsonb.test.ts",
  "test/e2e/search-exclude.test.ts",
  "test/e2e/search-quality.test.ts",
  "test/e2e/search-swamp.test.ts",
  "test/e2e/skills.test.ts",
  "test/e2e/sync.test.ts",
  "test/e2e/upgrade.test.ts",
  "test/e2e/worker-abort-recovery.test.ts",
  "test/e2e/doctor-progress.test.ts",
  "test/e2e/frontmatter-migration.test.ts",
  "test/e2e/openclaw-reference-compat.test.ts",
];

function select(changedFiles: string[]): string[] {
  return selectTests({
    changedFiles,
    allE2ETests: ALL_E2E,
    map: E2E_TEST_MAP,
  });
}

describe("matchGlob", () => {
  test("** matches any path segments", () => {
    expect(matchGlob("src/core/search/**", "src/core/search/intent.ts")).toBe(
      true
    );
    expect(
      matchGlob("src/core/search/**", "src/core/search/sub/dir/file.ts")
    ).toBe(true);
  });

  test("* matches one segment, no /", () => {
    expect(matchGlob("src/*.ts", "src/cli.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/core/cli.ts")).toBe(false);
  });

  test("literal path matches itself", () => {
    expect(matchGlob("src/core/cycle.ts", "src/core/cycle.ts")).toBe(true);
    expect(matchGlob("src/core/cycle.ts", "src/core/cycle.test.ts")).toBe(false);
  });

  test("throws on unsupported glob syntax", () => {
    expect(() => matchGlob("src/[abc].ts", "src/a.ts")).toThrow();
    expect(() => matchGlob("src/{foo,bar}.ts", "src/foo.ts")).toThrow();
  });
});

describe("classify", () => {
  test("empty -> EMPTY", () => {
    expect(classify([])).toBe("EMPTY");
  });
  test("only doc paths -> DOC_ONLY", () => {
    expect(classify(["README.md", "docs/foo.md", "CHANGELOG.md"])).toBe(
      "DOC_ONLY"
    );
  });
  test("any non-doc path -> SRC", () => {
    expect(classify(["README.md", "src/cli.ts"])).toBe("SRC");
  });
  test("skills/ is NOT doc-only (Codex F4)", () => {
    expect(classify(["skills/RESOLVER.md"])).toBe("SRC");
  });
});

describe("selectTests", () => {
  test("case 1: empty diff -> all E2E", () => {
    expect(select([])).toEqual(ALL_E2E.slice().sort());
  });

  test("case 2: doc-only -> nothing", () => {
    expect(select(["README.md", "docs/guides/foo.md", "CHANGELOG.md"])).toEqual(
      []
    );
  });

  test("case 3: single mapped src -> only mapped tests", () => {
    expect(select(["src/core/search/intent.ts"])).toEqual([
      "test/e2e/search-exclude.test.ts",
      "test/e2e/search-quality.test.ts",
      "test/e2e/search-swamp.test.ts",
    ]);
  });

  test("case 4: multiple mapped srcs -> union, no duplicates", () => {
    const result = select([
      "src/core/search/intent.ts",
      "src/core/minions/queue.ts",
    ]);
    expect(result).toContain("test/e2e/search-quality.test.ts");
    expect(result).toContain("test/e2e/minions-concurrency.test.ts");
    // Determinism: dedup preserved
    const set = new Set(result);
    expect(set.size).toBe(result.length);
  });

  test("case 5: schema escape-hatch -> all", () => {
    expect(select(["src/schema.sql"])).toEqual(ALL_E2E.slice().sort());
  });

  test("case 6 (Codex F4 regression): skills/ -> all", () => {
    expect(select(["skills/RESOLVER.md"])).toEqual(ALL_E2E.slice().sort());
    expect(select(["skills/migrations/v0.22.4.md"])).toEqual(
      ALL_E2E.slice().sort()
    );
  });

  test("case 7 (Codex F5 regression): untracked file -> fail-closed -> all", () => {
    // The selector receives the union of (committed, unstaged, untracked).
    // We simulate "untracked" by passing the path in the changed list with
    // no map entry — should fail-closed to ALL.
    expect(select(["src/foo-new.ts"])).toEqual(ALL_E2E.slice().sort());
  });

  test("case 8 (Codex F1 headline): unmapped src/ -> fail-closed -> all", () => {
    // src/core/utils.ts is not in the map; must fail-closed.
    expect(select(["src/core/utils.ts"])).toEqual(ALL_E2E.slice().sort());
    // src/cli.ts is also not in the map.
    expect(select(["src/cli.ts"])).toEqual(ALL_E2E.slice().sort());
  });

  test("case 9: directly-modified test file is included", () => {
    // Touching a test file directly with no other src changes:
    // - test/e2e/foo.test.ts is in changedFiles
    // - it gets added to result
    // - no other map entries match
    // - result has 1 entry, so NOT fail-closed
    expect(select(["test/e2e/sync.test.ts"])).toEqual([
      "test/e2e/sync.test.ts",
    ]);
  });

  test("case 10: mixed doc + mapped-src -> only src-relevant", () => {
    const result = select([
      "README.md",
      "docs/foo.md",
      "src/core/search/intent.ts",
    ]);
    expect(result).toEqual([
      "test/e2e/search-exclude.test.ts",
      "test/e2e/search-quality.test.ts",
      "test/e2e/search-swamp.test.ts",
    ]);
  });

  test("escape-hatch: package.json -> all", () => {
    expect(select(["package.json"])).toEqual(ALL_E2E.slice().sort());
  });

  test("escape-hatch: bun.lock -> all", () => {
    expect(select(["bun.lock"])).toEqual(ALL_E2E.slice().sort());
  });

  test("escape-hatch: .github/workflows/** -> all", () => {
    expect(select([".github/workflows/test.yml"])).toEqual(
      ALL_E2E.slice().sort()
    );
  });

  test("escape-hatch: src/commands/migrations/** -> all", () => {
    expect(select(["src/commands/migrations/v0_22_8.ts"])).toEqual(
      ALL_E2E.slice().sort()
    );
  });

  test("escape-hatch: test/e2e/helpers.ts -> all", () => {
    expect(select(["test/e2e/helpers.ts"])).toEqual(ALL_E2E.slice().sort());
  });

  test("escape-hatch beats narrow map: schema + search both touched", () => {
    // schema.sql is escape-hatch; should win over search narrow match.
    expect(select(["src/schema.sql", "src/core/search/intent.ts"])).toEqual(
      ALL_E2E.slice().sort()
    );
  });
});
