import { describe, test, expect } from 'bun:test';
import {
  extractEntityRefs,
  extractPageLinks,
  extractFrontmatterLinks,
  inferLinkType,
  makeResolver,
  parseTimelineEntries,
  isAutoLinkEnabled,
  FRONTMATTER_LINK_MAP,
  type SlugResolver,
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
    'people/diana-hu': 'people/diana-hu',
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

