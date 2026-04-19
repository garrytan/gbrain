import { expect, test, describe } from "bun:test";
import { filterByTier, isVisibleToTier, PageForFilter } from "../src/core/access-filter";
import { AccessConfig } from "../src/core/access-config";

// Fixture config exercises all four semantic branches:
//   - default-allow tier (empty allow_tags) with a single block
//   - explicit-allow tier with both allows and blocks
//   - scoped tier that only sees one specific scope
//   - deny-all tier using the "*" wildcard block
// Tag names are intentionally generic so the suite travels with the primitive.
const cfg: AccessConfig = {
  version: 1,
  tiers: {
    full: {
      description: "default-allow, trusted",
      allow_tags: [],
      block_tags: ["sensitivity:owner-only"],
    },
    team: {
      description: "explicit-allow with blocks",
      allow_tags: ["domain:team", "domain:public", "sensitivity:public"],
      block_tags: [
        "domain:finance",
        "domain:health",
        "scope:secret-project",
        "sensitivity:owner-only",
      ],
    },
    scoped: {
      description: "only sees one explicit scope",
      allow_tags: ["scope:partner-a", "sensitivity:public"],
      block_tags: ["sensitivity:owner-only"],
    },
    none: {
      description: "deny all",
      allow_tags: [],
      block_tags: ["*"],
    },
  },
};

const p = (slug: string, tags: string[]): PageForFilter => ({ slug, tags });

describe("isVisibleToTier — default-allow tier (full)", () => {
  test("sees untagged pages (empty allow_tags = default allow)", () => {
    expect(isVisibleToTier(p("a", []), "full", cfg)).toBe(true);
  });
  test("sees pages with arbitrary tags", () => {
    expect(isVisibleToTier(p("a", ["domain:finance"]), "full", cfg)).toBe(true);
  });
  test("blocked from a page carrying the tier's block tag", () => {
    expect(
      isVisibleToTier(p("a", ["domain:team", "sensitivity:owner-only"]), "full", cfg),
    ).toBe(false);
  });
});

describe("isVisibleToTier — explicit-allow tier (team)", () => {
  test("sees pages with an allowed tag", () => {
    expect(isVisibleToTier(p("a", ["domain:team"]), "team", cfg)).toBe(true);
  });
  test("sees sensitivity:public alone", () => {
    expect(isVisibleToTier(p("a", ["sensitivity:public"]), "team", cfg)).toBe(true);
  });
  test("blocked when a block tag is present even with an allow tag (blocks win)", () => {
    expect(
      isVisibleToTier(p("a", ["domain:team", "domain:finance"]), "team", cfg),
    ).toBe(false);
  });
  test("blocked from a scope in block_tags", () => {
    expect(isVisibleToTier(p("a", ["scope:secret-project"]), "team", cfg)).toBe(false);
  });
  test("blocked from untagged pages (no allow tag match = default deny)", () => {
    expect(isVisibleToTier(p("a", []), "team", cfg)).toBe(false);
  });
  test("sensitivity:public does NOT override explicit blocks (blocks still win)", () => {
    expect(
      isVisibleToTier(p("a", ["domain:finance", "sensitivity:public"]), "team", cfg),
    ).toBe(false);
  });
});

describe("isVisibleToTier — narrowly-scoped tier (scoped)", () => {
  test("sees pages with the scope tag", () => {
    expect(isVisibleToTier(p("a", ["scope:partner-a"]), "scoped", cfg)).toBe(true);
  });
  test("blocked from content outside the scope", () => {
    expect(isVisibleToTier(p("a", ["domain:finance"]), "scoped", cfg)).toBe(false);
  });
  test("blocked from untagged", () => {
    expect(isVisibleToTier(p("a", []), "scoped", cfg)).toBe(false);
  });
});

describe("isVisibleToTier — deny-all tier (none)", () => {
  test("wildcard block_tags hides everything", () => {
    expect(isVisibleToTier(p("a", ["domain:team"]), "none", cfg)).toBe(false);
    expect(isVisibleToTier(p("a", ["sensitivity:public"]), "none", cfg)).toBe(false);
    expect(isVisibleToTier(p("a", []), "none", cfg)).toBe(false);
  });
});

describe("isVisibleToTier — unknown tier", () => {
  test("unknown tier defaults to deny-all (safety default)", () => {
    expect(
      isVisibleToTier(p("a", ["domain:team"]), "nonexistent-tier", cfg),
    ).toBe(false);
  });
});

describe("filterByTier", () => {
  test("filters a list of pages", () => {
    const pages = [
      p("team-doc", ["domain:team"]),
      p("ledger", ["domain:finance"]),
      p("public-post", ["sensitivity:public"]),
      p("partner-deck", ["scope:partner-a"]),
    ];
    const visible = filterByTier(pages, "team", cfg);
    expect(visible.map((x) => x.slug)).toEqual(["team-doc", "public-post"]);
  });
  test("preserves generic type T", () => {
    const pages: Array<PageForFilter & { extra: string }> = [
      { slug: "a", tags: ["domain:team"], extra: "meta" },
      { slug: "b", tags: ["domain:finance"], extra: "data" },
    ];
    const visible = filterByTier(pages, "team", cfg);
    expect(visible).toHaveLength(1);
    expect(visible[0].extra).toBe("meta");
  });
  test("empty input returns empty", () => {
    expect(filterByTier([], "team", cfg)).toEqual([]);
  });
});
