import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_ENTITY_DIRS,
  extractEntityRefs,
  extractPageLinks,
  inferLinkType,
  parseTimelineEntries,
  isAutoLinkEnabled,
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
