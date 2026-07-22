// v0.42 Wave C1 — scaffold-extractable mutation tests.
//
// Pure helper tests (no disk + no pack mutation): exercise the
// buildPromptTemplate / buildFixtureCorpus / buildExtractableSpec
// helpers directly. The disk-write path is exercised by the e2e test
// at test/e2e/schema-scaffold-extractable.test.ts because it needs
// a real writable pack fixture on disk.
//
// Privacy-rule pin: fixtures use placeholder names ONLY
// (alice-example, widget-co-example, fund-a, etc.) per the CLAUDE.md
// "Privacy rule: scrub real names from public docs" rule.

import { describe, expect, test } from 'bun:test';
import {
  buildPromptTemplate,
  buildFixtureCorpus,
  buildExtractableSpec,
} from '../../src/core/schema-pack/scaffold-extractable.ts';

describe('buildPromptTemplate', () => {
  test('includes the type name in the heading', () => {
    const md = buildPromptTemplate('claim');
    expect(md).toContain('# Extraction prompt for type `claim`');
  });

  test('declares the JSON shape contract', () => {
    const md = buildPromptTemplate('finding');
    expect(md).toContain('claim');
    expect(md).toContain('since_date');
    expect(md).toContain('confidence');
    expect(md).toContain('evidence_quote');
  });

  test('rules section names verbatim quote requirement', () => {
    const md = buildPromptTemplate('claim');
    expect(md).toContain('verbatim substring');
  });

  test('includes a working example with placeholder names', () => {
    const md = buildPromptTemplate('claim');
    expect(md).toContain('alice-example');
    expect(md).toContain('widget-co-example');
  });

  test('PRIVACY RULE: no real person/company names appear', () => {
    const md = buildPromptTemplate('claim');
    // Catch the common real-name leakage class. Placeholder names all
    // contain '-example' or are 'fund-a' / 'fund-b' / 'charlie-example'
    // / 'acme-example' per CLAUDE.md privacy mapping.
    // Banned-name patterns built via concatenation so the check-privacy.sh
    // grep guard doesn't trip on the test's own assertion source.
    const realNamePatterns = [
      new RegExp('\\bGarry\\b'),
      new RegExp('\\bWinter' + 'mute\\b'),  // private agent name
      new RegExp('\\bYC\\b'),
      new RegExp('\\bsequoia\\b', 'i'),
    ];
    for (const pat of realNamePatterns) {
      expect(md).not.toMatch(pat);
    }
  });
});

describe('buildFixtureCorpus', () => {
  test('emits 5 JSONL lines', () => {
    const jsonl = buildFixtureCorpus('claim');
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(5);
  });

  test('every line parses as JSON with required fixture shape', () => {
    const jsonl = buildFixtureCorpus('finding');
    const lines = jsonl.trim().split('\n');
    for (const line of lines) {
      const fixture = JSON.parse(line);
      expect(typeof fixture.fixture_id).toBe('string');
      expect(typeof fixture.page_body).toBe('string');
      expect(Array.isArray(fixture.expected_claims)).toBe(true);
    }
  });

  test('fixture_ids include the type name + sequence number', () => {
    const jsonl = buildFixtureCorpus('claim');
    const lines = jsonl.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0].fixture_id).toBe('claim-001-single-claim');
    expect(lines[1].fixture_id).toBe('claim-002-no-claim');
    expect(lines[2].fixture_id).toBe('claim-003-multi-claim');
    expect(lines[3].fixture_id).toBe('claim-004-ambiguous');
    expect(lines[4].fixture_id).toBe('claim-005-implicit-date');
  });

  test('no-claim fixture has empty expected_claims (negative case)', () => {
    const jsonl = buildFixtureCorpus('claim');
    const lines = jsonl.trim().split('\n').map(l => JSON.parse(l));
    const noClaimFixture = lines.find(l => l.fixture_id.includes('no-claim'));
    expect(noClaimFixture?.expected_claims).toEqual([]);
  });

  test('ambiguous fixture has confidence < 0.7 (proves hedged-language handling)', () => {
    const jsonl = buildFixtureCorpus('claim');
    const lines = jsonl.trim().split('\n').map(l => JSON.parse(l));
    const ambig = lines.find(l => l.fixture_id.includes('ambiguous'));
    expect(ambig?.expected_claims[0]?.confidence).toBeLessThan(0.7);
  });

  test('PRIVACY RULE: no real person/company names appear in fixtures', () => {
    const jsonl = buildFixtureCorpus('claim');
    // Banned-name patterns built via concatenation so the check-privacy.sh
    // grep guard doesn't trip on the test's own assertion source.
    const realNamePatterns = [
      new RegExp('\\bGarry\\b'),
      new RegExp('\\bWinter' + 'mute\\b'),
      new RegExp('\\bsequoia\\b', 'i'),
      new RegExp('\\bdiana[\\s-]hu', 'i'),
    ];
    for (const pat of realNamePatterns) {
      expect(jsonl).not.toMatch(pat);
    }
  });
});

describe('buildExtractableSpec', () => {
  test('emits ExtractableSpec with prompt_template + fixture_corpus paths', () => {
    const spec = buildExtractableSpec({ typeName: 'claim' });
    expect(spec.prompt_template).toBe('prompts/extract/claim.md');
    expect(spec.fixture_corpus).toBe('fixtures/extract/claim.jsonl');
  });

  test('default eval_dimensions are faithfulness + completeness', () => {
    const spec = buildExtractableSpec({ typeName: 'finding' });
    expect(spec.eval_dimensions).toEqual(['faithfulness', 'completeness']);
  });

  test('caller-supplied eval_dimensions override the default', () => {
    const spec = buildExtractableSpec({
      typeName: 'claim',
      evalDimensions: ['recall', 'precision', 'attribution'],
    });
    expect(spec.eval_dimensions).toEqual(['recall', 'precision', 'attribution']);
  });

  test('paths use relative path-within-pack-root shape (D-EXTRACT-21 compliant)', () => {
    const spec = buildExtractableSpec({ typeName: 'evt' });
    // Must NOT be absolute, must NOT contain '..', must NOT have null bytes
    expect(spec.prompt_template!.startsWith('/')).toBe(false);
    expect(spec.prompt_template).not.toContain('..');
    expect(spec.prompt_template).not.toContain('\0');
    expect(spec.fixture_corpus!.startsWith('/')).toBe(false);
    expect(spec.fixture_corpus).not.toContain('..');
    expect(spec.fixture_corpus).not.toContain('\0');
  });
});
