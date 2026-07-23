import { describe, test, expect } from 'bun:test';
import {
  extractEntityRefs,
  extractPageLinks,
  extractFrontmatterLinks,
  imageOfCandidates,
  inferLinkType,
  makeResolver,
  parseTimelineEntries,
  isAutoLinkEnabled,
  FRONTMATTER_LINK_MAP,
  type SlugResolver,
} from '../src/core/link-extraction.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// v0.27.1 cherry-3: image-to-page path-proximity heuristic.
describe('imageOfCandidates', () => {
  test('proposes parallel-directory swap from photos/ to meetings/', () => {
    const out = imageOfCandidates('originals/photos/2026-05-04-foo.jpg');
    expect(out).toContain('originals/meetings/2026-05-04-foo');
  });

  test('proposes same-directory text sibling as fallback', () => {
    const out = imageOfCandidates('originals/photos/foo.png');
    // photos/foo.png → photos/foo (same dir, basename without extension)
    expect(out).toContain('originals/photos/foo');
  });

  test('returns [] when slug has no parent directory', () => {
    expect(imageOfCandidates('foo.jpg')).toEqual([]);
  });

  test('strips image extension from candidate basenames', () => {
    const out = imageOfCandidates('originals/screenshots/whiteboard.heic');
    for (const c of out) {
      expect(c.endsWith('.heic')).toBe(false);
      expect(c.endsWith('.jpg')).toBe(false);
    }
  });

  test('handles uppercase paths case-insensitively', () => {
    const out = imageOfCandidates('Originals/Photos/Foo.JPG');
    expect(out.some(s => s.includes('foo'))).toBe(true);
  });
});

describe('inferLinkType — image type', () => {
  test('image page type returns image_of', () => {
    expect(inferLinkType('image' as any, 'a meeting photo')).toBe('image_of');
  });
});

// ─── extractEntityRefs ─────────────────────────────────────────

describe('extractEntityRefs', () => {
  test('extracts filesystem-relative refs ([Name](../people/slug.md))', () => {
    const refs = extractEntityRefs('Met with [Alice Chen](../people/alice-chen.md) at the office.');
    expect(refs.length).toBe(1);
    expect(refs[0]).toEqual({ name: 'Alice Chen', slug: 'people/alice-chen', dir: 'people' });
  });

  test('extracts engine-style slug refs ([Name](people/slug))', () => {
    const refs = extractEntityRefs('See [Alice Chen](people/alice-chen) for context.');
    expect(refs.length).toBe(1);
    expect(refs[0]).toEqual({ name: 'Alice Chen', slug: 'people/alice-chen', dir: 'people' });
  });

  test('extracts company refs', () => {
    const refs = extractEntityRefs('We invested in [Acme AI](companies/acme-ai).');
    expect(refs.length).toBe(1);
    expect(refs[0].dir).toBe('companies');
    expect(refs[0].slug).toBe('companies/acme-ai');
  });

  test('extracts multiple refs in same content', () => {
    const refs = extractEntityRefs('[Alice](people/alice) and [Bob](people/bob) met at [Acme](companies/acme).');
    expect(refs.length).toBe(3);
    expect(refs.map(r => r.slug)).toEqual(['people/alice', 'people/bob', 'companies/acme']);
  });

  test('handles ../../ deep paths', () => {
    const refs = extractEntityRefs('[Alice](../../people/alice.md)');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('people/alice');
  });

  test('handles unicode names', () => {
    const refs = extractEntityRefs('Met [Héctor García](people/hector-garcia)');
    expect(refs.length).toBe(1);
    expect(refs[0].name).toBe('Héctor García');
  });

  test('returns empty array on no matches', () => {
    expect(extractEntityRefs('No links here.')).toEqual([]);
  });

  test('skips malformed markdown (unclosed bracket)', () => {
    expect(extractEntityRefs('[Alice(people/alice)')).toEqual([]);
  });

  test('skips non-entity dirs (notes/, ideas/ stay if added later but are accepted now)', () => {
    // Current regex targets entity dirs explicitly. Notes/ shouldn't match.
    const refs = extractEntityRefs('See [random](notes/random).');
    expect(refs).toEqual([]);
  });

  test('extracts meeting refs', () => {
    const refs = extractEntityRefs('See [Standup](meetings/2026-01-15-standup).');
    expect(refs.length).toBe(1);
    expect(refs[0].dir).toBe('meetings');
  });

  // ─── issue #972: generic `[[bare-name]]` wikilinks (pass 2c) ─────────────

  test('tags bare wikilinks with needsResolution flag', () => {
    const refs = extractEntityRefs(
      'See [[Fast-Weigh]] and [[2026-05-07-cost-plan-rosa-pilot]] for context.',
    );
    expect(refs.length).toBe(2);
    expect(refs.every(r => r.needsResolution === true)).toBe(true);
    expect(refs.map(r => r.slug).sort()).toEqual([
      '2026-05-07-cost-plan-rosa-pilot',
      'Fast-Weigh',
    ]);
    // dir is empty string when the bare wikilink has no `/`
    for (const r of refs) {
      expect(r.dir).toBe('');
    }
  });

  test('does NOT double-emit when DIR_PATTERN wikilink also passes 2b', () => {
    // [[people/alice]] matches 2b (DIR_PATTERN-gated). 2c must NOT emit
    // a duplicate ref. [[Fast-Weigh]] only matches 2c (no DIR_PATTERN).
    const refs = extractEntityRefs('See [[people/alice]] and [[Fast-Weigh]].');
    const aliceRefs = refs.filter(r => r.slug === 'people/alice');
    const wikiRefs = refs.filter(r => r.slug === 'Fast-Weigh');
    expect(aliceRefs.length).toBe(1);
    expect(aliceRefs[0].needsResolution).toBeUndefined();
    expect(wikiRefs.length).toBe(1);
    expect(wikiRefs[0].needsResolution).toBe(true);
  });

  test('recognizes reference-page wikilinks as concrete targets', () => {
    const refs = extractEntityRefs('See [[reference/mcminnville-market-data]] for source context.');
    expect(refs.length).toBe(1);
    expect(refs[0]).toMatchObject({
      name: 'reference/mcminnville-market-data',
      slug: 'reference/mcminnville-market-data',
      dir: 'reference',
    });
    expect(refs[0].needsResolution).toBeUndefined();
  });

  test('skips qualified-syntax tokens (those belong to 2a)', () => {
    // [[wiki:topics/ai]] looks like 2a's qualified shape — even though
    // it wouldn't satisfy DIR_PATTERN, 2c must not claim it either
    // (the leading `:` is the qualified-syntax tell).
    const refs = extractEntityRefs('See [[wiki:topics/ai]] and [[bare-name]].');
    const bare = refs.find(r => r.slug === 'bare-name');
    expect(bare).toBeDefined();
    expect(bare!.needsResolution).toBe(true);
    const wrongQualified = refs.filter(
      r => r.slug.includes(':') && r.needsResolution === true,
    );
    expect(wrongQualified.length).toBe(0);
  });

  test('a wikilink inside a markdown-link label is inert (codex P2a)', () => {
    // `[see [[acme]]](companies/acme.md)` must NOT spawn a stray generic
    // basename ref for the inner `[[acme]]`. Pass-1 can't match the nested
    // brackets, so the label-wikilink span is masked out of pass 2c.
    const refs = extractEntityRefs('[see [[acme]]](companies/acme.md)');
    expect(refs.filter(r => r.needsResolution)).toEqual([]);
    // But an independent bare wikilink on the same line still emits.
    const refs2 = extractEntityRefs('[Acme](companies/acme) and bare [[acme]] here.');
    expect(refs2.find(r => r.slug === 'companies/acme' && !r.needsResolution)).toBeDefined();
    expect(refs2.find(r => r.slug === 'acme' && r.needsResolution)).toBeDefined();
  });

  test('strips .md suffix from bare wikilinks', () => {
    const refs = extractEntityRefs('See [[struktura.md]] for context.');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('struktura');
    expect(refs[0].needsResolution).toBe(true);
  });

  test('extracts display name from [[slug|Display]] shape', () => {
    const refs = extractEntityRefs('See [[struktura|The Project]] for details.');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('struktura');
    expect(refs[0].name).toBe('The Project');
    expect(refs[0].needsResolution).toBe(true);
  });

  test('strips #anchor from bare wikilinks', () => {
    const refs = extractEntityRefs('Jump to [[notes#section-2]].');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('notes');
    expect(refs[0].needsResolution).toBe(true);
  });

  test('skips bare wikilinks inside fenced code blocks', () => {
    const refs = extractEntityRefs(
      '```\nThis is a code block with [[fake-link]] inside.\n```\nReal: [[real-link]].',
    );
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('real-link');
  });
});

// ─── extractPageLinks ──────────────────────────────────────────

// Resolver that always returns whatever the caller asks for (pretend every
// page exists). Used by tests that only want to exercise the non-resolver
// paths (markdown + bare-slug + frontmatter.source).
const allowAllResolver = {
  resolve: async (name: string) => {
    if (/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(name)) return name;
    return null;
  },
};

// Resolver that never resolves. Used to test that the non-frontmatter
// paths still produce candidates even when no fuzzy matching is possible.
const nullResolver = { resolve: async () => null };

describe('extractPageLinks', () => {
  test('returns LinkCandidate[] with inferred types', async () => {
    const { candidates } = await extractPageLinks(
      'docs/x',
      '[Alice](people/alice) is the CEO of Acme.',
      {},
      'concept',
      allowAllResolver,
    );
    expect(candidates.length).toBeGreaterThan(0);
    const aliceLink = candidates.find(c => c.targetSlug === 'people/alice');
    expect(aliceLink).toBeDefined();
    expect(aliceLink!.linkType).toBe('works_at');
  });

  test('#2011: excerpt window slicing a non-BMP char yields well-formed context', async () => {
    // Reproduce the abort trigger: a markdown ref whose 240-char context window
    // boundary lands inside an emoji's surrogate pair. Pre-fix, the slice kept a
    // lone high surrogate in `context`, which Postgres rejected at the ::jsonb
    // cast and aborted the whole `extract --stale` run.
    const ROCKET = '🚀'; // U+1F680 = [0xD83D, 0xDE80]
    const head = '[Alice](people/alice)';
    const idx = head.indexOf('Alice'); // excerpt centers on ref.name
    const half = 120; // width 240 / 2
    // Place the emoji so its HIGH half sits at index (idx+half-1) and its LOW
    // half at (idx+half) — exactly the excerpt `end` boundary, splitting it.
    const padLen = idx + half - 1 - head.length;
    const content = head + 'x'.repeat(padLen) + ROCKET + ' trailing context';

    // Sanity: confirm the fixture actually splits a pair (the raw window is
    // malformed). If this ever stops being malformed, the regression is moot.
    const rawWindow = content.slice(Math.max(0, idx - half), idx + half);
    expect(rawWindow.isWellFormed()).toBe(false);

    const { candidates } = await extractPageLinks('docs/x', content, {}, 'concept', allowAllResolver);
    const alice = candidates.find(c => c.targetSlug === 'people/alice');
    expect(alice).toBeDefined();
    expect(alice!.context.isWellFormed()).toBe(true);
    expect(JSON.parse(JSON.stringify(alice!.context))).toBe(alice!.context);
  });

  test('dedups multiple mentions of same entity (within-page dedup)', async () => {
    const content = '[Alice](people/alice) said this. Later, [Alice](people/alice) said that.';
    const { candidates } = await extractPageLinks('docs/x', content, {}, 'concept', allowAllResolver);
    const aliceLinks = candidates.filter(c => c.targetSlug === 'people/alice');
    expect(aliceLinks.length).toBe(1);
  });

  test('extracts frontmatter source as source-type link', async () => {
    const { candidates } = await extractPageLinks(
      'docs/x', 'Some content.', { source: 'meetings/2026-01-15' }, 'person', allowAllResolver,
    );
    const sourceLink = candidates.find(c => c.linkType === 'source');
    expect(sourceLink).toBeDefined();
    expect(sourceLink!.targetSlug).toBe('meetings/2026-01-15');
  });

  test('extracts bare slug references in text', async () => {
    const { candidates } = await extractPageLinks(
      'docs/x', 'See companies/acme for details.', {}, 'concept', nullResolver,
    );
    const acme = candidates.find(c => c.targetSlug === 'companies/acme');
    expect(acme).toBeDefined();
  });

  test('returns empty when no refs found', async () => {
    const { candidates } = await extractPageLinks(
      'docs/x', 'Plain text with no links.', {}, 'concept', nullResolver,
    );
    expect(candidates).toEqual([]);
  });

  test('meeting page references default to attended type', async () => {
    const { candidates } = await extractPageLinks(
      'meetings/x', 'Attendees: [Alice](people/alice), [Bob](people/bob).',
      {}, 'meeting' as never, nullResolver,
    );
    const aliceLink = candidates.find(c => c.targetSlug === 'people/alice');
    expect(aliceLink!.linkType).toBe('attended');
  });

  // ─── issue #972: bare wikilink → resolver.resolveBasenameMatches ─────────

  test('bare wikilink drops silently when globalBasename flag is OFF', async () => {
    // Resolver that WOULD resolve, but we never reach it because the
    // flag is off — this is the back-compat invariant.
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async () => ['projects/struktura'],
    };
    const { candidates } = await extractPageLinks(
      'concepts/knowledge-graph',
      'This relates to [[struktura]].',
      {}, 'concept', resolver,
      // opts.globalBasename omitted (= false)
    );
    expect(candidates.find(c => c.targetSlug === 'projects/struktura')).toBeUndefined();
    expect(candidates).toEqual([]);
  });

  test('bare wikilink emits one candidate per basename match when flag ON', async () => {
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) => {
        if (name === 'struktura') return ['projects/struktura', 'archive/struktura'];
        return [];
      },
    };
    const { candidates } = await extractPageLinks(
      'concepts/knowledge-graph',
      'This relates to [[struktura]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    const targets = candidates.map(c => c.targetSlug).sort();
    expect(targets).toEqual(['archive/struktura', 'projects/struktura']);
    // Both edges stamped with the new edge type + provenance.
    for (const c of candidates) {
      expect(c.linkType).toBe('wikilink_basename');
      expect(c.linkSource).toBe('wikilink-resolved');
    }
  });

  test('bare wikilink with single basename match emits one candidate', async () => {
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) =>
        name === 'struktura' ? ['projects/struktura'] : [],
    };
    const { candidates } = await extractPageLinks(
      'concepts/knowledge-graph',
      'See [[struktura]] for details.',
      {}, 'concept', resolver, { globalBasename: true },
    );
    expect(candidates.length).toBe(1);
    expect(candidates[0].targetSlug).toBe('projects/struktura');
    expect(candidates[0].linkType).toBe('wikilink_basename');
  });

  test('basename self-link is dropped (codex P2c)', async () => {
    // `[[struktura]]` on the page concepts/struktura resolves back to itself —
    // the self-loop must be dropped.
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) =>
        name === 'struktura' ? ['concepts/struktura', 'projects/struktura'] : [],
    };
    const { candidates } = await extractPageLinks(
      'concepts/struktura',                      // the page being processed
      'See [[struktura]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    // Only the OTHER match survives; no self-edge to concepts/struktura.
    expect(candidates.map(c => c.targetSlug)).toEqual(['projects/struktura']);
  });

  test('aliased wikilink resolves the TARGET, not the display text (codex #972)', async () => {
    // `[[struktura|the project]]` must resolve basename `struktura`, never
    // the alias "the project". Regression for the codex-caught bug where
    // extractPageLinks resolved ref.name (display) instead of ref.slug.
    const seen: string[] = [];
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) => {
        seen.push(name);
        return name === 'struktura' ? ['projects/struktura'] : [];
      },
    };
    const { candidates } = await extractPageLinks(
      'concepts/knowledge-graph',
      'This relates to [[struktura|the project]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    expect(seen).toContain('struktura');
    expect(seen).not.toContain('the project');
    expect(candidates.map(c => c.targetSlug)).toEqual(['projects/struktura']);
  });

  test('bare wikilink with zero basename matches drops silently (no dangling row)', async () => {
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async () => [],
    };
    const { candidates } = await extractPageLinks(
      'concepts/x', 'Mention [[never-existed]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    expect(candidates.find(c => c.targetSlug === 'never-existed')).toBeUndefined();
    expect(candidates).toEqual([]);
  });

  test('path-qualified wikilink outside DIR_PATTERN queries by final segment', async () => {
    // `[[notes/struktura]]` (dir not in DIR_PATTERN) falls to the generic
    // pass. The resolver's basename index is keyed by final path segments,
    // so the lookup must strip the dirname — mirroring the FS path
    // (resolveSlugAll). Regression: the raw literal was passed through,
    // which never matched, so these links silently dropped.
    const seen: string[] = [];
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) => {
        seen.push(name);
        return name === 'struktura' ? ['notes/struktura'] : [];
      },
    };
    const { candidates } = await extractPageLinks(
      'concepts/x', 'See [[notes/struktura]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    expect(seen).toContain('struktura');
    expect(seen).not.toContain('notes/struktura');
    expect(candidates.map(c => c.targetSlug)).toEqual(['notes/struktura']);
    expect(candidates[0].linkType).toBe('wikilink_basename');
    expect(candidates[0].linkSource).toBe('wikilink-resolved');
  });

  test('path-qualified wikilink keeps only matches ending with the written path', async () => {
    // The written path disambiguates: `[[notes/struktura]]` must never
    // attach to `wiki/struktura` even though both share the basename.
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) =>
        name === 'struktura' ? ['notes/struktura', 'wiki/struktura'] : [],
    };
    const { candidates } = await extractPageLinks(
      'concepts/x', 'See [[notes/struktura]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    expect(candidates.map(c => c.targetSlug)).toEqual(['notes/struktura']);
  });

  test('path-qualified wikilink matches a deeper real slug by path suffix', async () => {
    // The page lives at vault/notes/struktura; the author wrote the shorter
    // tail `[[notes/struktura]]`. Suffix matching connects them, while the
    // basename-only sibling `wiki/struktura` stays excluded.
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) =>
        name === 'struktura' ? ['vault/notes/struktura', 'wiki/struktura'] : [],
    };
    const { candidates } = await extractPageLinks(
      'concepts/x', 'See [[notes/struktura]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    expect(candidates.map(c => c.targetSlug)).toEqual(['vault/notes/struktura']);
  });

  test('path-qualified self-link is dropped like the bare form', async () => {
    // `[[notes/struktura]]` written on notes/struktura itself must not
    // produce a self-loop (same guard as the bare `[[own-tail]]` case).
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) =>
        name === 'struktura' ? ['notes/struktura'] : [],
    };
    const { candidates } = await extractPageLinks(
      'notes/struktura', 'See [[notes/struktura]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    expect(candidates).toEqual([]);
  });

  test('bare wikilink resolution does not interfere with DIR_PATTERN wikilinks', async () => {
    // 2b refs (people/alice) take the verb-inferred type;
    // 2c refs (struktura) take wikilink_basename. Same call.
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) =>
        name === 'struktura' ? ['projects/struktura'] : [],
    };
    const { candidates } = await extractPageLinks(
      'concepts/x',
      '[[people/alice]] is the lead. The work is [[struktura]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    const alice = candidates.find(c => c.targetSlug === 'people/alice');
    const strk = candidates.find(c => c.targetSlug === 'projects/struktura');
    expect(alice).toBeDefined();
    expect(alice!.linkType).not.toBe('wikilink_basename'); // verb-inferred
    expect(strk).toBeDefined();
    expect(strk!.linkType).toBe('wikilink_basename');
  });

  test('opts.skipFrontmatter suppresses the frontmatter pass', async () => {
    // Real resolver shape that WOULD resolve frontmatter source: too,
    // but skipFrontmatter blocks the path entirely.
    const resolver: SlugResolver = {
      resolve: async (name) =>
        name === 'meetings/2026-01-15' ? 'meetings/2026-01-15' : null,
    };
    const fm = { source: 'meetings/2026-01-15' };
    const withFm = await extractPageLinks(
      'docs/x', 'plain content', fm, 'person', resolver,
      { skipFrontmatter: false },
    );
    const withoutFm = await extractPageLinks(
      'docs/x', 'plain content', fm, 'person', resolver,
      { skipFrontmatter: true },
    );
    expect(withFm.candidates.find(c => c.linkType === 'source')).toBeDefined();
    expect(withoutFm.candidates.find(c => c.linkType === 'source')).toBeUndefined();
    // Issue #972 (codex P2e): skipFrontmatter must return an empty unresolved
    // list (the pass is skipped entirely), never undefined.
    expect(withoutFm.unresolved).toEqual([]);
  });

  test('skipFrontmatter suppresses unresolved frontmatter refs too (codex P2e)', async () => {
    // A frontmatter field the resolver CANNOT resolve normally populates
    // `unresolved`; with skipFrontmatter the whole pass is gone so it's [].
    const resolver: SlugResolver = { resolve: async () => null };
    const fm = { key_people: ['Nobody Known'] };
    const withFm = await extractPageLinks(
      'companies/acme', 'plain content', fm, 'company', resolver,
      { skipFrontmatter: false },
    );
    const withoutFm = await extractPageLinks(
      'companies/acme', 'plain content', fm, 'company', resolver,
      { skipFrontmatter: true },
    );
    expect(withFm.unresolved.length).toBeGreaterThan(0);   // pass ran, ref unresolved
    expect(withoutFm.unresolved).toEqual([]);              // pass skipped
  });

  test('globalBasename does nothing when resolver lacks resolveBasenameMatches', async () => {
    // The frontmatter-only synthetic resolver doesn't implement basename
    // lookup. Make sure we don't blow up — just drop the bare ref.
    const resolver: SlugResolver = { resolve: async () => null };
    const { candidates } = await extractPageLinks(
      'concepts/x', 'See [[struktura]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    expect(candidates).toEqual([]);
  });
});

// ─── inferLinkType ─────────────────────────────────────────────

describe('inferLinkType', () => {
  test('meeting + person ref -> attended', () => {
    expect(inferLinkType('meeting', 'Attendees: Alice')).toBe('attended');
  });

  test('CEO of -> works_at', () => {
    expect(inferLinkType('person', 'Alice is CEO of Acme.')).toBe('works_at');
  });

  test('VP at -> works_at', () => {
    expect(inferLinkType('person', 'Bob, VP at Stripe, said.')).toBe('works_at');
  });

  test('invested in -> invested_in', () => {
    expect(inferLinkType('person', 'YC invested in Acme.')).toBe('invested_in');
  });

  test('founded -> founded', () => {
    expect(inferLinkType('person', 'Alice founded NovaPay.')).toBe('founded');
  });

  test('co-founded -> founded', () => {
    expect(inferLinkType('person', 'Bob co-founded Beta Health.')).toBe('founded');
  });

  test('advises -> advises', () => {
    expect(inferLinkType('person', 'Emily advises Acme on go-to-market.')).toBe('advises');
  });

  test('"board member" alone is too ambiguous (investors also hold board seats) -> mentions', () => {
    // Tightened in v0.10.4 after BrainBench rich-prose surfaced that partner
    // bios ("She sits on the boards of [portfolio company]") were classified
    // as advises. Generic board language now requires explicit advisor/advise
    // rooting to count.
    expect(inferLinkType('person', 'Jane is a board member at Beta Health.')).toBe('mentions');
  });

  test('explicit advisor language -> advises', () => {
    expect(inferLinkType('person', 'Jane is an advisor to Beta Health.')).toBe('advises');
    expect(inferLinkType('person', 'Joined the advisory board at Beta Health.')).toBe('advises');
  });

  test('investment narrative variants -> invested_in', () => {
    expect(inferLinkType('person', 'Wendy led the Series A for Cipher Labs.')).toBe('invested_in');
    expect(inferLinkType('person', 'Bob is an early investor in Acme.')).toBe('invested_in');
    expect(inferLinkType('person', 'She invests in fintech startups.')).toBe('invested_in');
    expect(inferLinkType('person', 'Acme is a portfolio company of Founders Fund.')).toBe('invested_in');
    expect(inferLinkType('person', 'Sequoia led the seed round for Vox.')).toBe('invested_in');
  });

  test('default -> mentions', () => {
    expect(inferLinkType('person', 'Random context with no relationship verbs.')).toBe('mentions');
  });

  test('precedence: founded beats works_at', () => {
    // "founded" appears first in regex precedence
    expect(inferLinkType('person', 'Alice founded Acme and is the CEO of it.')).toBe('founded');
  });

  test('media page -> mentions (not attended)', () => {
    expect(inferLinkType('media', 'Alice attended the workshop.')).toBe('mentions');
  });

  // ─── v0.10.5: works_at residuals (drive 58% → >85% on rich prose) ───

  test('v0.10.5 works_at: rank-prefixed engineer at', () => {
    expect(inferLinkType('person', 'Adam is a senior engineer at Delta.')).toBe('works_at');
    expect(inferLinkType('person', 'She is a staff engineer at Stripe.')).toBe('works_at');
    expect(inferLinkType('person', 'Promoted to principal engineer at Acme.')).toBe('works_at');
  });

  test('v0.10.5 works_at: discipline-prefixed engineer at', () => {
    expect(inferLinkType('person', 'Backend engineer at NovaPay.')).toBe('works_at');
    expect(inferLinkType('person', 'Full-stack engineer at Vox.')).toBe('works_at');
    expect(inferLinkType('person', 'ML engineer at DeepMind.')).toBe('works_at');
    expect(inferLinkType('person', 'Security engineer at Stripe.')).toBe('works_at');
  });

  test('v0.10.5 works_at: possessive time at', () => {
    expect(inferLinkType('person', 'During her time at Goldman, she built the team.')).toBe('works_at');
    expect(inferLinkType('person', 'His time at Delta taught him systems thinking.')).toBe('works_at');
  });

  test('v0.10.5 works_at: leadership verbs beyond "leads engineering"', () => {
    expect(inferLinkType('person', 'She heads up design at Beta.')).toBe('works_at');
    expect(inferLinkType('person', 'He manages engineering at Gamma.')).toBe('works_at');
    expect(inferLinkType('person', 'She leads the platform team at Delta.')).toBe('works_at');
    expect(inferLinkType('person', 'Running product at Stripe.')).toBe('works_at');
  });

  test('v0.10.5 works_at: tenure/stint/role as', () => {
    expect(inferLinkType('person', 'Her tenure as head of engineering was short.')).toBe('works_at');
    expect(inferLinkType('person', 'A brief stint as VP of Product.')).toBe('works_at');
    expect(inferLinkType('person', 'His role at Delta was to unblock the pipeline team.')).toBe('works_at');
  });

  test('v0.10.5 works_at: page-role employee prior for ambiguous context', () => {
    // Per-edge context doesn't mention a work verb, but globalContext establishes
    // the person IS a senior engineer at a company. The employee role prior
    // should bias outbound company refs toward works_at.
    const globalContext = 'Adam Lopez is a senior engineer at Delta. His work is excellent.';
    const perEdgeContext = 'Adam is excellent.';  // no work verb in the window
    expect(inferLinkType('person', perEdgeContext, globalContext, 'companies/delta-3')).toBe('works_at');
  });

  test('v0.10.5 works_at: page-role CTO-of prior', () => {
    const globalContext = 'Beth is the CTO of Prism, shipping their platform.';
    const perEdgeContext = 'Beth is shipping.';  // no work verb near slug
    expect(inferLinkType('person', perEdgeContext, globalContext, 'companies/prism-43')).toBe('works_at');
  });

  // ─── v0.10.5: advises residuals (drive 41% → >85% on rich prose) ───

  test('v0.10.5 advises: "as an advisor" / "as a security advisor"', () => {
    expect(inferLinkType('person', 'Joined Acme as an advisor in 2022.')).toBe('advises');
    expect(inferLinkType('person', 'Brought on as a security advisor.')).toBe('advises');
    expect(inferLinkType('person', 'Serves as a technical advisor to the team.')).toBe('advises');
  });

  test('v0.10.5 advises: prefixed advisor (security advisor to X)', () => {
    expect(inferLinkType('person', 'She is the security advisor to Orbit Labs.')).toBe('advises');
    expect(inferLinkType('person', 'He is a strategic advisor at Prism.')).toBe('advises');
    expect(inferLinkType('person', 'Product advisor to several early-stage startups.')).toBe('advises');
  });

  test('v0.10.5 advises: "in an advisory capacity"', () => {
    expect(inferLinkType('person', 'Engaged with Prism in an advisory capacity.')).toBe('advises');
    expect(inferLinkType('person', 'Continued in an advisory role through 2024.')).toBe('advises');
  });

  test('v0.10.5 advises: advisory engagement / partnership / contract', () => {
    expect(inferLinkType('person', 'Began a formal advisory engagement with Prism.')).toBe('advises');
    expect(inferLinkType('person', 'Signed an advisory contract last year.')).toBe('advises');
    expect(inferLinkType('person', 'Multi-year advisory partnership with Beta.')).toBe('advises');
  });

  test('v0.10.5 advises: page-role "is an advisor" prior', () => {
    // Per-edge window has no advisor verb (just possessive "her work"), but
    // page-level establishes the subject IS an advisor. Prior should fire.
    const globalContext = 'Alice Davis is an advisor at Prism. Her work has been invaluable.';
    const perEdgeContext = 'Alice Davis has been invaluable.';  // no advise verb in window
    expect(inferLinkType('person', perEdgeContext, globalContext, 'companies/prism-43')).toBe('advises');
  });

  test('v0.10.5 advises: "serves as advisor" page prior', () => {
    // Avoid "portfolio" in global context since that trips PARTNER_ROLE_RE.
    // Real advisor pages rarely use "portfolio" (that's a partner word).
    const globalContext = 'Beth serves as advisor to three early-stage startups.';
    const perEdgeContext = 'Beth sees Acme regularly.';
    expect(inferLinkType('person', perEdgeContext, globalContext, 'companies/acme')).toBe('advises');
  });

  // ─── Regression guards: v0.10.5 expansions must not break tightened rules ───

  test('v0.10.5 regression: generic "board member" still resolves to mentions', () => {
    // This was the v0.10.4 tightening. The expanded ADVISES_RE must not
    // re-introduce the false-positive on partner bios.
    expect(inferLinkType('person', 'Jane is a board member at Beta Health.')).toBe('mentions');
  });

  test('v0.10.5 regression: "sits on the board" still mentions (not advises)', () => {
    expect(inferLinkType('person', 'She sits on the board of Acme.')).toBe('mentions');
  });

  test('v0.10.5 regression: "backs companies" still resolves to invested_in via partner prior', () => {
    // Partner prior takes precedence over employee prior.
    const globalContext = 'Wendy is a venture partner who backs companies at the seed stage. Her portfolio is diverse.';
    const perEdgeContext = 'Wendy recently discussed Cipher.';
    expect(inferLinkType('person', perEdgeContext, globalContext, 'companies/cipher-13')).toBe('invested_in');
  });

  test('v0.10.5 regression: partner + advisor co-mention stays invested_in for investee', () => {
    // If someone is both a partner AND mentions advisory work, the outbound
    // companies should lean toward invested_in (partner precedence). This
    // protects against a common pattern where partners say "I also advise X".
    const globalContext = 'Jane is a partner at Accel. She also advises multiple startups.';
    const perEdgeContext = 'Jane has worked with Acme.';
    expect(inferLinkType('person', perEdgeContext, globalContext, 'companies/acme')).toBe('invested_in');
  });
});

// ─── parseTimelineEntries ──────────────────────────────────────

describe('parseTimelineEntries', () => {
  test('parses standard format: - **YYYY-MM-DD** | summary', () => {
    const entries = parseTimelineEntries('- **2026-01-15** | Met with Alice');
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual({ date: '2026-01-15', summary: 'Met with Alice', detail: '' });
  });

  test('parses dash variant: - **YYYY-MM-DD** -- summary', () => {
    const entries = parseTimelineEntries('- **2026-01-15** -- Met with Bob');
    expect(entries.length).toBe(1);
    expect(entries[0].summary).toBe('Met with Bob');
  });

  test('parses single dash: - **YYYY-MM-DD** - summary', () => {
    const entries = parseTimelineEntries('- **2026-01-15** - Met with Carol');
    expect(entries.length).toBe(1);
    expect(entries[0].summary).toBe('Met with Carol');
  });

  test('parses without leading dash: **YYYY-MM-DD** | summary', () => {
    const entries = parseTimelineEntries('**2026-01-15** | Standalone entry');
    expect(entries.length).toBe(1);
  });

  test('parses multiple entries', () => {
    const content = `## Timeline
- **2026-01-15** | First event
- **2026-02-20** | Second event
- **2026-03-10** | Third event`;
    const entries = parseTimelineEntries(content);
    expect(entries.length).toBe(3);
    expect(entries.map(e => e.date)).toEqual(['2026-01-15', '2026-02-20', '2026-03-10']);
  });

  test('skips invalid dates (2026-13-45)', () => {
    const entries = parseTimelineEntries('- **2026-13-45** | Bad date');
    expect(entries.length).toBe(0);
  });

  test('skips invalid dates (2026-02-30)', () => {
    const entries = parseTimelineEntries('- **2026-02-30** | Feb 30 doesnt exist');
    expect(entries.length).toBe(0);
  });

  test('returns empty when no timeline lines found', () => {
    expect(parseTimelineEntries('Just some plain text.')).toEqual([]);
  });

  test('handles mixed content (timeline lines interspersed with prose)', () => {
    const content = `Some intro paragraph.

- **2026-01-15** | An event happened

More prose here.

- **2026-02-20** | Another event`;
    const entries = parseTimelineEntries(content);
    expect(entries.length).toBe(2);
  });
});

// ─── isAutoLinkEnabled ─────────────────────────────────────────

function makeFakeEngine(configMap: Map<string, string | null>): BrainEngine {
  return {
    getConfig: async (key: string) => configMap.get(key) ?? null,
  } as unknown as BrainEngine;
}

describe('isAutoLinkEnabled', () => {
  test('null/undefined -> true (default on)', async () => {
    const engine = makeFakeEngine(new Map());
    expect(await isAutoLinkEnabled(engine)).toBe(true);
  });

  test('"false" -> false', async () => {
    const engine = makeFakeEngine(new Map([['auto_link', 'false']]));
    expect(await isAutoLinkEnabled(engine)).toBe(false);
  });

  test('"FALSE" (case-insensitive) -> false', async () => {
    const engine = makeFakeEngine(new Map([['auto_link', 'FALSE']]));
    expect(await isAutoLinkEnabled(engine)).toBe(false);
  });

  test('"0" -> false', async () => {
    const engine = makeFakeEngine(new Map([['auto_link', '0']]));
    expect(await isAutoLinkEnabled(engine)).toBe(false);
  });

  test('"no" -> false', async () => {
    const engine = makeFakeEngine(new Map([['auto_link', 'no']]));
    expect(await isAutoLinkEnabled(engine)).toBe(false);
  });

  test('"off" -> false', async () => {
    const engine = makeFakeEngine(new Map([['auto_link', 'off']]));
    expect(await isAutoLinkEnabled(engine)).toBe(false);
  });

  test('"true" -> true', async () => {
    const engine = makeFakeEngine(new Map([['auto_link', 'true']]));
    expect(await isAutoLinkEnabled(engine)).toBe(true);
  });

  test('"1" -> true', async () => {
    const engine = makeFakeEngine(new Map([['auto_link', '1']]));
    expect(await isAutoLinkEnabled(engine)).toBe(true);
  });

  test('whitespace and case: "  False  " -> false', async () => {
    const engine = makeFakeEngine(new Map([['auto_link', '  False  ']]));
    expect(await isAutoLinkEnabled(engine)).toBe(false);
  });

  test('garbage value -> true (fail-safe to default)', async () => {
    const engine = makeFakeEngine(new Map([['auto_link', 'garbage']]));
    expect(await isAutoLinkEnabled(engine)).toBe(true);
  });
});

// ─── Frontmatter link extraction (v0.13) ────────────────────────

/**
 * In-memory resolver for frontmatter tests. Maps names to slugs via an
 * explicit fixture map; returns null for anything missing. Mirrors what
 * the real resolver does on a production brain but with deterministic
 * inputs (no pg_trgm, no searchPages).
 */
function makeFixtureResolver(pages: Record<string, string>): SlugResolver {
  return {
    async resolve(name: string, dirHint?: string | string[]) {
      const hints = Array.isArray(dirHint) ? dirHint : (dirHint ? [dirHint] : []);
      // Already a slug — check if present.
      if (/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(name)) {
        return pages[name] ?? null;
      }
      const slugified = name.toLowerCase().replace(/\s+/g, '-');
      for (const hint of hints) {
        if (!hint) continue;
        const candidate = `${hint}/${slugified}`;
        if (pages[candidate]) return candidate;
      }
      return null;
    },
  };
}

describe('extractFrontmatterLinks — field-map coverage', () => {
  const pages = {
    'people/pedro': 'people/pedro',
    'people/garry': 'people/garry',
    'people/alice-example': 'people/alice-example',
    'companies/stripe': 'companies/stripe',
    'companies/brex': 'companies/brex',
    'companies/sequoia': 'companies/sequoia',
    'companies/benchmark': 'companies/benchmark',
    'meetings/2026-04-03': 'meetings/2026-04-03',
    'deal/riveter-seed': 'deal/riveter-seed',
  };
  const resolver = makeFixtureResolver(pages);

  test('person.company → outgoing works_at', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'people/pedro', 'person' as never, { company: 'Stripe' }, resolver,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      fromSlug: 'people/pedro',
      targetSlug: 'companies/stripe',
      linkType: 'works_at',
      linkSource: 'frontmatter',
      originSlug: 'people/pedro',
      originField: 'company',
    });
  });

  test('person.companies (array alias) → multiple works_at edges', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'people/pedro', 'person' as never, { companies: ['Stripe', 'Brex'] }, resolver,
    );
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.fromSlug).toBe('people/pedro');
      expect(c.linkType).toBe('works_at');
      expect(c.targetSlug).toMatch(/^companies\/(stripe|brex)$/);
    }
  });

  test('company.key_people → INCOMING works_at (person → company)', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'companies/stripe', 'company' as never, { key_people: ['Pedro', 'Garry'] }, resolver,
    );
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      // Incoming: from = resolved person, to = the page being written.
      expect(c.targetSlug).toBe('companies/stripe');
      expect(c.fromSlug).toMatch(/^people\/(pedro|garry)$/);
      expect(c.linkType).toBe('works_at');
      expect(c.originSlug).toBe('companies/stripe');
      expect(c.originField).toBe('key_people');
    }
  });

  test('meeting.attendees → INCOMING attended (person → meeting)', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'meetings/2026-04-03', 'meeting' as never, { attendees: ['Pedro', 'Garry'] }, resolver,
    );
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.targetSlug).toBe('meetings/2026-04-03');
      expect(c.linkType).toBe('attended');
      expect(c.fromSlug).toMatch(/^people\/(pedro|garry)$/);
    }
  });

  test('deal.investors (multi-dir hint) → INCOMING invested_in', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'deal/riveter-seed', 'deal' as never,
      { investors: ['Sequoia', 'Benchmark'] }, resolver,
    );
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.targetSlug).toBe('deal/riveter-seed');
      expect(c.linkType).toBe('invested_in');
      expect(c.fromSlug).toMatch(/^companies\/(sequoia|benchmark)$/);
    }
  });

  test('source field → outgoing source edge', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'people/pedro', 'person' as never, { source: 'meetings/2026-04-03' }, resolver,
    );
    const src = candidates.find(c => c.linkType === 'source');
    expect(src).toBeDefined();
    expect(src!.fromSlug).toBe('people/pedro');
    expect(src!.targetSlug).toBe('meetings/2026-04-03');
  });

  test('unresolvable name goes to unresolved list, not candidates', async () => {
    const { candidates, unresolved } = await extractFrontmatterLinks(
      'meetings/x', 'meeting' as never,
      { attendees: ['Pedro', 'Unknown Person'] }, resolver,
    );
    expect(candidates).toHaveLength(1);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toEqual({ field: 'attendees', name: 'Unknown Person' });
  });

  test('bad types (number, null, empty) skipped silently', async () => {
    const { candidates, unresolved } = await extractFrontmatterLinks(
      'meetings/x', 'meeting' as never,
      { attendees: [42, null, '', 'Pedro', { nothing: true }] }, resolver,
    );
    // Only 'Pedro' produces a candidate. 42/null/'' silently skipped.
    // Object without name/slug/title is skipped. No unresolved entry for skipped.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].fromSlug).toBe('people/pedro');
    expect(unresolved).toHaveLength(0);
  });

  test('array of objects: uses .name, carries role into context', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'deal/riveter-seed', 'deal' as never,
      { investors: [{ name: 'Sequoia', role: 'lead' }] }, resolver,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].context).toContain('Sequoia');
    expect(candidates[0].context).toContain('lead');
  });

  test('context enrichment — not bare field name', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'companies/stripe', 'company' as never, { key_people: ['Pedro'] }, resolver,
    );
    // Per plan Finding 7: context must include field + value, not bare 'frontmatter.key_people'.
    expect(candidates[0].context).toBe('frontmatter.key_people: Pedro');
  });

  test('pageType filter — field ignored on non-matching page', async () => {
    // `company` field only fires on person pages. On a concept page it's ignored.
    const { candidates } = await extractFrontmatterLinks(
      'concepts/x', 'concept' as never, { company: 'Stripe' }, resolver,
    );
    expect(candidates).toHaveLength(0);
  });
});

describe('makeResolver — fallback chain', () => {
  // Minimal engine fake with controlled pages + findByTitleFuzzy.
  function makeFakeEngine(
    slugs: string[],
    fuzzyMap: Map<string, { slug: string; similarity: number }> = new Map(),
  ): BrainEngine {
    const lookup = new Set(slugs);
    let getPageCalls = 0;
    let fuzzyCalls = 0;
    let searchCalls = 0;
    const engine = {
      async getPage(slug: string) {
        getPageCalls++;
        return lookup.has(slug) ? { slug } as any : null;
      },
      async findByTitleFuzzy(name: string) {
        fuzzyCalls++;
        return fuzzyMap.get(name) ?? null;
      },
      async searchKeyword() {
        searchCalls++;
        return [];
      },
    } as unknown as BrainEngine;
    (engine as any)._counts = () => ({ getPageCalls, fuzzyCalls, searchCalls });
    return engine;
  }

  test('step 1: slug passthrough', async () => {
    const engine = makeFakeEngine(['people/pedro']);
    const r = makeResolver(engine);
    expect(await r.resolve('people/pedro')).toBe('people/pedro');
  });

  test('step 2: dir-hint construction', async () => {
    const engine = makeFakeEngine(['companies/stripe']);
    const r = makeResolver(engine);
    expect(await r.resolve('Stripe', 'companies')).toBe('companies/stripe');
  });

  test('step 3: pg_trgm fuzzy hit', async () => {
    const engine = makeFakeEngine(
      ['companies/brex'],
      new Map([['Brex Inc', { slug: 'companies/brex', similarity: 0.8 }]]),
    );
    const r = makeResolver(engine);
    expect(await r.resolve('Brex Inc', 'companies')).toBe('companies/brex');
  });

  test('batch mode NEVER calls searchKeyword (deterministic migration)', async () => {
    const engine = makeFakeEngine([]);
    const r = makeResolver(engine, { mode: 'batch' });
    const result = await r.resolve('Unknown Name', 'companies');
    expect(result).toBeNull();
    const counts = (engine as any)._counts();
    expect(counts.searchCalls).toBe(0);
  });

  test('cache: same name → single getPage call', async () => {
    const engine = makeFakeEngine(['people/pedro']);
    const r = makeResolver(engine);
    await r.resolve('people/pedro');
    await r.resolve('people/pedro');
    await r.resolve('people/pedro');
    const counts = (engine as any)._counts();
    expect(counts.getPageCalls).toBe(1);
  });

  test('unresolvable → null (no dead link written)', async () => {
    const engine = makeFakeEngine([]);
    const r = makeResolver(engine, { mode: 'batch' });
    expect(await r.resolve('Nonexistent Person', 'people')).toBeNull();
  });

  // ─── issue #972: resolveBasenameMatches ───────────────────────────────

  // Extended fake engine that also implements `getAllSlugs` so
  // resolveBasenameMatches has something to walk.
  function makeFakeEngineWithSlugs(slugs: string[]): BrainEngine {
    const lookup = new Set(slugs);
    let getAllCalls = 0;
    const engine = {
      async getPage(slug: string) {
        return lookup.has(slug) ? { slug } as any : null;
      },
      async findByTitleFuzzy() { return null; },
      async searchKeyword() { return []; },
      async getAllSlugs() {
        getAllCalls++;
        return new Set(slugs);
      },
    } as unknown as BrainEngine;
    (engine as any)._counts = () => ({ getAllCalls });
    return engine;
  }

  test('resolveBasenameMatches: exact tail hit returns the slug', async () => {
    const engine = makeFakeEngineWithSlugs([
      'projects/struktura',
      'people/alice',
    ]);
    const r = makeResolver(engine);
    expect(await r.resolveBasenameMatches!('struktura')).toEqual(['projects/struktura']);
  });

  test('resolveBasenameMatches: multi-match returns ALL hits', async () => {
    const engine = makeFakeEngineWithSlugs([
      'projects/struktura',
      'archive/struktura',
      'notes/struktura',
    ]);
    const r = makeResolver(engine);
    const out = await r.resolveBasenameMatches!('struktura');
    expect(out.sort()).toEqual([
      'archive/struktura',
      'notes/struktura',
      'projects/struktura',
    ]);
  });

  test('resolveBasenameMatches: case-insensitive fallback', async () => {
    const engine = makeFakeEngineWithSlugs(['companies/fast-weigh']);
    const r = makeResolver(engine);
    // Raw `Fast-Weigh` does not match the lowercase tail, but the
    // lowercased+slugified key does — both should hit.
    expect(await r.resolveBasenameMatches!('fast-weigh')).toEqual(['companies/fast-weigh']);
    expect(await r.resolveBasenameMatches!('Fast-Weigh')).toContain('companies/fast-weigh');
  });

  test('resolveBasenameMatches: no matches returns []', async () => {
    const engine = makeFakeEngineWithSlugs(['projects/struktura']);
    const r = makeResolver(engine);
    expect(await r.resolveBasenameMatches!('never-existed')).toEqual([]);
  });

  test('resolveBasenameMatches: scopes the index by sourceId (codex #972)', async () => {
    // Regression: a bare [[struktura]] in source A must NOT resolve to a
    // same-tail page in source B. makeResolver({sourceId}) must pass the
    // scope to getAllSlugs so the index only contains the source's slugs.
    let sawOpts: any;
    const bySource: Record<string, string[]> = {
      'src-a': ['projects/struktura'],
      'src-b': ['archive/struktura'],
    };
    const engine = {
      async getPage() { return null; },
      async findByTitleFuzzy() { return null; },
      async searchKeyword() { return []; },
      async getAllSlugs(opts?: { sourceId?: string }) {
        sawOpts = opts;
        const sid = opts?.sourceId;
        return new Set(sid ? (bySource[sid] ?? []) : Object.values(bySource).flat());
      },
    } as unknown as BrainEngine;
    const r = makeResolver(engine, { mode: 'batch', sourceId: 'src-a' });
    const out = await r.resolveBasenameMatches!('struktura');
    expect(sawOpts).toEqual({ sourceId: 'src-a' });
    expect(out).toEqual(['projects/struktura']);          // src-a only
    expect(out).not.toContain('archive/struktura');        // no cross-source
  });

  test('resolveBasenameMatches: no sourceId stays brain-wide (back-compat)', async () => {
    let sawOpts: any = 'unset';
    const engine = {
      async getPage() { return null; },
      async findByTitleFuzzy() { return null; },
      async searchKeyword() { return []; },
      async getAllSlugs(opts?: { sourceId?: string }) {
        sawOpts = opts;
        return new Set(['projects/struktura', 'archive/struktura']);
      },
    } as unknown as BrainEngine;
    const r = makeResolver(engine, { mode: 'batch' });
    const out = await r.resolveBasenameMatches!('struktura');
    expect(sawOpts).toBeUndefined();                        // unscoped call
    expect(out.sort()).toEqual(['archive/struktura', 'projects/struktura']);
  });

  test('resolveBasenameMatches: empty input returns []', async () => {
    const engine = makeFakeEngineWithSlugs(['projects/struktura']);
    const r = makeResolver(engine);
    expect(await r.resolveBasenameMatches!('')).toEqual([]);
    expect(await r.resolveBasenameMatches!('   ')).toEqual([]);
  });

  test('resolveBasenameMatches: index built once, reused across calls', async () => {
    const engine = makeFakeEngineWithSlugs([
      'projects/struktura',
      'archive/struktura',
    ]);
    const r = makeResolver(engine);
    await r.resolveBasenameMatches!('struktura');
    await r.resolveBasenameMatches!('struktura');
    await r.resolveBasenameMatches!('struktura');
    // Single getAllSlugs() call across three resolveBasenameMatches calls.
    expect((engine as any)._counts().getAllCalls).toBe(1);
  });

  test('resolveBasenameMatches: degrades gracefully when getAllSlugs missing', async () => {
    // Test seam for engines that don't implement getAllSlugs (legacy / mocks).
    const engine = {
      async getPage() { return null; },
      async findByTitleFuzzy() { return null; },
      async searchKeyword() { return []; },
    } as unknown as BrainEngine;
    const r = makeResolver(engine);
    expect(await r.resolveBasenameMatches!('struktura')).toEqual([]);
  });

  test('resolveBasenameMatches: handles top-level slugs (no `/`)', async () => {
    const engine = makeFakeEngineWithSlugs(['struktura', 'notes/struktura']);
    const r = makeResolver(engine);
    // Both should match because basename of `struktura` is `struktura`.
    const out = await r.resolveBasenameMatches!('struktura');
    expect(out.sort()).toEqual(['notes/struktura', 'struktura']);
  });

  test('opts.sourceId is forwarded to findByTitleFuzzy (twin of #1436 fix)', async () => {
    // Captures every (name, dirPrefix, minSimilarity, sourceId) call so we
    // can assert the resolver threads sourceId through. Without the wire-up,
    // findByTitleFuzzy would be called with sourceId=undefined and the SQL
    // could return cross-source slug suggestions that the FK filter
    // downstream silently drops.
    const calls: Array<{ name: string; dirPrefix?: string; minSimilarity?: number; sourceId?: string }> = [];
    const engine = {
      async getPage() { return null; },
      async findByTitleFuzzy(name: string, dirPrefix?: string, minSimilarity?: number, sourceId?: string) {
        calls.push({ name, dirPrefix, minSimilarity, sourceId });
        return null;
      },
      async searchKeyword() { return []; },
    } as unknown as BrainEngine;
    const r = makeResolver(engine, { mode: 'batch', sourceId: 'src-a' });
    await r.resolve('Alice Example', 'people');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.sourceId === 'src-a')).toBe(true);
  });

  test('opts.sourceId omitted → findByTitleFuzzy receives undefined (back-compat)', async () => {
    const calls: Array<{ sourceId?: string }> = [];
    const engine = {
      async getPage() { return null; },
      async findByTitleFuzzy(_name: string, _dirPrefix?: string, _min?: number, sourceId?: string) {
        calls.push({ sourceId });
        return null;
      },
      async searchKeyword() { return []; },
    } as unknown as BrainEngine;
    const r = makeResolver(engine, { mode: 'batch' });
    await r.resolve('Alice Example', 'people');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.sourceId === undefined)).toBe(true);
  });
});

describe('FRONTMATTER_LINK_MAP integrity', () => {
  test('every mapping has fields + type + direction + dirHint', () => {
    for (const m of FRONTMATTER_LINK_MAP) {
      expect(m.fields.length).toBeGreaterThan(0);
      expect(m.type).toBeTruthy();
      expect(['outgoing', 'incoming']).toContain(m.direction);
      expect(m.dirHint !== undefined).toBe(true);
    }
  });

  test('key_people maps to INCOMING works_at on company page', () => {
    const m = FRONTMATTER_LINK_MAP.find(m => m.fields.includes('key_people'));
    expect(m).toBeDefined();
    expect(m!.direction).toBe('incoming');
    expect(m!.pageType).toBe('company');
    expect(m!.type).toBe('works_at');
  });

  test('attendees maps to INCOMING attended on meeting page', () => {
    const m = FRONTMATTER_LINK_MAP.find(m => m.fields.includes('attendees'));
    expect(m!.direction).toBe('incoming');
    expect(m!.pageType).toBe('meeting');
    expect(m!.type).toBe('attended');
  });

  test('investors uses multi-dir hint (companies/funds/people)', () => {
    const m = FRONTMATTER_LINK_MAP.find(m => m.fields.includes('investors'));
    expect(Array.isArray(m!.dirHint)).toBe(true);
    expect(m!.dirHint).toContain('companies');
    expect(m!.dirHint).toContain('funds');
    expect(m!.dirHint).toContain('people');
  });
});


// ─────────────────────────────────────────────────────────────────
// v0.18.0 Step 4 — qualified wikilink syntax [[source-id:dir/slug]]
// ─────────────────────────────────────────────────────────────────
describe("extractEntityRefs — v0.18.0 qualified wikilinks", () => {
  test("[[wiki:topics/ai]] extracts with sourceId=wiki", () => {
    const refs = extractEntityRefs("See [[concepts/ai]] vs [[wiki:concepts/ai]] for wiki-specific take.");
    // One unqualified + one qualified.
    expect(refs.length).toBe(2);
    const qual = refs.find(r => r.sourceId === "wiki");
    expect(qual).toBeDefined();
    expect(qual!.slug).toBe("concepts/ai");
    expect(qual!.name).toBe("concepts/ai");
    const unqual = refs.find(r => r.sourceId === undefined);
    expect(unqual).toBeDefined();
    expect(unqual!.slug).toBe("concepts/ai");
  });

  test("[[gstack:projects/foo|Display Name]] preserves display + sourceId", () => {
    const refs = extractEntityRefs("See [[gstack:projects/foo|The Foo Project]] for details.");
    expect(refs.length).toBe(1);
    expect(refs[0]).toEqual({ name: "The Foo Project", slug: "projects/foo", dir: "projects", sourceId: "gstack" });
  });

  test("qualified source-id format is validated (must match [a-z0-9-]+ kebab rules)", () => {
    // Uppercase source IDs are not qualified — fall through to unqualified wikilink or no match.
    const refs = extractEntityRefs("Legit: [[yc-media:concepts/seed]] Not legit: [[NotValid:concepts/x]]");
    const qualified = refs.filter(r => r.sourceId);
    expect(qualified.length).toBe(1);
    expect(qualified[0].sourceId).toBe("yc-media");
  });

  test("masking prevents unqualified regex from matching inside a qualified link", () => {
    // Without the mask, [[wiki:concepts/ai]] could also match as
    // unqualified with slug "wiki:concepts/ai" (invalid dir) — the
    // DIR_PATTERN whitelist normally blocks it, but masking is
    // defense-in-depth.
    const refs = extractEntityRefs("Ref: [[wiki:concepts/ai]]");
    expect(refs.length).toBe(1);
    expect(refs[0].sourceId).toBe("wiki");
  });

  test("markdown [Name](path) links always have no sourceId (unqualified by shape)", () => {
    const refs = extractEntityRefs("[Alice](people/alice-chen) met [[wiki:people/bob]]");
    const mdLink = refs.find(r => r.slug === "people/alice-chen");
    expect(mdLink!.sourceId).toBeUndefined();
    const wiki = refs.find(r => r.slug === "people/bob");
    expect(wiki!.sourceId).toBe("wiki");
  });
});

describe("v0.18.0 migration v22 — links_resolution_type", () => {
  test("migration v22 exists with CHECK constraint", async () => {
    const { MIGRATIONS } = await import("../src/core/migrate.ts");
    const v22 = MIGRATIONS.find(m => m.version === 22);
    expect(v22).toBeDefined();
    expect(v22!.name).toBe("links_resolution_type");
    expect(v22!.sql).toContain("ADD COLUMN IF NOT EXISTS resolution_type");
    expect(v22!.sql).toContain("links_resolution_type_check");
    expect(v22!.sql).toContain("qualified");
    expect(v22!.sql).toContain("unqualified");
  });
});


describe('parseTimelineEntries — Format 3: inline [Source: ..., YYYY-MM-DD] citations', () => {
  test('extracts an entry from a dated citation', () => {
    const entries = parseTimelineEntries('Closed the seed round. [Source: board notes, 2025-04-02]');
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2025-04-02');
    expect(entries[0].summary).toBe('Closed the seed round.');
    expect(entries[0].detail).toBe('Source: board notes');
  });

  test('keeps commas inside the citation source', () => {
    const entries = parseTimelineEntries('Alice joined. [Source: email re: offer, signed, 2025-05-10]');
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toBe('Source: email re: offer, signed');
  });

  test('does not double-extract a timeline bullet carrying its own citation', () => {
    const entries = parseTimelineEntries('- **2025-03-18** | Meeting notes [Source: notes, 2025-03-18]');
    expect(entries).toHaveLength(1); // bullet pass only
  });

  test('skips invalid calendar dates and bare citations', () => {
    expect(parseTimelineEntries('Claim. [Source: memo, 2026-13-45]')).toHaveLength(0);
    expect(parseTimelineEntries('[Source: import batch, 2025-07-01]')).toHaveLength(0);
  });
});
