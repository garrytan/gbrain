/**
 * Fail-closed citation validation for `gbrain enrich --thin` output.
 * Pure — no engine, no I/O. `resolveSlug` is a plain in-memory fake so the
 * whole pipeline (parse → factual-need heuristic → sentence split → resolve →
 * quarantine → reconstruct) runs hermetically and fast.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseCitationTarget,
  parseCitationTargets,
  extractCitationBrackets,
  looksFactualClaim,
  splitProseClaims,
  validateEnrichCitations,
  UNVERIFIED_HEADING,
  type CitationTarget,
  type ResolveSlugFn,
} from '../../src/core/enrich/citation-validation.ts';

// ---------------------------------------------------------------------------
// parseCitationTarget / parseCitationTargets — shape validation.
// ---------------------------------------------------------------------------

describe('parseCitationTarget', () => {
  test('bare slug (single segment)', () => {
    expect(parseCitationTarget('acme-corp')).toEqual({ slug: 'acme-corp' });
  });
  test('bare slug (multi-segment)', () => {
    expect(parseCitationTarget('people/alice-example')).toEqual({ slug: 'people/alice-example' });
  });
  test('source-qualified slug', () => {
    expect(parseCitationTarget('google-mail:people/alice-example')).toEqual({
      sourceId: 'google-mail',
      slug: 'people/alice-example',
    });
  });
  test('trims surrounding whitespace', () => {
    expect(parseCitationTarget('  people/alice  ')).toEqual({ slug: 'people/alice' });
  });
  test('rejects empty', () => {
    expect(parseCitationTarget('')).toBeNull();
    expect(parseCitationTarget('   ')).toBeNull();
  });
  test('rejects a date range (spaces + en-dash)', () => {
    expect(parseCitationTarget('calendar/2022/11 – calendar/2023/02')).toBeNull();
  });
  test('rejects prose glued onto a real-looking slug', () => {
    expect(parseCitationTarget('people/alice-example and related calendar entries')).toBeNull();
  });
  test('rejects plain English (no slug shape at all)', () => {
    expect(parseCitationTarget('email domain')).toBeNull();
  });
  test('rejects an invalid source id before the colon', () => {
    // Source ids are lowercase alnum + interior hyphens only (SOURCE_ID_RE);
    // an underscore or leading hyphen must not be accepted as a qualifier.
    expect(parseCitationTarget('my_source:people/alice')).toBeNull();
  });
  test('rejects a malformed slug after a valid source id', () => {
    expect(parseCitationTarget('google-mail:not a slug')).toBeNull();
  });
});

describe('parseCitationTargets', () => {
  test('single target', () => {
    expect(parseCitationTargets('people/alice')).toEqual([{ slug: 'people/alice' }]);
  });
  test('comma-separated targets, all valid', () => {
    expect(parseCitationTargets('people/alice, people/bob')).toEqual([
      { slug: 'people/alice' },
      { slug: 'people/bob' },
    ]);
  });
  test('semicolon-separated targets, all valid', () => {
    expect(parseCitationTargets('people/alice; companies/acme')).toEqual([
      { slug: 'people/alice' },
      { slug: 'companies/acme' },
    ]);
  });
  test('one bad target invalidates the whole citation', () => {
    expect(parseCitationTargets('people/alice, email domain')).toBeNull();
  });
  test('empty bracket content is malformed', () => {
    expect(parseCitationTargets('')).toBeNull();
    expect(parseCitationTargets('   ')).toBeNull();
  });
  test('the observed date-range shape is malformed', () => {
    expect(parseCitationTargets('calendar/2022/11 – calendar/2023/02')).toBeNull();
  });
});

describe('extractCitationBrackets', () => {
  test('finds every [Source: ...] and captures raw content', () => {
    const text = 'Alice founded Acme. [Source: people/alice] She raised money. [Source: companies/acme]';
    expect(extractCitationBrackets(text)).toEqual(['people/alice', 'companies/acme']);
  });
  test('none present → empty array', () => {
    expect(extractCitationBrackets('no citations here')).toEqual([]);
  });
  test('case-insensitive on the Source: label', () => {
    expect(extractCitationBrackets('[source: people/alice]')).toEqual(['people/alice']);
  });
});

// ---------------------------------------------------------------------------
// looksFactualClaim — does this claim need a citation at all?
// ---------------------------------------------------------------------------

describe('looksFactualClaim', () => {
  test('long factual sentence needs a citation', () => {
    expect(looksFactualClaim('Alice co-founded WidgetCo in 2025 and leads its design team.')).toBe(true);
  });
  test('short label does not', () => {
    expect(looksFactualClaim('Product design lead.')).toBe(false);
  });
  test('key-value line does not', () => {
    expect(looksFactualClaim('**Status:** Active')).toBe(false);
  });
  test('empty does not', () => {
    expect(looksFactualClaim('')).toBe(false);
    expect(looksFactualClaim('   ')).toBe(false);
  });
  test('heading-shaped text does not', () => {
    expect(looksFactualClaim('## Overview')).toBe(false);
  });
  test('short bullet with a founding verb still needs one even under 40 chars', () => {
    expect(looksFactualClaim('- Founded Acme in 2020.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// splitProseClaims — a trailing citation must stay glued to its sentence.
// ---------------------------------------------------------------------------

describe('splitProseClaims', () => {
  test('single sentence with trailing citation stays one claim', () => {
    const out = splitProseClaims('Alice founded WidgetCo. [Source: people/alice]');
    expect(out).toEqual(['Alice founded WidgetCo. [Source: people/alice]']);
  });
  test('two cited sentences split into two claims, each keeping its own citation', () => {
    const out = splitProseClaims(
      'Alice founded WidgetCo. [Source: x] She also raised a seed round. [Source: y]',
    );
    expect(out).toEqual([
      'Alice founded WidgetCo. [Source: x]',
      'She also raised a seed round. [Source: y]',
    ]);
  });
  test('sentence with no citation splits normally', () => {
    const out = splitProseClaims('Alice founded WidgetCo. She raised a seed round.');
    expect(out).toEqual(['Alice founded WidgetCo.', 'She raised a seed round.']);
  });
  test('multiple back-to-back citation brackets on one sentence stay attached', () => {
    const out = splitProseClaims('Alice founded WidgetCo. [Source: x] [Source: y]');
    expect(out).toEqual(['Alice founded WidgetCo. [Source: x] [Source: y]']);
  });
});

// ---------------------------------------------------------------------------
// validateEnrichCitations — full pipeline. resolveSlug is a fake in-memory
// page-existence check: only slugs in `known` resolve.
// ---------------------------------------------------------------------------

function fakeResolver(known: string[]): ResolveSlugFn {
  const set = new Set(known);
  return async (t: CitationTarget) => set.has(t.sourceId ? `${t.sourceId}:${t.slug}` : t.slug);
}

describe('validateEnrichCitations — clean page', () => {
  test('every citation resolves → unchanged, no quarantine', async () => {
    const body = [
      '## Overview',
      'Alice Example co-founded WidgetCo in 2025 and leads its design team. [Source: people/bob-example]',
      '',
      '## Role',
      'Product design lead.',
    ].join('\n');
    const result = await validateEnrichCitations(body, fakeResolver(['people/bob-example']));
    expect(result.sentencesQuarantined).toBe(0);
    expect(result.citationsInvalid).toBe(0);
    expect(result.citationsOk).toBe(1);
    expect(result.compiledTruth).toContain('## Overview');
    expect(result.compiledTruth).toContain('[Source: people/bob-example]');
    expect(result.compiledTruth).not.toContain(UNVERIFIED_HEADING);
  });

  test('a bare label with no citation is left alone (not "factual")', async () => {
    const body = '## Role\nProduct design lead.';
    const result = await validateEnrichCitations(body, fakeResolver([]));
    expect(result.sentencesQuarantined).toBe(0);
    expect(result.compiledTruth).toBe(body);
  });
});

describe('validateEnrichCitations — malformed shapes (discrimination fixtures)', () => {
  test('date-range citation is quarantined', async () => {
    const body =
      'Alice worked at Acme during a multi-year stretch leading product. ' +
      '[Source: calendar/2022/11 – calendar/2023/02]';
    const result = await validateEnrichCitations(body, fakeResolver(['calendar/2022/11', 'calendar/2023/02']));
    expect(result.sentencesQuarantined).toBe(1);
    expect(result.citationsOk).toBe(0);
    expect(result.citationsInvalid).toBe(1);
    expect(result.compiledTruth).toContain(UNVERIFIED_HEADING);
    expect(result.compiledTruth).toContain('calendar/2022/11');
    expect(result.quarantined[0].reason).toContain('malformed citation target');
  });

  test('a real slug with trailing prose is quarantined', async () => {
    const body =
      'Alice met the team at several syncs over the year. ' +
      '[Source: people/alice-example and related calendar entries]';
    const result = await validateEnrichCitations(body, fakeResolver(['people/alice-example']));
    expect(result.sentencesQuarantined).toBe(1);
    expect(result.quarantined[0].reason).toContain('malformed citation target');
  });

  test('plain-English "citation" (not a slug) is quarantined', async () => {
    const body = 'Alice can be reached at her work email address most days. [Source: email domain]';
    const result = await validateEnrichCitations(body, fakeResolver([]));
    expect(result.sentencesQuarantined).toBe(1);
    expect(result.quarantined[0].reason).toContain('malformed citation target');
  });

  test('a well-formed but nonexistent slug is quarantined as unresolvable', async () => {
    const body = 'Alice co-founded WidgetCo in 2025 and now leads its design org. [Source: people/nobody-here]';
    const result = await validateEnrichCitations(body, fakeResolver(['people/someone-else']));
    expect(result.sentencesQuarantined).toBe(1);
    expect(result.citationsInvalid).toBe(1);
    expect(result.quarantined[0].reason).toContain('unresolvable citation target');
  });

  test('a factual sentence with no citation at all is quarantined', async () => {
    const body = 'Alice co-founded WidgetCo in 2025 and leads its product design organization today.';
    const result = await validateEnrichCitations(body, fakeResolver([]));
    expect(result.sentencesQuarantined).toBe(1);
    expect(result.citationsInvalid).toBe(1);
    expect(result.quarantined[0].reason).toBe('no citation marker');
  });

  test('multi-target citation: ALL targets must resolve, one miss invalidates it', async () => {
    const body = 'Alice co-founded WidgetCo with Bob and Carol in 2025. [Source: people/bob, people/carol]';
    const result = await validateEnrichCitations(body, fakeResolver(['people/bob'])); // carol missing
    expect(result.sentencesQuarantined).toBe(1);
    expect(result.citationsInvalid).toBe(1);
    expect(result.citationsOk).toBe(0);
  });

  test('multi-target citation resolves when every target exists', async () => {
    const body = 'Alice co-founded WidgetCo with Bob and Carol in 2025. [Source: people/bob, people/carol]';
    const result = await validateEnrichCitations(body, fakeResolver(['people/bob', 'people/carol']));
    expect(result.sentencesQuarantined).toBe(0);
    expect(result.citationsOk).toBe(1);
  });

  test('source-qualified citation resolves against exactly that source', async () => {
    const body = 'Alice founded WidgetCo and has led its engineering team since 2025. [Source: google-mail:people/alice]';
    const resolver: ResolveSlugFn = async (t) =>
      t.sourceId === 'google-mail' && t.slug === 'people/alice';
    const result = await validateEnrichCitations(body, resolver);
    expect(result.sentencesQuarantined).toBe(0);
    expect(result.citationsOk).toBe(1);
  });
});

describe('validateEnrichCitations — structural passthrough', () => {
  test('headings survive even when the only content beneath them is quarantined', async () => {
    const body = [
      '## Overview',
      'Alice co-founded WidgetCo in 2025 and now leads its design org. [Source: people/ghost]',
      '',
      '## Role',
      'Product design lead.',
    ].join('\n');
    const result = await validateEnrichCitations(body, fakeResolver([]));
    expect(result.compiledTruth).toContain('## Overview');
    expect(result.compiledTruth).toContain('## Role');
    expect(result.compiledTruth).toContain('Product design lead.');
    expect(result.compiledTruth).toContain(UNVERIFIED_HEADING);
    // The bad claim only shows up AFTER the Unverified heading, not under
    // "## Overview" where the model originally put it.
    const overviewIdx = result.compiledTruth.indexOf('## Overview');
    const roleIdx = result.compiledTruth.indexOf('## Role');
    const noticeIdx = result.compiledTruth.indexOf(UNVERIFIED_HEADING);
    const ghostIdx = result.compiledTruth.indexOf('people/ghost');
    expect(roleIdx).toBeGreaterThan(overviewIdx);
    expect(noticeIdx).toBeGreaterThan(roleIdx);
    expect(ghostIdx).toBeGreaterThan(noticeIdx);
  });

  test('code fences are never scanned, even if fence content looks citation-shaped', async () => {
    const body = '```\nAlice founded WidgetCo. [Source: email domain]\n```';
    const result = await validateEnrichCitations(body, fakeResolver([]));
    expect(result.sentencesQuarantined).toBe(0);
    expect(result.compiledTruth).toBe(body);
  });

  test('bullet list: only the invalid item is removed, valid items and structure survive', async () => {
    const body = [
      '## Notable work',
      '- Founded WidgetCo in 2025. [Source: people/bob-example]',
      '- Ran quarterly all-hands with the founding team. [Source: email domain]',
      '- Advises two portfolio companies. [Source: people/bob-example]',
    ].join('\n');
    const result = await validateEnrichCitations(body, fakeResolver(['people/bob-example']));
    expect(result.sentencesQuarantined).toBe(1);
    expect(result.compiledTruth).toContain('Founded WidgetCo in 2025.');
    expect(result.compiledTruth).toContain('Advises two portfolio companies.');
    expect(result.compiledTruth).toContain(UNVERIFIED_HEADING);
    // The bad item is gone from the "## Notable work" list — it only shows up
    // AFTER the Unverified heading (moved there, not left in place).
    const noticeIdx = result.compiledTruth.indexOf(UNVERIFIED_HEADING);
    const listIdx = result.compiledTruth.indexOf('## Notable work');
    const badIdx = result.compiledTruth.indexOf('Ran quarterly all-hands');
    expect(badIdx).toBeGreaterThan(noticeIdx);
    expect(noticeIdx).toBeGreaterThan(listIdx);
  });

  test('blockquotes and table rows pass through untouched', async () => {
    const body = ['> Alice said something once. [Source: email domain]', '', '| A | B |', '|---|---|', '| 1 | 2 |'].join('\n');
    const result = await validateEnrichCitations(body, fakeResolver([]));
    expect(result.sentencesQuarantined).toBe(0);
    expect(result.compiledTruth).toBe(body);
  });
});
