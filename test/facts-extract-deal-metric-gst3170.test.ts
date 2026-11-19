/**
 * GST-3170 item 2: the extractor model's round and deal-amount labels fold into one `fundraise` tag, so one deal's
 * amounts are not split across suffixed tags. A valuation, a share price, a cap or a count never folds, and a label a
 * person wrote in a Facts fence is kept as written. Seam: the gateway chat transport stub (no provider call).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { normalizeExtractedMetricLabel, normalizeMetricLabel } from '../src/core/facts/extract-from-fence.ts';
import { extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';

const FOLDS = ['fundraise', 'Fundraise Seed', 'fundraise_series_a', 'raise', 'raise_amount', 'seed_round', 'pre_seed', 'series_a',
  'Series B round', 'round_size', 'bridge_round', 'funding_round', 'deal_amount_usd', 'deal_size', 'seed_raise'];
const KEEPS = ['funding_runway_months', 'bridge_loan_interest', 'raise_target', 'funding_needed', 'round_trip_ms', 'deal_interest_rate', 'valuation', 'post_money_valuation', 'pre_money_valuation', 'share_price', 'price_per_share', 'round_valuation',
  'valuation_cap', 'seed_valuation', 'series_a_price', 'deal_count', 'number_of_rounds', 'raise_date', 'mrr', 'revenue', 'arr',
  'team_size', 'equity_stake', 'ownership_pct'];

afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

describe('extracted metric labels fold one deal into one tag (GST-3170)', () => {
  test('round and deal-amount variants fold into fundraise', () => {
    for (const label of FOLDS) expect({ label, got: normalizeExtractedMetricLabel(label) }).toEqual({ label, got: 'fundraise' });
  });
  test('a valuation, a share price, a cap, a count or another metric never folds', () => {
    for (const label of KEEPS) expect({ label, got: normalizeExtractedMetricLabel(label) }).toEqual({ label, got: normalizeMetricLabel(label) });
  });
  test('a Facts fence label is kept as written', () => {
    expect(normalizeMetricLabel('seed_round')).toBe('seed_round');
    expect(normalizeMetricLabel('deal_amount_usd')).toBe('deal_amount_usd');
  });
  test('the extractor stores one tag for one deal and keeps the valuation apart', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      const text = JSON.stringify({ facts: [
        { fact: 'Acme Example raised a $2M seed round.', kind: 'fact', entity: 'companies/acme-example', confidence: 1, notability: 'high',
          metric: 'seed_round', value: 2000000, unit: 'USD', period: null },
        { fact: 'Acme Example closed $500K more on the seed.', kind: 'fact', entity: 'companies/acme-example', confidence: 1, notability: 'high',
          metric: 'deal_amount_usd', value: 500000, unit: 'USD', period: null },
        { fact: 'Acme Example is valued at $20M post-money.', kind: 'fact', entity: 'companies/acme-example', confidence: 1, notability: 'high',
          metric: 'post_money_valuation', value: 20000000, unit: 'USD', period: null },
        { fact: 'Acme Example shares sold at $1.20 each.', kind: 'fact', entity: 'companies/acme-example', confidence: 1, notability: 'high',
          metric: 'share_price', value: 1.2, unit: 'USD', period: null },
      ] });
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
    });
    const out = await extractFactsFromTurnWithOutcome({ turnText: 'User: Acme Example raised a seed round.', source: 'test:gst3170', embedding: null,
      variant: {} });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.facts.map(f => f.claim_metric)).toEqual(['fundraise', 'fundraise', 'post_money_valuation', 'share_price']);
  });
});
