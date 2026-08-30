import { describe, expect, test } from 'bun:test';
import {
  EXTRACT_PROMPT,
  filterConceptLabels,
  mapTrustedSourceQuote,
  parseAtomsOutcome,
} from '../../src/core/cycle/extract-atoms.ts';

describe('extract_atoms source quote guard', () => {
  test('accepts a unique exact quote and returns the original source span', () => {
    const source = 'Before. The exact source sentence. After.';
    expect(mapTrustedSourceQuote(source, 'The exact source sentence.')).toEqual({
      ok: true,
      sourceQuote: 'The exact source sentence.',
    });
  });

  test('maps harmless Markdown and typography normalization to the exact original span', () => {
    const source = 'The **“boring”** path — ship it.';
    expect(mapTrustedSourceQuote(source, 'The "boring" path - ship it.')).toEqual({
      ok: true,
      sourceQuote: 'The **“boring”** path — ship it.',
    });
  });

  test('rejects an ambiguous normalized quote', () => {
    const source = 'Use **boring code** here. Use boring code here.';
    expect(mapTrustedSourceQuote(source, 'Use boring code here.')).toEqual({
      ok: false,
      reason: 'ambiguous_source_quote',
    });
  });

  test('rejects an unsupported quote', () => {
    expect(mapTrustedSourceQuote('Only source-backed claims survive.', 'Invented advice.')).toEqual({
      ok: false,
      reason: 'unsupported_source_quote',
    });
  });

  test('never removes semantic asterisks or unmatched Markdown markers', () => {
    expect(mapTrustedSourceQuote('The result is 2*3=6.', 'The result is 23=6.')).toEqual({
      ok: false,
      reason: 'unsupported_source_quote',
    });
    expect(mapTrustedSourceQuote('An unmatched ** marker stays.', 'An unmatched marker stays.')).toEqual({
      ok: false,
      reason: 'unsupported_source_quote',
    });
    const mentioned = 'Use ** to mean exponent and ` to mark code ** then `.';
    expect(mapTrustedSourceQuote(mentioned, 'Use to mean exponent and to mark code then.')).toEqual({
      ok: false,
      reason: 'unsupported_source_quote',
    });
  });

  test('rejects model quotes and mapped original spans over 200 characters', () => {
    expect(mapTrustedSourceQuote('x'.repeat(201), 'x'.repeat(201))).toEqual({
      ok: false,
      reason: 'source_quote_overlength',
    });
    const source = `a **${'x'.repeat(196)}** b`;
    expect(mapTrustedSourceQuote(source, `a ${'x'.repeat(196)} b`)).toEqual({
      ok: false,
      reason: 'source_span_overlength',
    });
  });
});

describe('extract_atoms prompt and concept trust boundary', () => {
  test('permits privacy abstention with a zero-to-three atom output shape', () => {
    expect(EXTRACT_PROMPT).toContain('0-3 per transcript');
    expect(EXTRACT_PROMPT).toContain('Return []');
    expect(EXTRACT_PROMPT).toContain('private personal disclosure');
    expect(EXTRACT_PROMPT).toContain('source_quote must be one exact contiguous source substring');
  });

  test('enforces the maximum atom count and rejects wholly invalid nonempty arrays', () => {
    const valid = { title: 'T', atom_type: 'insight', body: 'Body' };
    expect(parseAtomsOutcome(JSON.stringify([valid, valid, valid, valid]))).toEqual({
      ok: false,
      reason: 'JSON array exceeds 3 atoms',
    });
    expect(parseAtomsOutcome('[{"title":"missing fields"}]')).toEqual({
      ok: false,
      reason: 'JSON array contains no valid atoms',
    });
  });

  test('drops invalid and duplicate concept labels without inventing replacements', () => {
    expect(filterConceptLabels([
      'source-fidelity',
      'Source-Fidelity',
      'person/name',
      'x'.repeat(65),
      'source-fidelity',
      'privacy-safety',
      42,
    ])).toEqual(['source-fidelity', 'privacy-safety']);
    expect(filterConceptLabels(['Not Valid', {}, null])).toBeUndefined();
    expect(filterConceptLabels(
      ['openai', 'zach', 'source-fidelity'],
      'OpenAI and Zach discussed source fidelity.',
    )).toEqual(['source-fidelity']);
  });
});
