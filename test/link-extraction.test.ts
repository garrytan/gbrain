import { describe, test, expect, spyOn } from 'bun:test';
import {
  DEFAULT_ENTITY_DIRS,
  extractEntityRefs,
  extractPageLinks,
  inferLinkType,
  parseTimelineEntries,
  isAutoLinkEnabled,
  getEntityDirs,
} from '../src/core/link-extraction.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// ─── DEFAULT_ENTITY_DIRS ───────────────────────────────────────

describe('DEFAULT_ENTITY_DIRS', () => {
  test('is exported and contains the canonical entity dirs', () => {
    expect(DEFAULT_ENTITY_DIRS).toContain('people');
    expect(DEFAULT_ENTITY_DIRS).toContain('companies');
    expect(DEFAULT_ENTITY_DIRS).toContain('meetings');
    expect(DEFAULT_ENTITY_DIRS).toContain('concepts');
    expect(DEFAULT_ENTITY_DIRS).toContain('deal');
    expect(DEFAULT_ENTITY_DIRS).toContain('civic');
    expect(DEFAULT_ENTITY_DIRS).toContain('project');
    expect(DEFAULT_ENTITY_DIRS).toContain('source');
    expect(DEFAULT_ENTITY_DIRS).toContain('media');
    expect(DEFAULT_ENTITY_DIRS).toContain('yc');
  });

  test('is frozen (readonly at runtime)', () => {
    expect(Object.isFrozen(DEFAULT_ENTITY_DIRS)).toBe(true);
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

  test('custom dirs: Johnny Decimal style ([Rushi](01-notes/rushi)) matches when dir is configured', () => {
    const refs = extractEntityRefs('Met [Rushi](01-notes/rushi) for coffee.', ['01-notes']);
    expect(refs.length).toBe(1);
    expect(refs[0]).toEqual({ name: 'Rushi', slug: '01-notes/rushi', dir: '01-notes' });
  });

  test('custom-only dir list replaces defaults — default dirs do not match', () => {
    // When caller supplies an explicit dirs list, only those dirs are used.
    // The default `people/` dir does NOT match.
    const refs = extractEntityRefs('[Alice](people/alice)', ['01-notes']);
    expect(refs).toEqual([]);
  });

  test('omitting dirs uses default list (backwards compatible)', () => {
    const refs = extractEntityRefs('[Alice](people/alice)');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('people/alice');
  });

  // ── Explicit-path wikilinks [[dir/slug]] ──
  //
  // Scope note: only `[[dir/slug]]` and `[[dir/slug|alias]]` are in scope.
  // Bare `[[name]]` wikilinks would need engine page-lookup to resolve,
  // which breaks the pure-function contract of extractEntityRefs. See
  // README for full explanation.

  test('extracts explicit-path wikilinks [[dir/slug]]', () => {
    const refs = extractEntityRefs('See [[people/alice]] for context.');
    expect(refs.length).toBe(1);
    expect(refs[0]).toEqual({ name: 'alice', slug: 'people/alice', dir: 'people' });
  });

  test('extracts wikilinks with alias [[dir/slug|Display Name]]', () => {
    const refs = extractEntityRefs('Met [[people/alice-chen|Alice Chen]] today.');
    expect(refs.length).toBe(1);
    // Display is ignored; name falls back to the last slug segment.
    expect(refs[0].slug).toBe('people/alice-chen');
    expect(refs[0].dir).toBe('people');
    expect(refs[0].name).toBe('alice-chen');
  });

  test('ignores wikilinks when dir is NOT in configured list', () => {
    // `notes/` is not a default entity dir, so [[notes/foo]] is ignored.
    const refs = extractEntityRefs('See [[notes/foo]] for context.');
    expect(refs).toEqual([]);
  });

  test('wikilink dir honors custom dirs param', () => {
    const refs = extractEntityRefs('See [[01-notes/rushi]] for details.', ['01-notes']);
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('01-notes/rushi');
    expect(refs[0].dir).toBe('01-notes');
  });

  test('does NOT extract bare [[name]] wikilinks (out of scope)', () => {
    // Bare wikilinks require engine page-lookup to resolve — out of scope
    // for the pure-function extractor.
    const refs = extractEntityRefs('See [[alice]] for context.');
    expect(refs).toEqual([]);
  });

  test('skips wikilinks inside fenced code blocks', () => {
    const content = [
      'Prose with [[people/alice]].',
      '```',
      '[[people/bob]]',
      '```',
    ].join('\n');
    const refs = extractEntityRefs(content);
    const slugs = refs.map(r => r.slug);
    expect(slugs).toContain('people/alice');
    expect(slugs).not.toContain('people/bob');
  });

  test('skips wikilinks inside inline code', () => {
    const refs = extractEntityRefs('Literal `[[people/ghost]]` in code vs [[people/alice]] real.');
    const slugs = refs.map(r => r.slug);
    expect(slugs).toContain('people/alice');
    expect(slugs).not.toContain('people/ghost');
  });

  test('dedupes markdown-ref and wikilink for the same slug (within extractEntityRefs returns both, caller dedups)', () => {
    // extractEntityRefs does NOT dedupe (documented contract — caller dedups).
    // Both forms should match and return 2 entries.
    const refs = extractEntityRefs('[Alice](people/alice) and [[people/alice]]');
    expect(refs.length).toBe(2);
    expect(refs.map(r => r.slug)).toEqual(['people/alice', 'people/alice']);
  });
});

// ─── extractPageLinks ──────────────────────────────────────────

describe('extractPageLinks', () => {
  test('returns LinkCandidate[] with inferred types', () => {
    const candidates = extractPageLinks(
      '[Alice](people/alice) is the CEO of Acme.',
      {},
      'concept',
    );
    expect(candidates.length).toBeGreaterThan(0);
    const aliceLink = candidates.find(c => c.targetSlug === 'people/alice');
    expect(aliceLink).toBeDefined();
    expect(aliceLink!.linkType).toBe('works_at');
  });

  test('dedups multiple mentions of same entity (within-page dedup)', () => {
    const content = '[Alice](people/alice) said this. Later, [Alice](people/alice) said that.';
    const candidates = extractPageLinks(content, {}, 'concept');
    const aliceLinks = candidates.filter(c => c.targetSlug === 'people/alice');
    expect(aliceLinks.length).toBe(1);
  });

  test('extracts frontmatter source as source-type link', () => {
    const candidates = extractPageLinks('Some content.', { source: 'meetings/2026-01-15' }, 'person');
    const sourceLink = candidates.find(c => c.linkType === 'source');
    expect(sourceLink).toBeDefined();
    expect(sourceLink!.targetSlug).toBe('meetings/2026-01-15');
  });

  test('extracts bare slug references in text', () => {
    const candidates = extractPageLinks('See companies/acme for details.', {}, 'concept');
    const acme = candidates.find(c => c.targetSlug === 'companies/acme');
    expect(acme).toBeDefined();
  });

  test('returns empty when no refs found', () => {
    expect(extractPageLinks('Plain text with no links.', {}, 'concept')).toEqual([]);
  });

  test('meeting page references default to attended type', () => {
    const candidates = extractPageLinks('Attendees: [Alice](people/alice), [Bob](people/bob).', {}, 'meeting');
    const aliceLink = candidates.find(c => c.targetSlug === 'people/alice');
    expect(aliceLink!.linkType).toBe('attended');
  });

  test('custom dirs: [Name](custom-dir/slug) extracted when dir is configured', () => {
    const candidates = extractPageLinks(
      'Met [Rushi](01-notes/rushi) yesterday.',
      {},
      'concept',
      ['01-notes'],
    );
    const rushi = candidates.find(c => c.targetSlug === '01-notes/rushi');
    expect(rushi).toBeDefined();
  });

  test('custom dirs: bare slug references use same dir list', () => {
    const candidates = extractPageLinks(
      'See 01-notes/rushi for details.',
      {},
      'concept',
      ['01-notes'],
    );
    const rushi = candidates.find(c => c.targetSlug === '01-notes/rushi');
    expect(rushi).toBeDefined();
  });

  test('custom-only dir list excludes default dirs from bare slug match', () => {
    // With dirs=['01-notes'], a bare `people/alice` token is NOT extracted.
    const candidates = extractPageLinks(
      'See people/alice for details.',
      {},
      'concept',
      ['01-notes'],
    );
    expect(candidates.find(c => c.targetSlug === 'people/alice')).toBeUndefined();
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

// ─── getEntityDirs ─────────────────────────────────────────────

describe('getEntityDirs', () => {
  test('null config -> DEFAULT_ENTITY_DIRS', async () => {
    const engine = makeFakeEngine(new Map());
    const dirs = await getEntityDirs(engine);
    expect(dirs).toEqual([...DEFAULT_ENTITY_DIRS]);
  });

  test('empty string config -> DEFAULT_ENTITY_DIRS', async () => {
    const engine = makeFakeEngine(new Map([['entity_dirs', '']]));
    const dirs = await getEntityDirs(engine);
    expect(dirs).toEqual([...DEFAULT_ENTITY_DIRS]);
  });

  test('valid single custom dir -> union with defaults', async () => {
    const engine = makeFakeEngine(new Map([['entity_dirs', '01-notes']]));
    const dirs = await getEntityDirs(engine);
    expect(dirs).toContain('01-notes');
    // defaults preserved
    for (const d of DEFAULT_ENTITY_DIRS) expect(dirs).toContain(d);
  });

  test('multiple comma-separated dirs with whitespace -> parsed and unioned', async () => {
    const engine = makeFakeEngine(new Map([['entity_dirs', ' 01-notes , 02-projects ,03-archive']]));
    const dirs = await getEntityDirs(engine);
    expect(dirs).toContain('01-notes');
    expect(dirs).toContain('02-projects');
    expect(dirs).toContain('03-archive');
  });

  test('duplicate custom dir overlapping with defaults -> no duplicates', async () => {
    const engine = makeFakeEngine(new Map([['entity_dirs', 'people,01-notes']]));
    const dirs = await getEntityDirs(engine);
    const peopleCount = dirs.filter(d => d === 'people').length;
    expect(peopleCount).toBe(1);
    expect(dirs).toContain('01-notes');
  });

  test('entity_dirs_mode=replace -> only custom list, no defaults', async () => {
    const engine = makeFakeEngine(new Map([
      ['entity_dirs', '01-notes,02-projects'],
      ['entity_dirs_mode', 'replace'],
    ]));
    const dirs = await getEntityDirs(engine);
    expect(dirs).toEqual(['01-notes', '02-projects']);
    // defaults NOT included in replace mode
    expect(dirs).not.toContain('people');
    expect(dirs).not.toContain('companies');
  });

  test('entity_dirs_mode=replace with empty entity_dirs -> defaults (empty replace is meaningless)', async () => {
    const engine = makeFakeEngine(new Map([
      ['entity_dirs', ''],
      ['entity_dirs_mode', 'replace'],
    ]));
    const dirs = await getEntityDirs(engine);
    expect(dirs).toEqual([...DEFAULT_ENTITY_DIRS]);
  });

  test('invalid entry (uppercase) -> warn + return defaults', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const engine = makeFakeEngine(new Map([['entity_dirs', '01-notes,BAD_DIR']]));
      const dirs = await getEntityDirs(engine);
      expect(dirs).toEqual([...DEFAULT_ENTITY_DIRS]);
      expect(warnSpy).toHaveBeenCalled();
      const firstCallArg = warnSpy.mock.calls[0]![0];
      expect(firstCallArg).toContain('entity_dirs rejected');
      expect(firstCallArg).toContain('BAD_DIR');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('invalid entry (starts with dash) -> warn + return defaults', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const engine = makeFakeEngine(new Map([['entity_dirs', '-bad']]));
      const dirs = await getEntityDirs(engine);
      expect(dirs).toEqual([...DEFAULT_ENTITY_DIRS]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('invalid entry (contains slash) -> warn + return defaults', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const engine = makeFakeEngine(new Map([['entity_dirs', 'people/extra']]));
      const dirs = await getEntityDirs(engine);
      expect(dirs).toEqual([...DEFAULT_ENTITY_DIRS]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
