/**
 * Memory trust tiers (#5575): the one vocabulary every writer, reader and gate shares.
 *
 * Protects: the CEO-13 filter order (user_confirmed > operator_curated >
 * tool_observed > agent_written > unknown > external_untrusted), the fixed
 * user-facing labels (DX-8), min/max/admit helpers, the content_origin mapping
 * (DX-8), the per-token floor read-back (CEO-18) and the compute-once
 * effective tier with its bounded taint sample (ENG-18, CEO-1). Fails if the
 * order drifts (a `min_trust=agent_written` read would admit `unknown`), if a
 * derived write can exceed agent_written or its least trusted input, or if
 * the taint sample grows unbounded. Pure; no engine.
 */
import { describe, expect, test } from 'bun:test';
import {
  TAINT_INPUT_SAMPLE_LIMIT, TRUST_TIERS, TRUST_TIER_LABELS, admitsTrust, compareTrust, contentOriginTier, effectiveWriteTrust,
  maxTrust, minTrust, nestWriteTrust, parseTrustTier, storedMinTrust, storedTrustTier, tiersAtOrAbove, trustLabel, type TaintInput,
} from '../src/core/trust/tier.ts';
import { OperationError } from '../src/core/ops/contract.ts';

describe('trust tier vocabulary', () => {
  test('order is the CEO-13 filter order, highest first', () => {
    expect([...TRUST_TIERS]).toEqual(['user_confirmed', 'operator_curated', 'tool_observed', 'agent_written', 'unknown', 'external_untrusted']);
    for (let i = 1; i < TRUST_TIERS.length; i++) expect(compareTrust(TRUST_TIERS[i - 1]!, TRUST_TIERS[i]!)).toBeGreaterThan(0);
  });

  test('labels are the fixed DX-8 strings and unknown never reads as confirmed', () => {
    expect({ ...TRUST_TIER_LABELS }).toEqual({
      user_confirmed: 'confirmed by you', operator_curated: 'your notes', tool_observed: 'tool data',
      agent_written: 'written by an agent', unknown: 'unverified origin', external_untrusted: 'external, untrusted',
    });
    expect(trustLabel('unknown')).not.toContain('confirmed');
  });

  test('min_trust admits rows at or above the floor: agent_written excludes unknown and external', () => {
    expect(tiersAtOrAbove('agent_written')).toEqual(['user_confirmed', 'operator_curated', 'tool_observed', 'agent_written']);
    expect(admitsTrust('unknown', 'agent_written')).toBe(false);
    expect(admitsTrust('external_untrusted', 'unknown')).toBe(false);
    expect(admitsTrust('unknown', 'unknown')).toBe(true);
    expect(tiersAtOrAbove('external_untrusted')).toEqual([...TRUST_TIERS]);
  });

  test('min lowers, max raises (a token floor and a caller param combine as max)', () => {
    expect(minTrust('operator_curated', 'agent_written', 'tool_observed')).toBe('agent_written');
    expect(minTrust('agent_written', 'unknown')).toBe('unknown');
    expect(minTrust('unknown', 'external_untrusted')).toBe('external_untrusted');
    expect(maxTrust('unknown', 'tool_observed')).toBe('tool_observed');
  });

  test('parsing refuses anything but a tier with invalid_params naming the accepted values', () => {
    expect(parseTrustTier('tool_observed')).toBe('tool_observed');
    try { parseTrustTier('confirmed', 'min_trust'); throw new Error('accepted'); }
    catch (e) { expect(e).toBeInstanceOf(OperationError); expect((e as OperationError).code).toBe('invalid_params'); expect((e as Error).message).toContain('agent_written'); }
  });

  test('stored values: legacy NULL reads unknown; a damaged token floor fails closed to the strictest floor', () => {
    expect(storedTrustTier(null)).toBe('unknown');
    expect(storedTrustTier('bogus')).toBe('unknown');
    expect(storedMinTrust(null)).toBeUndefined();
    expect(storedMinTrust('agent_written')).toBe('agent_written');
    expect(storedMinTrust('bogus')).toBe('user_confirmed');
  });
});

describe('content_origin (DX-8)', () => {
  test('tool_output lowers to external_untrusted; user_said never confers owner authority', () => {
    expect(contentOriginTier('tool_output')).toBe('external_untrusted');
    expect(contentOriginTier('user_said')).toBe('agent_written');
    expect(contentOriginTier('inferred')).toBe('agent_written');
  });
  test('an unknown value is invalid_params listing the accepted values', () => {
    try { contentOriginTier('web'); throw new Error('accepted'); }
    catch (e) { expect((e as OperationError).code).toBe('invalid_params'); expect((e as Error).message).toContain('user_said, tool_output, inferred'); }
  });
});

describe('effective tier of one write (ENG-18, CEO-1)', () => {
  test('lowering signals only lower; a channel is never raised by them', () => {
    expect(effectiveWriteTrust({ channel: 'agent_written', lowerTo: ['external_untrusted'], origin: { channel: 'mcp:remember' } }).tier).toBe('external_untrusted');
    expect(effectiveWriteTrust({ channel: 'agent_written', lowerTo: ['operator_curated'], origin: { channel: 'mcp:remember' } }).tier).toBe('agent_written');
  });

  test('a derived write is capped at agent_written and at its least trusted input', () => {
    const owner = effectiveWriteTrust({ channel: 'operator_curated', derived: true, inputs: [{ table: 'pages', id: 1, tier: 'operator_curated' }], origin: { channel: 'dream' } });
    expect(owner.tier).toBe('agent_written');
    const external = effectiveWriteTrust({ channel: 'operator_curated', derived: true,
      inputs: [{ table: 'pages', id: 1, tier: 'operator_curated' }, { table: 'pages', id: 2, tier: 'external_untrusted' }], origin: { channel: 'dream' } });
    expect(external.tier).toBe('external_untrusted');
    expect(external.origin?.taint_inputs?.[0]).toEqual({ table: 'pages', id: 2, tier: 'external_untrusted' });
  });

  test('40 inputs keep the 32 least trusted with the truncation fields', () => {
    const inputs: TaintInput[] = Array.from({ length: 40 }, (_, i) => ({ table: 'facts', id: i + 1, tier: i === 37 ? 'external_untrusted' : 'operator_curated' }));
    const trust = effectiveWriteTrust({ channel: 'agent_written', derived: true, inputs, origin: { channel: 'consolidate' } });
    expect(trust.origin?.taint_inputs).toHaveLength(TAINT_INPUT_SAMPLE_LIMIT);
    expect(trust.origin?.taint_inputs?.[0]?.id).toBe(38);
    expect(trust.origin).toMatchObject({ taint_inputs_truncated: true, taint_input_count: 40, channel: 'consolidate' });
    expect(trust.tier).toBe('external_untrusted');
  });

  test('few inputs carry no truncation fields', () => {
    const trust = effectiveWriteTrust({ channel: 'agent_written', inputs: [{ table: 'pages', id: 1, tier: 'agent_written' }], origin: { channel: 'x' } });
    expect(trust.origin).toEqual({ channel: 'x', taint_inputs: [{ table: 'pages', id: 1, tier: 'agent_written' }] });
  });

  test('nesting combines as min(outer, inner): a nested write can lower, never raise', () => {
    const outer = { tier: 'agent_written' as const, origin: { channel: 'mcp:put_page' } };
    expect(nestWriteTrust(outer, { tier: 'operator_curated', origin: { channel: 'derived' } })).toEqual({ tier: 'agent_written', origin: { channel: 'derived' } });
    expect(nestWriteTrust(outer, { tier: 'external_untrusted', origin: null }).tier).toBe('external_untrusted');
    expect(nestWriteTrust(null, { tier: 'tool_observed', origin: null }).tier).toBe('tool_observed');
  });
});
