// v0.35.4 — typed-claim fence parser+renderer round-trip + normalization.
//
// Pins:
//   1. Backward compat — a fence authored without typed fields still
//      parses, renders as 10-cell shape, and round-trips byte-identical.
//   2. Typed fields parse from the 14-cell widened fence.
//   3. Renderer widens to 14 cells iff ANY row has a non-undefined typed
//      field; otherwise stays at 10-cell (no diff noise on existing fences).
//   4. Round-trip preservation: parse → render → parse produces the same
//      ParsedFact array, including typed fields.
//   5. Numeric value cell tolerates thousand separators (`50,000`).

import { test, expect, describe } from 'bun:test';
import {
  parseFactsFence,
  renderFactsTable,
  upsertFactRow,
  type ParsedFact,
} from '../src/core/facts-fence.ts';
import {
  extractFactsFromFenceText,
  normalizeMetricLabel,
  METRIC_NORMALIZATION_MAP,
} from '../src/core/facts/extract-from-fence.ts';

function wrap(inner: string): string {
  return `## Facts\n\n<!--- gbrain:facts:begin -->\n${inner}\n<!--- gbrain:facts:end -->\n`;
}

describe('v0.35.4 — facts fence typed-claim parser', () => {
  test('legacy 10-cell fence parses as before; all typed fields undefined', () => {
    const body = wrap(
      `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
       |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
       | 1 | Founded Acme in 2017 | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |`,
    );
    const { facts, warnings } = parseFactsFence(body);
    expect(warnings).toEqual([]);
    expect(facts.length).toBe(1);
    expect(facts[0].claim).toBe('Founded Acme in 2017');
    expect(facts[0].claimMetric).toBeUndefined();
    expect(facts[0].claimValue).toBeUndefined();
    expect(facts[0].claimUnit).toBeUndefined();
    expect(facts[0].claimPeriod).toBeUndefined();
  });

  test('14-cell typed fence parses all four typed-claim fields', () => {
    const body = wrap(
      `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |
       |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|
       | 1 | MRR hit $50K | fact | 1.0 | private | high | 2026-01-15 |  | OH transcript |  | mrr | 50000 | USD | monthly |`,
    );
    const { facts, warnings } = parseFactsFence(body);
    expect(warnings).toEqual([]);
    expect(facts.length).toBe(1);
    expect(facts[0].claimMetric).toBe('mrr');
    expect(facts[0].claimValue).toBe(50000);
    expect(facts[0].claimUnit).toBe('USD');
    expect(facts[0].claimPeriod).toBe('monthly');
  });

  test('numeric value cell tolerates comma thousand separators', () => {
    const body = wrap(
      `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |
       |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|
       | 1 | ARR | fact | 1.0 | private | high | 2026-04-12 |  | bo call |  | arr | 2,000,000 | USD | annual |`,
    );
    const { facts } = parseFactsFence(body);
    expect(facts[0].claimValue).toBe(2000000);
  });

  test('empty typed cells parse as undefined (not "")', () => {
    const body = wrap(
      `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |
       |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|
       | 1 | bare claim | fact | 1.0 | private | high | 2026-01-01 |  |  |  |  |  |  |  |`,
    );
    const { facts } = parseFactsFence(body);
    expect(facts[0].claimMetric).toBeUndefined();
    expect(facts[0].claimValue).toBeUndefined();
    expect(facts[0].claimUnit).toBeUndefined();
    expect(facts[0].claimPeriod).toBeUndefined();
  });
});

describe('v0.35.4 — facts fence typed-claim renderer', () => {
  test('renders 10-cell shape when no row has typed fields (backward compat)', () => {
    const facts: ParsedFact[] = [
      {
        rowNum: 1,
        claim: 'Founded Acme in 2017',
        kind: 'fact',
        confidence: 1.0,
        visibility: 'world',
        notability: 'high',
        validFrom: '2017-01-01',
        source: 'linkedin',
        active: true,
      },
    ];
    const out = renderFactsTable(facts);
    // 10-cell header
    expect(out).toContain('| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |');
    // NOT the 14-cell variant
    expect(out).not.toContain('claim_metric');
  });

  test('widens to 14 cells when ANY row has typed fields', () => {
    const facts: ParsedFact[] = [
      {
        rowNum: 1,
        claim: 'plain claim',
        kind: 'fact',
        confidence: 1.0,
        visibility: 'private',
        notability: 'medium',
        active: true,
      },
      {
        rowNum: 2,
        claim: 'MRR hit $50K',
        kind: 'fact',
        confidence: 1.0,
        visibility: 'private',
        notability: 'high',
        active: true,
        claimMetric: 'mrr',
        claimValue: 50000,
        claimUnit: 'USD',
        claimPeriod: 'monthly',
      },
    ];
    const out = renderFactsTable(facts);
    expect(out).toContain('claim_metric');
    expect(out).toContain('claim_value');
    expect(out).toContain('claim_unit');
    expect(out).toContain('claim_period');
    // Row 1 has empty typed cells; row 2 has the values.
    expect(out).toContain('| mrr | 50000 | USD | monthly |');
  });

  test('round-trip preservation: parse → render → parse is structurally idempotent for typed facts', () => {
    const body = wrap(
      `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |
       |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|
       | 1 | MRR $50K | fact | 1.0 | private | high | 2026-01-15 |  | OH |  | mrr | 50000 | USD | monthly |
       | 2 | Team grew to 12 | fact | 1.0 | private | medium | 2026-02-01 |  | meeting |  | team_size | 12 | people |  |
       | 3 | Plain non-typed claim | fact | 0.85 | private | low | 2026-03-01 |  | inferred |  |  |  |  |  |`,
    );
    const first = parseFactsFence(body);
    expect(first.warnings).toEqual([]);
    expect(first.facts.length).toBe(3);
    const rendered = renderFactsTable(first.facts);
    const second = parseFactsFence(rendered);
    expect(second.warnings).toEqual([]);
    expect(second.facts).toEqual(first.facts);
  });

  test('upsertFactRow threads typed fields when a new row carries them', () => {
    // Start from a fence with NO typed fields → 10-cell shape.
    const body = wrap(
      `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
       |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
       | 1 | Founded Acme in 2017 | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |`,
    );
    const { body: newBody, rowNum } = upsertFactRow(body, {
      claim: 'MRR hit $50K',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'private',
      notability: 'high',
      validFrom: '2026-01-15',
      source: 'OH transcript',
      claimMetric: 'mrr',
      claimValue: 50000,
      claimUnit: 'USD',
      claimPeriod: 'monthly',
    });
    expect(rowNum).toBe(2);
    // Adding a typed row widens the table.
    expect(newBody).toContain('claim_metric');
    const parsed = parseFactsFence(newBody);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts.length).toBe(2);
    expect(parsed.facts[1].claimMetric).toBe('mrr');
    expect(parsed.facts[1].claimValue).toBe(50000);
  });
});

describe('v0.35.4 — metric normalization (D-ENG-4)', () => {
  test('known seed-map labels normalize to canonical snake_case', () => {
    expect(normalizeMetricLabel('MRR')).toBe('mrr');
    expect(normalizeMetricLabel('Monthly Recurring Revenue')).toBe('mrr');
    expect(normalizeMetricLabel('ARR')).toBe('arr');
    expect(normalizeMetricLabel('annual recurring revenue')).toBe('arr');
    expect(normalizeMetricLabel('Team Size')).toBe('team_size');
    expect(normalizeMetricLabel('Burn Rate')).toBe('burn_rate');
    expect(normalizeMetricLabel('Churn')).toBe('churn_rate');
  });

  test('unknown labels lowercase + spaces → underscores; non-alphanumeric stripped', () => {
    expect(normalizeMetricLabel('Net Promoter Score')).toBe('net_promoter_score');
    expect(normalizeMetricLabel('  CAC  ')).toBe('cac');
    expect(normalizeMetricLabel('Time-to-Hire')).toBe('timetohire');
  });

  test('empty / null / undefined → undefined (the "no metric set" signal)', () => {
    expect(normalizeMetricLabel(undefined)).toBeUndefined();
    expect(normalizeMetricLabel(null)).toBeUndefined();
    expect(normalizeMetricLabel('')).toBeUndefined();
    expect(normalizeMetricLabel('   ')).toBeUndefined();
  });

  test('METRIC_NORMALIZATION_MAP covers the 15-metric seed list named in the plan', () => {
    // Pin the seed map so the docs in CLAUDE.md / CHANGELOG match.
    const required = [
      'mrr', 'arr', 'runway', 'headcount', 'team_size',
      'cac', 'ltv', 'gross_margin', 'burn_rate', 'cash',
      'users', 'mau', 'dau', 'churn_rate', 'revenue',
    ];
    const canonicalValues = new Set(METRIC_NORMALIZATION_MAP.values());
    for (const r of required) {
      expect(canonicalValues.has(r)).toBe(true);
    }
  });
});

describe('v0.35.4 (D-ENG-1) — extractFactsFromFenceText valid_from precedence', () => {
  const fixedToday = new Date('2026-05-17T00:00:00.000Z');

  test('Path 1: explicit validFrom in fence row wins', () => {
    const facts: ParsedFact[] = [{
      rowNum: 1,
      claim: 'fence-dated',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'private',
      notability: 'medium',
      validFrom: '2026-01-15',
      active: true,
    }];
    const out = extractFactsFromFenceText(facts, 'people/alice-example', 'default', {
      nowOverride: fixedToday,
      pageEffectiveDate: new Date('2026-04-28'),
    });
    expect(out[0].valid_from?.toISOString().slice(0, 10)).toBe('2026-01-15');
  });

  test('Path 2: missing fence validFrom + pageEffectiveDate set → uses page date', () => {
    const facts: ParsedFact[] = [{
      rowNum: 1,
      claim: 'no fence date',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'private',
      notability: 'medium',
      active: true,
    }];
    const out = extractFactsFromFenceText(facts, 'people/alice-example', 'default', {
      nowOverride: fixedToday,
      pageEffectiveDate: new Date('2026-04-28'),
    });
    expect(out[0].valid_from?.toISOString().slice(0, 10)).toBe('2026-04-28');
  });

  test('Path 3: missing fence validFrom AND undefined pageEffectiveDate → undefined (engine defaults to now)', () => {
    const facts: ParsedFact[] = [{
      rowNum: 1,
      claim: 'no dates at all',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'private',
      notability: 'medium',
      active: true,
    }];
    const out = extractFactsFromFenceText(facts, 'people/alice-example', 'default', {
      nowOverride: fixedToday,
      pageEffectiveDate: null,
    });
    // valid_from is left undefined; the engine layer applies now() at insert.
    expect(out[0].valid_from).toBeUndefined();
  });

  test('typed-claim fields thread through with metric normalization applied', () => {
    const facts: ParsedFact[] = [{
      rowNum: 1,
      claim: 'MRR $50K',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'private',
      notability: 'high',
      active: true,
      claimMetric: 'Monthly Recurring Revenue',  // unnormalized
      claimValue: 50000,
      claimUnit: 'USD',
      claimPeriod: 'monthly',
    }];
    const out = extractFactsFromFenceText(facts, 'companies/acme-example', 'default');
    expect(out[0].claim_metric).toBe('mrr');  // normalized
    expect(out[0].claim_value).toBe(50000);
    expect(out[0].claim_unit).toBe('USD');
    expect(out[0].claim_period).toBe('monthly');
  });

  test('rows with no typed-claim fields land with null claim_* columns (backward compat)', () => {
    const facts: ParsedFact[] = [{
      rowNum: 1,
      claim: 'bare claim',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'private',
      notability: 'low',
      active: true,
    }];
    const out = extractFactsFromFenceText(facts, 'people/bob-example', 'default');
    expect(out[0].claim_metric).toBeNull();
    expect(out[0].claim_value).toBeNull();
    expect(out[0].claim_unit).toBeNull();
    expect(out[0].claim_period).toBeNull();
  });
});
