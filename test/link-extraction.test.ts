import { describe, test, expect } from 'bun:test';
import {
  extractEntityRefs,
  extractPageLinks,
  inferLinkType,
  parseTimelineEntries,
  isAutoLinkEnabled,
} from '../src/core/link-extraction.ts';
import type { BrainEngine } from '../src/core/engine.ts';

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
