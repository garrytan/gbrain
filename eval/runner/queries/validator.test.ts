import { describe, test, expect } from 'bun:test';
import { validateQuery, validateQuerySet, TEMPORAL_VERBS } from './validator.ts';
import type { Query } from '../types.ts';

function mkValidQuery(overrides: Partial<Query> = {}): Query {
  return {
    id: 'q-0001',
    tier: 'easy',
    text: 'Who founded Acme?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-chen'] },
    ...overrides,
  };
}

describe('validateQuery — required fields', () => {
  test('valid query passes', () => {
    const r = validateQuery(mkValidQuery());
    expect(r.ok).toBe(true);
    expect(r.issues.length).toBe(0);
  });

  test('missing id fails', () => {
    const r = validateQuery(mkValidQuery({ id: '' }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'id')).toBe(true);
  });

  test('missing text fails', () => {
    const r = validateQuery(mkValidQuery({ text: '' }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'text')).toBe(true);
  });

  test('invalid tier fails', () => {
    const r = validateQuery(mkValidQuery({ tier: 'invalid' as unknown as 'easy' }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'tier')).toBe(true);
  });

  test('invalid expected_output_type fails', () => {
    const r = validateQuery(mkValidQuery({
      expected_output_type: 'nonsense' as unknown as 'answer-string',
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'expected_output_type')).toBe(true);
  });
});

describe('validateQuery — temporal as_of_date rule', () => {
  test('non-temporal query without as_of_date passes', () => {
    const r = validateQuery(mkValidQuery({ text: 'Who founded Acme?' }));
    expect(r.ok).toBe(true);
  });

  test('"is" verb without as_of_date fails', () => {
    const r = validateQuery(mkValidQuery({ text: 'Where is Sarah working?' }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'as_of_date')).toBe(true);
  });

  test('"was" verb without as_of_date fails', () => {
    const r = validateQuery(mkValidQuery({ text: 'Who was at the meeting?' }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'as_of_date')).toBe(true);
  });

  test('"as of" verb without as_of_date fails', () => {
    const r = validateQuery(mkValidQuery({ text: 'As of 2024, who invested?' }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'as_of_date')).toBe(true);
  });

  test('temporal query with "corpus-end" passes', () => {
    const r = validateQuery(mkValidQuery({
      text: 'Who is the CEO now?',
      as_of_date: 'corpus-end',
    }));
    expect(r.ok).toBe(true);
  });

  test('temporal query with "per-source" passes', () => {
    const r = validateQuery(mkValidQuery({
      text: 'Who was at the meeting?',
      as_of_date: 'per-source',
    }));
    expect(r.ok).toBe(true);
  });

  test('temporal query with ISO-8601 date passes', () => {
    const r = validateQuery(mkValidQuery({
      text: 'Who was at Acme in 2023?',
      as_of_date: '2023-01-01',
    }));
    expect(r.ok).toBe(true);
  });

  test('temporal query with bogus as_of_date fails', () => {
    const r = validateQuery(mkValidQuery({
      text: 'Who is the CEO now?',
      as_of_date: 'yesterday',
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'as_of_date')).toBe(true);
  });
});

describe('validateQuery — gold shape by expected_output_type', () => {
  test('cited-source-pages requires gold.relevant array', () => {
    const r = validateQuery(mkValidQuery({
      expected_output_type: 'cited-source-pages',
      gold: {},
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'gold.relevant')).toBe(true);
  });

  test('cited-source-pages with malformed slug fails', () => {
    const r = validateQuery(mkValidQuery({
      gold: { relevant: ['not-a-slug'] },
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'gold.relevant')).toBe(true);
  });

  test('abstention requires expected_abstention=true', () => {
    const r = validateQuery(mkValidQuery({
      expected_output_type: 'abstention',
      gold: {},
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'gold.expected_abstention')).toBe(true);
  });

  test('abstention with expected_abstention=true passes', () => {
    const r = validateQuery(mkValidQuery({
      expected_output_type: 'abstention',
      gold: { expected_abstention: true },
    }));
    expect(r.ok).toBe(true);
  });
});

describe('validateQuery — tier 5.5 author requirement', () => {
  test('externally-authored without author fails', () => {
    const r = validateQuery(mkValidQuery({
      tier: 'externally-authored',
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'author')).toBe(true);
  });

  test('externally-authored with author passes', () => {
    const r = validateQuery(mkValidQuery({
      tier: 'externally-authored',
      author: 'synthetic-outsider-v1',
    }));
    expect(r.ok).toBe(true);
  });
});

describe('validateQuerySet — batch level', () => {
  test('duplicate ids fail', () => {
    const r = validateQuerySet([
      mkValidQuery({ id: 'q-0001' }),
      mkValidQuery({ id: 'q-0001' }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.reason === 'duplicate id in batch')).toBe(true);
  });

  test('unique ids pass', () => {
    const r = validateQuerySet([
      mkValidQuery({ id: 'q-0001' }),
      mkValidQuery({ id: 'q-0002' }),
    ]);
    expect(r.ok).toBe(true);
  });

  test('issues from multiple queries aggregated', () => {
    const r = validateQuerySet([
      mkValidQuery({ id: 'q-0001', text: '' }),        // missing text
      mkValidQuery({ id: 'q-0002', text: 'Who is CEO now?' }), // missing as_of_date
    ]);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.queryId === 'q-0001' && i.field === 'text')).toBe(true);
    expect(r.issues.some(i => i.queryId === 'q-0002' && i.field === 'as_of_date')).toBe(true);
  });
});

describe('TEMPORAL_VERBS regex', () => {
  test('matches common temporal verbs', () => {
    expect(TEMPORAL_VERBS.test('Where is Sarah?')).toBe(true);
    expect(TEMPORAL_VERBS.test('Where was Sarah?')).toBe(true);
    expect(TEMPORAL_VERBS.test('Who were the founders?')).toBe(true);
    expect(TEMPORAL_VERBS.test('What was the current valuation?')).toBe(true);
    expect(TEMPORAL_VERBS.test('Where is she now?')).toBe(true);
    expect(TEMPORAL_VERBS.test('At the time, who led the round?')).toBe(true);
    expect(TEMPORAL_VERBS.test('During Q1, which deals closed?')).toBe(true);
    expect(TEMPORAL_VERBS.test('As of 2024, who works at Acme?')).toBe(true);
    expect(TEMPORAL_VERBS.test('When did Alice join?')).toBe(true);
  });

  test('does not match non-temporal verbs', () => {
    expect(TEMPORAL_VERBS.test('Who founded Acme?')).toBe(false);
    expect(TEMPORAL_VERBS.test('Which investors backed Beta?')).toBe(false);
    expect(TEMPORAL_VERBS.test('List the advisors at Gamma.')).toBe(false);
  });
});
