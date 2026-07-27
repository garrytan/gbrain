// Schema-pack inheritance merge (T20 / issue #1749).
//
// Covers the pure merge helper (field-by-field child-wins semantics +
// page_types ordering) AND resolvePack's wiring of extends ancestors +
// borrow_from into the merged manifest. Pure unit tests; disk never touched.

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  mergeInheritedManifest,
  mergeByKey,
  mergeUnion,
  type BorrowedTypes,
} from '../src/core/schema-pack/merge.ts';
import {
  resolvePack,
  invalidatePackCache,
  UnknownPackError,
  _resetPackCacheForTests,
} from '../src/core/schema-pack/registry.ts';
import { AliasCycleError, expandClosure } from '../src/core/schema-pack/closure.ts';
import { inferTypeFromPack } from '../src/core/markdown.ts';
import type {
  SchemaPackManifest,
  PackPageType,
  PackLinkType,
} from '../src/core/schema-pack/manifest-v1.ts';
import { SCHEMA_PACK_API_VERSION } from '../src/core/schema-pack/manifest-v1.ts';

// ── builders ────────────────────────────────────────────────────────────
function pt(name: string, path_prefixes: string[] = [], aliases: string[] = []): PackPageType {
  return { name, primitive: 'entity', path_prefixes, aliases, extractable: false, expert_routing: false };
}
function lt(name: string): PackLinkType {
  return { name };
}
function mk(name: string, over: Partial<SchemaPackManifest> = {}): SchemaPackManifest {
  return {
    api_version: SCHEMA_PACK_API_VERSION,
    name,
    version: '1.0.0',
    description: '',
    gbrain_min_version: '0.38.0',
    extends: null,
    borrow_from: [],
    page_types: [],
    link_types: [],
    frontmatter_links: [],
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    enrichable_types: [],
    filing_rules: [],
    ...over,
  } as SchemaPackManifest;
}
const noBorrow: BorrowedTypes = { page_types: [], link_types: [] };
const names = (arr: { name: string }[]) => arr.map(x => x.name);

function loaderFor(byName: Record<string, SchemaPackManifest>) {
  return async (name: string): Promise<SchemaPackManifest> => {
    const m = byName[name];
    if (!m) throw new UnknownPackError(name);
    return m;
  };
}

beforeEach(() => _resetPackCacheForTests());

// ── 1. parent types visible; override replaces ──────────────────────────
describe('mergeInheritedManifest — page_types', () => {
  test('parent page_types are visible in the child (the core bug)', () => {
    const base = mk('base', { page_types: [pt('person'), pt('company')] });
    const child = mk('child', { extends: 'base', page_types: [pt('paper')] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    expect(names(merged.page_types).sort()).toEqual(['company', 'paper', 'person']);
  });

  test('child override replaces a same-named parent type (no duplicate)', () => {
    const base = mk('base', { page_types: [pt('person', ['people/'])] });
    const childPerson = pt('person', ['humans/']);
    const child = mk('child', { extends: 'base', page_types: [childPerson] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    const persons = merged.page_types.filter(p => p.name === 'person');
    expect(persons).toHaveLength(1);
    expect(persons[0].path_prefixes).toEqual(['humans/']); // child value won
  });

  // ── 2. ordering: new prepended, override in place ────────────────────
  test('new child type is prepended → its path_prefix wins in inferType', () => {
    // base "note" has the BROAD prefix; child adds a NARROWER "paper".
    const base = mk('base', { page_types: [pt('note', ['notes/'])] });
    const child = mk('child', { extends: 'base', page_types: [pt('paper', ['notes/papers/'])] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    // paper is prepended, so first-match-wins picks it for the overlapping path.
    expect(merged.page_types[0].name).toBe('paper');
    expect(inferTypeFromPack('notes/papers/x.md', merged)).toBe('paper');
    expect(inferTypeFromPack('notes/other.md', merged)).toBe('note');
  });

  test('override of a base type keeps the ancestor position (base priority intact)', () => {
    // base intentionally orders [strong, person]; child overrides person only.
    const base = mk('base', { page_types: [pt('strong', ['s/']), pt('person', ['p/'])] });
    const child = mk('child', { extends: 'base', page_types: [pt('person', ['p/', 'people/'])] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    // strong stays first; the override does NOT hoist person to the front.
    expect(names(merged.page_types)).toEqual(['strong', 'person']);
    expect(inferTypeFromPack('s/x.md', merged)).toBe('strong');
  });

  test('extends:null → full override, ancestors ignored', () => {
    const child = mk('solo', { extends: null, page_types: [pt('only')] });
    const merged = mergeInheritedManifest([], child, noBorrow);
    expect(names(merged.page_types)).toEqual(['only']);
  });

  test('a NEW type from a MIDDLE pack is prepended too (no 2-vs-3-level asymmetry)', () => {
    // base "note" (broad prefix); a MIDDLE parent adds narrower "paper";
    // grandchild redeclares nothing. paper must still win the overlapping path
    // — its priority can't depend on whether investor is active directly or as
    // a middle pack under everything. ancestorsBaseFirst = [base, parent].
    const base = mk('base', { page_types: [pt('note', ['notes/'])] });
    const parent = mk('parent', { extends: 'base', page_types: [pt('paper', ['notes/papers/'])] });
    const grandchild = mk('gc', { extends: 'parent', page_types: [] });
    const merged = mergeInheritedManifest([base, parent], grandchild, noBorrow);
    expect(merged.page_types[0].name).toBe('paper'); // prepended, not appended after base
    expect(inferTypeFromPack('notes/papers/x.md', merged)).toBe('paper');
    expect(inferTypeFromPack('notes/other.md', merged)).toBe('note');
  });

  test('3-level override keeps base position; new middle type still prepended', () => {
    // base [strong(s/), person(p/)]; parent overrides person AND adds new mid(m/);
    // child adds new kid(k/). Order: [kid, mid, strong, person] — base pair keeps
    // its curated order, new types prepend nearest-first.
    const base = mk('base', { page_types: [pt('strong', ['s/']), pt('person', ['p/'])] });
    const parent = mk('parent', {
      extends: 'base',
      page_types: [pt('person', ['p/', 'people/']), pt('mid', ['m/'])],
    });
    const child = mk('child', { extends: 'parent', page_types: [pt('kid', ['k/'])] });
    const merged = mergeInheritedManifest([base, parent], child, noBorrow);
    expect(names(merged.page_types)).toEqual(['kid', 'mid', 'strong', 'person']);
    // parent's person override won its value while keeping base position.
    expect(merged.page_types.find(p => p.name === 'person')!.path_prefixes).toEqual(['p/', 'people/']);
  });
});

// ── 3. the other keyed fields (the coverage #1838 lacks) ────────────────
describe('mergeInheritedManifest — link/frontmatter/enrichable/filing', () => {
  const base = mk('base', {
    link_types: [lt('founded'), lt('works_at')],
    frontmatter_links: [{ page_type: 'person', fields: ['company'], link_type: 'works_at' }],
    enrichable_types: [{ type: 'person', rubric: 'person-default' }],
    filing_rules: [{ kind: 'person', directory: 'people/', examples: [] }],
  });
  const child = mk('child', {
    extends: 'base',
    link_types: [lt('invested_in'), lt('works_at')], // works_at overrides
    frontmatter_links: [{ page_type: 'person', fields: ['org'], link_type: 'member_of' }],
    enrichable_types: [{ type: 'paper', rubric: 'paper-default' }],
    filing_rules: [{ kind: 'paper', directory: 'papers/', examples: [] }],
  });
  const merged = mergeInheritedManifest([base], child, noBorrow);

  test('link_types merge child-wins by name', () => {
    expect(names(merged.link_types).sort()).toEqual(['founded', 'invested_in', 'works_at']);
  });
  test('frontmatter_links merge on composite (page_type, link_type)', () => {
    // Different link_type for same page_type → both coexist.
    const keys = merged.frontmatter_links.map(f => `${f.page_type}/${f.link_type}`).sort();
    expect(keys).toEqual(['person/member_of', 'person/works_at']);
  });
  test('enrichable_types + filing_rules merge', () => {
    expect(merged.enrichable_types.map(e => e.type).sort()).toEqual(['paper', 'person']);
    expect(merged.filing_rules.map(f => f.kind).sort()).toEqual(['paper', 'person']);
  });
});

// ── 4. takes_kinds union ─────────────────────────────────────────────────
describe('mergeInheritedManifest — takes_kinds union', () => {
  test('child omitting takes_kinds keeps the parent set', () => {
    const base = mk('base', { takes_kinds: ['fact', 'take', 'bet', 'hunch', 'thesis'] });
    const child = mk('child', { extends: 'base' }); // default 4
    const merged = mergeInheritedManifest([base], child, noBorrow);
    expect(merged.takes_kinds).toContain('thesis');
    expect(merged.takes_kinds).toContain('fact');
  });
  test('child additions union with the parent (dedup)', () => {
    const base = mk('base', { takes_kinds: ['fact'] });
    const child = mk('child', { extends: 'base', takes_kinds: ['fact', 'wager'] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    expect(merged.takes_kinds.sort()).toEqual(['fact', 'wager']);
  });
});

// ── 5. phases + calibration_domains are NOT inherited ────────────────────
describe('mergeInheritedManifest — phases/calibration stay child-only', () => {
  test('a child does NOT inherit the parent phases', () => {
    const base = mk('base', { phases: ['extract_atoms'] });
    const child = mk('child', { extends: 'base' }); // declares no phases
    const merged = mergeInheritedManifest([base], child, noBorrow);
    expect(merged.phases).toBeUndefined();
  });
  test('a child does NOT inherit the parent calibration_domains', () => {
    const base = mk('base', {
      calibration_domains: [{ name: 'deal_success', aggregator: 'scalar_brier', page_types: ['deal'] }],
    });
    const child = mk('child', { extends: 'base' });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    expect(merged.calibration_domains).toBeUndefined();
  });
  test('a child keeps its OWN declared phases verbatim', () => {
    const base = mk('base', { phases: ['extract_atoms'] });
    const child = mk('child', { extends: 'base', phases: ['synthesize_concepts'] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    expect(merged.phases).toEqual(['synthesize_concepts']); // NOT unioned with base
  });
});

// ── 6. borrow_from via resolvePack ───────────────────────────────────────
describe('resolvePack — borrow_from materialization', () => {
  test('borrows only the named types/link_types from a non-chain pack', async () => {
    const lens = mk('lens', {
      page_types: [pt('atom'), pt('unrelated')],
      link_types: [lt('derived_from'), lt('noise')],
    });
    const child = mk('child', {
      extends: null,
      page_types: [pt('own')],
      borrow_from: [{ pack: 'lens', types: ['atom'], link_types: ['derived_from'] }],
    });
    const resolved = await resolvePack(child, loaderFor({ lens }));
    expect(names(resolved.manifest.page_types).sort()).toEqual(['atom', 'own']);
    expect(names(resolved.manifest.link_types)).toEqual(['derived_from']);
  });

  test('borrow omitting a category pulls none of it', async () => {
    const lens = mk('lens', { page_types: [pt('atom')], link_types: [lt('x')] });
    const child = mk('child', {
      extends: null,
      borrow_from: [{ pack: 'lens', types: ['atom'] }], // no link_types
    });
    const resolved = await resolvePack(child, loaderFor({ lens }));
    expect(names(resolved.manifest.page_types)).toEqual(['atom']);
    expect(resolved.manifest.link_types).toEqual([]);
  });

  test('missing borrow target throws UnknownPackError (fail-closed)', async () => {
    const child = mk('child', { extends: null, borrow_from: [{ pack: 'ghost', types: ['x'] }] });
    let caught: unknown;
    try {
      await resolvePack(child, loaderFor({}));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownPackError);
  });
});

// ── 7. idempotency ──────────────────────────────────────────────────────
describe('mergeInheritedManifest — idempotency', () => {
  test('redeclaring an identical parent type is a no-op', () => {
    const base = mk('base', { page_types: [pt('person', ['people/'])] });
    const withRedeclare = mk('c', { extends: 'base', page_types: [pt('person', ['people/']), pt('extra')] });
    const withoutRedeclare = mk('c', { extends: 'base', page_types: [pt('extra')] });
    const a = mergeInheritedManifest([base], withRedeclare, noBorrow);
    const b = mergeInheritedManifest([base], withoutRedeclare, noBorrow);
    expect(names(a.page_types).sort()).toEqual(names(b.page_types).sort());
    expect(a.page_types.filter(p => p.name === 'person')).toHaveLength(1);
  });
});

// ── 8. merged totals (what get_active_schema_pack counts) ────────────────
describe('resolvePack — merged manifest is what consumers read', () => {
  test('resolved.manifest.page_types reflects the merged total, not child-only', async () => {
    const base = mk('base', { page_types: [pt('a'), pt('b'), pt('c')] });
    const child = mk('child', { extends: 'base', page_types: [pt('d')] });
    const resolved = await resolvePack(child, loaderFor({ base }));
    // get_active_schema_pack counts `pack.manifest.page_types.length`.
    expect(resolved.manifest.page_types).toHaveLength(4);
  });
});

// ── 9. cycles, cascade, dangling aliases ─────────────────────────────────
describe('resolvePack — closure edge cases across the merged manifest', () => {
  test('a cross-pack alias cycle throws AliasCycleError at resolve', async () => {
    // base a→b, parent b→c, child c→a  ⇒  a→b→c→a cycle only once merged.
    const base = mk('base', { page_types: [pt('a', [], ['b'])] });
    const parent = mk('parent', { extends: 'base', page_types: [pt('b', [], ['c'])] });
    const child = mk('child', { extends: 'parent', page_types: [pt('c', [], ['a'])] });
    let caught: unknown;
    try {
      await resolvePack(child, loaderFor({ base, parent }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AliasCycleError);
  });

  test('editing a borrowed pack cascade-invalidates the borrower', async () => {
    const lens = mk('lens', { page_types: [pt('atom')] });
    const child = mk('child', { extends: null, borrow_from: [{ pack: 'lens', types: ['atom'] }] });
    await resolvePack(child, loaderFor({ lens }));
    const { invalidated } = invalidatePackCache('lens');
    expect(invalidated).toContain('child'); // borrow edge is tracked in the cache chain
  });

  test('a dangling alias target is benign (no throw, closure still resolves)', () => {
    // "x" aliases a type "ghost" that no page_type declares.
    const base = mk('base', { page_types: [pt('x', [], ['ghost'])] });
    const child = mk('child', { extends: 'base', page_types: [pt('y')] });
    const merged = mergeInheritedManifest([base], child, noBorrow);
    // resolvePack would buildAliasGraph(merged) without throwing.
    const closure = expandClosureFromManifest(merged, 'x');
    expect(closure).toContain('ghost');
  });
});

// small local helper to exercise closure on a merged manifest without disk.
import { buildAliasGraph } from '../src/core/schema-pack/closure.ts';
function expandClosureFromManifest(m: SchemaPackManifest, type: string): string[] {
  return expandClosure(type, buildAliasGraph(m));
}

// ── primitives ──────────────────────────────────────────────────────────
describe('mergeByKey / mergeUnion primitives', () => {
  test('mergeByKey keeps first occurrence per key (highest precedence wins)', () => {
    const out = mergeByKey([[{ k: 'a', v: 1 }], [{ k: 'a', v: 2 }, { k: 'b', v: 3 }]], x => x.k);
    expect(out).toEqual([{ k: 'a', v: 1 }, { k: 'b', v: 3 }]);
  });
  test('mergeUnion dedups order-preserving', () => {
    expect(mergeUnion([['a', 'b'], ['b', 'c']])).toEqual(['a', 'b', 'c']);
  });
});
