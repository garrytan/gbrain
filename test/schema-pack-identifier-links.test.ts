// v0.51 — pack-declared identifier_links[] rules.
//
// Corpora that cite by bare identifier (DECISION-073, ADR-0047, SPA-2442,
// a JIRA-style key) get no edges from the markdown/wikilink/bare-slug
// passes in link-extraction.ts (all three require slug-shaped text) and
// by-mention.ts's gazetteer only knows person/company/organization/entity
// titles. `identifier_links` closes that gap: a pack rule matches an
// identifier pattern in the page body and resolves it against the live
// slug set.
//
// This file pins three layers:
//   1. Manifest parsing (SchemaPackManifestSchema shape + defaults).
//   2. Inheritance (mergeInheritedManifest — keyed by rule `name`, same
//      shape as link_types).
//   3. Resolution (resolveIdentifierLinksFromPack — pattern -> template ->
//      live-slug lookup: exact, glob-unique, ambiguous, no-match, and
//      case-insensitivity of the identifier).
//
// Layer 4 (wiring into extractPageLinks end-to-end, DB-path callers
// threading opts.liveSlugs) is pinned by test/link-extraction-identifier-links.test.ts.

import { describe, test, expect } from 'bun:test';
import {
  parseSchemaPackManifest,
  SchemaPackManifestError,
  type SchemaPackManifest,
  type PackIdentifierLinkRule,
} from '../src/core/schema-pack/manifest-v1.ts';
import { mergeInheritedManifest, type BorrowedTypes } from '../src/core/schema-pack/merge.ts';
import {
  resolveIdentifierLinksFromPack,
  type IdentifierLinkResolution,
} from '../src/core/schema-pack/link-inference.ts';
import { PageRegexBudget } from '../src/core/schema-pack/redos-guard.ts';

const baseManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  api_version: 'gbrain-schema-pack-v1',
  name: 'test-pack',
  version: '1.0.0',
  description: 'unit test pack for identifier_links',
  extends: null,
  page_types: [],
  link_types: [],
  ...overrides,
});

// ── 1. Manifest parsing ───────────────────────────────────────────────

describe('identifier_links — manifest parsing', () => {
  test('defaults to [] when omitted (back-compat: existing packs still parse)', () => {
    const m = parseSchemaPackManifest(baseManifest());
    expect(m.identifier_links).toEqual([]);
  });

  test('parses a full rule with all fields', () => {
    const m = parseSchemaPackManifest(baseManifest({
      identifier_links: [
        { name: 'decision-citation', pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*', link_type: 'cites', source_scope: 'default' },
      ],
    }));
    expect(m.identifier_links).toHaveLength(1);
    expect(m.identifier_links[0]).toMatchObject({
      name: 'decision-citation',
      pattern: 'DECISION-(\\d+)',
      target: 'decisions/decision-$1-*',
      link_type: 'cites',
      source_scope: 'default',
    });
  });

  test('link_type defaults to "mentions" when omitted', () => {
    const m = parseSchemaPackManifest(baseManifest({
      identifier_links: [{ name: 'spa', pattern: 'SPA-(\\d+)', target: 'tickets/spa-$1' }],
    }));
    expect(m.identifier_links[0].link_type).toBe('mentions');
  });

  test('rejects a rule missing required fields', () => {
    expect(() => parseSchemaPackManifest(baseManifest({
      identifier_links: [{ name: 'broken' }],
    }))).toThrow(SchemaPackManifestError);
  });

  test('rejects unknown keys on a rule (strict schema)', () => {
    expect(() => parseSchemaPackManifest(baseManifest({
      identifier_links: [{ name: 'x', pattern: 'X-(\\d+)', target: 'x/x-$1', bogus_field: true }],
    }))).toThrow(SchemaPackManifestError);
  });
});

// ── 2. Inheritance (merge.ts) ─────────────────────────────────────────

function mk(name: string, over: Partial<SchemaPackManifest> = {}): SchemaPackManifest {
  return {
    api_version: 'gbrain-schema-pack-v1',
    name,
    version: '1.0.0',
    description: '',
    gbrain_min_version: '0.38.0',
    extends: null,
    borrow_from: [],
    page_types: [],
    link_types: [],
    frontmatter_links: [],
    identifier_links: [],
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    enrichable_types: [],
    filing_rules: [],
    ...over,
  } as SchemaPackManifest;
}
const noBorrow: BorrowedTypes = { page_types: [], link_types: [] };
function idRule(name: string, over: Partial<PackIdentifierLinkRule> = {}): PackIdentifierLinkRule {
  return { name, pattern: `${name.toUpperCase()}-(\\d+)`, target: `${name}/$1`, link_type: 'mentions', ...over };
}

describe('identifier_links — inheritance (mergeInheritedManifest)', () => {
  test('parent rules are visible in the child (base case)', () => {
    const base = mk('base', { identifier_links: [idRule('decision')] });
    const child = mk('child', { identifier_links: [] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    expect(merged.identifier_links.map(r => r.name)).toEqual(['decision']);
  });

  test('child re-declaring the same name OVERRIDES the parent rule (child-wins, keyed by name)', () => {
    const base = mk('base', { identifier_links: [idRule('decision', { target: 'decisions/$1' })] });
    const child = mk('child', { identifier_links: [idRule('decision', { target: 'archive/decisions/$1' })] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    expect(merged.identifier_links).toHaveLength(1);
    expect(merged.identifier_links[0].target).toBe('archive/decisions/$1');
  });

  test('child can ADD a new rule alongside inherited ones', () => {
    const base = mk('base', { identifier_links: [idRule('decision')] });
    const child = mk('child', { identifier_links: [idRule('ticket')] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    expect(merged.identifier_links.map(r => r.name).sort()).toEqual(['decision', 'ticket']);
  });

  test('multi-level extends chain: nearest-parent wins on a shared name', () => {
    const root = mk('root', { identifier_links: [idRule('decision', { target: 'root/$1' })] });
    const middle = mk('middle', { identifier_links: [idRule('decision', { target: 'middle/$1' })] });
    const child = mk('child', { identifier_links: [] });
    // ancestorsBaseFirst = [root, middle] (root first, nearest last)
    const merged = mergeInheritedManifest([root, middle], child, noBorrow);
    expect(merged.identifier_links[0].target).toBe('middle/$1');
  });
});

// ── 3. Resolution (resolveIdentifierLinksFromPack) ────────────────────

function packWith(rules: PackIdentifierLinkRule[]) {
  return { identifier_links: rules };
}

describe('identifier_links — resolution (resolveIdentifierLinksFromPack)', () => {
  test('exact target: resolves when the substituted slug is live', () => {
    const pack = packWith([idRule('spa', { pattern: 'SPA-(\\d+)', target: 'tickets/spa-$1' })]);
    const liveSlugs = new Set(['tickets/spa-2442']);
    const { candidates, ambiguousCount }: IdentifierLinkResolution =
      resolveIdentifierLinksFromPack(pack, 'See SPA-2442 for context.', liveSlugs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ targetSlug: 'tickets/spa-2442', linkType: 'mentions', ruleName: 'spa' });
    expect(ambiguousCount).toBe(0);
  });

  test('exact target: no match when the substituted slug is not live', () => {
    const pack = packWith([idRule('spa', { pattern: 'SPA-(\\d+)', target: 'tickets/spa-$1' })]);
    const liveSlugs = new Set(['tickets/spa-9999']);
    const { candidates } = resolveIdentifierLinksFromPack(pack, 'See SPA-2442.', liveSlugs);
    expect(candidates).toEqual([]);
  });

  test('glob target: resolves when exactly one live slug matches the prefix', () => {
    const pack = packWith([idRule('decision', { pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*' })]);
    const liveSlugs = new Set(['decisions/decision-073-architecture-commitment', 'decisions/decision-001-other']);
    const { candidates } = resolveIdentifierLinksFromPack(pack, 'Per DECISION-073, ...', liveSlugs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].targetSlug).toBe('decisions/decision-073-architecture-commitment');
  });

  test('glob target: ambiguous when more than one live slug matches the prefix — skipped and counted', () => {
    const pack = packWith([idRule('decision', { pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*' })]);
    const liveSlugs = new Set([
      'decisions/decision-073-architecture-commitment',
      'decisions/decision-073-duplicate-title',
    ]);
    const { candidates, ambiguousCount } = resolveIdentifierLinksFromPack(pack, 'Per DECISION-073.', liveSlugs);
    expect(candidates).toEqual([]);
    expect(ambiguousCount).toBe(1);
  });

  test('glob target: no match (zero prefix hits) is silently skipped, not ambiguous', () => {
    const pack = packWith([idRule('decision', { pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*' })]);
    const liveSlugs = new Set(['decisions/decision-001-other']);
    const { candidates, ambiguousCount } = resolveIdentifierLinksFromPack(pack, 'Per DECISION-073.', liveSlugs);
    expect(candidates).toEqual([]);
    expect(ambiguousCount).toBe(0);
  });

  test('identifier matching is case-insensitive', () => {
    const pack = packWith([idRule('decision', { pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*' })]);
    const liveSlugs = new Set(['decisions/decision-073-architecture-commitment']);
    for (const text of ['Per decision-073.', 'Per Decision-073.', 'Per DECISION-073.', 'Per DeCiSiOn-073.']) {
      const { candidates } = resolveIdentifierLinksFromPack(pack, text, liveSlugs);
      expect(candidates.map(c => c.targetSlug)).toEqual(['decisions/decision-073-architecture-commitment']);
    }
  });

  test('no liveSlugs supplied: no-op (matches put_page / sweep callers that omit it)', () => {
    const pack = packWith([idRule('spa', { pattern: 'SPA-(\\d+)', target: 'tickets/spa-$1' })]);
    const { candidates, ambiguousCount } = resolveIdentifierLinksFromPack(pack, 'See SPA-2442.', undefined);
    expect(candidates).toEqual([]);
    expect(ambiguousCount).toBe(0);
  });

  test('no rules declared: no-op even with liveSlugs supplied', () => {
    const { candidates } = resolveIdentifierLinksFromPack(packWith([]), 'See SPA-2442.', new Set(['tickets/spa-2442']));
    expect(candidates).toEqual([]);
  });

  test('multiple occurrences of the same identifier each produce a candidate', () => {
    const pack = packWith([idRule('spa', { pattern: 'SPA-(\\d+)', target: 'tickets/spa-$1' })]);
    const liveSlugs = new Set(['tickets/spa-2442']);
    const { candidates } = resolveIdentifierLinksFromPack(
      pack, 'SPA-2442 fixed the bug. See also SPA-2442 for the writeup.', liveSlugs,
    );
    expect(candidates).toHaveLength(2);
  });

  test('two different rules on the same page both fire', () => {
    const pack = packWith([
      idRule('decision', { pattern: 'DECISION-(\\d+)', target: 'decisions/decision-$1-*' }),
      idRule('spa', { pattern: 'SPA-(\\d+)', target: 'tickets/spa-$1' }),
    ]);
    const liveSlugs = new Set(['decisions/decision-073-x', 'tickets/spa-2442']);
    const { candidates } = resolveIdentifierLinksFromPack(pack, 'Per DECISION-073, ticket SPA-2442.', liveSlugs);
    expect(candidates.map(c => c.targetSlug).sort()).toEqual(['decisions/decision-073-x', 'tickets/spa-2442']);
  });

  test('runs correctly under a PageRegexBudget (shared-budget wiring)', () => {
    const pack = packWith([idRule('spa', { pattern: 'SPA-(\\d+)', target: 'tickets/spa-$1' })]);
    const liveSlugs = new Set(['tickets/spa-2442']);
    const budget = new PageRegexBudget();
    const { candidates } = resolveIdentifierLinksFromPack(pack, 'See SPA-2442.', liveSlugs, budget);
    expect(candidates).toHaveLength(1);
    expect(budget.getCumulativeMs()).toBeGreaterThanOrEqual(0);
  });

  test('a bare "*" target (empty prefix) never resolves — refuses to match every live slug', () => {
    const pack = packWith([idRule('anything', { pattern: 'ANY-(\\w+)', target: '*' })]);
    const liveSlugs = new Set(['tickets/spa-2442', 'decisions/decision-073-x']);
    const { candidates, ambiguousCount } = resolveIdentifierLinksFromPack(pack, 'ANY-thing here.', liveSlugs);
    expect(candidates).toEqual([]);
    expect(ambiguousCount).toBe(0);
  });
});
