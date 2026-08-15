// Contract test for ALL_PAGE_TYPES seed-list round-trip (v0.38 refresh).
//
// v0.38 opens PageType from a closed 23-element union to `string`. The
// pre-v0.38 exhaustive-switch contract is gone — switches over types can
// no longer be enforced by the type system because new types arrive via
// schema-pack manifests at runtime.
//
// What this test still asserts:
//   1. ALL_PAGE_TYPES (the gbrain-base seed list) is non-empty and well-shaped.
//   2. Every base type round-trips through serialize/parse markdown without
//      loss. This is the "byte-for-byte gbrain-base equivalence" contract
//      from the v0.38 plan — schema-pack codegen consumes this list.
//   3. assertNever still throws when reached (preserved as a generic helper
//      for switches over the closed `PackPrimitive` enum from
//      src/core/schema-pack/primitives.ts).
//
// What this test NO LONGER asserts (intentionally removed in v0.38):
//   - That a switch over PageType is compile-time-exhaustive. PageType is
//     `string`, so switches cannot be exhaustive at the type level.
//     Runtime validation against the active schema pack replaces this.
//   - That ALL_PAGE_TYPES is the only legal page-type set. It is the
//     seed list for the built-in `gbrain-base` pack; user packs add more.

import { describe, expect, test } from 'bun:test';
import { ALL_PAGE_TYPES, assertNever } from '../src/core/types.ts';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';

describe('ALL_PAGE_TYPES seed list (v0.38)', () => {
  test('seed list is non-empty and well-shaped', () => {
    expect(ALL_PAGE_TYPES.length).toBeGreaterThan(0);
    for (const t of ALL_PAGE_TYPES) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });

  test('serializeMarkdown round-trips every seed type', () => {
    for (const type of ALL_PAGE_TYPES) {
      const md = serializeMarkdown(
        {},
        `Body for ${type}`,
        '',
        { type, title: `Test ${type}`, tags: [] },
      );
      expect(md).toContain(`type: ${type}`);
      expect(md).toContain(`Body for ${type}`);

      // Parse it back; type must survive the round-trip.
      const parsed = parseMarkdown(md, `${type}-fixture.md`);
      expect(parsed.type).toBe(type);
    }
  });

  test('serializeMarkdown round-trips arbitrary user-defined types (v0.38)', () => {
    // Schema packs declare custom types at runtime; the markdown serializer
    // must NOT reject types outside ALL_PAGE_TYPES. This is the test that
    // would have caught the v0.38 regression if anyone tried to re-close
    // PageType in the markdown surface.
    const userTypes = ['paper', 'researcher', 'therapy-session', 'apple-note', 'tweet-bundle'];
    for (const type of userTypes) {
      const md = serializeMarkdown(
        {},
        `Body for ${type}`,
        '',
        { type, title: `Test ${type}`, tags: [] },
      );
      const parsed = parseMarkdown(md, `${type}-fixture.md`);
      expect(parsed.type).toBe(type);
    }
  });

  test('assertNever still throws on the unreachable branch', () => {
    // Generic helper preserved for switches over the closed PackPrimitive
    // enum (entity|media|temporal|annotation|concept) declared in
    // src/core/schema-pack/primitives.ts. Not used on PageType anymore.
    expect(() => assertNever('not-a-real-type' as never)).toThrow(
      /Unhandled discriminant/,
    );
  });
});
