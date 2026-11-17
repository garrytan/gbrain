/**
 * facts/claim-status.ts: every recalled fact carries claim_status (accepted,
 * provisional, contested, unsupported, stale) and a one-sentence reason, derived
 * at read time from what the fact row already says. Labels never block a read.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { assessClaim, withClaimStatus, CLAIM_STATUSES, LOW_CONFIDENCE, type ClaimStatus } from '../src/core/facts/claim-status.ts';

const NOW = new Date('2026-11-17T12:00:00Z');
const base = { trust_tier: 'agent_written', source: 'meeting notes 2026-11-10', valid_until: null, expired_at: null, superseded_by: null, confidence: 0.9 };

describe('assessClaim rules', () => {
  test('stale: expired, superseded or past valid_until, before anything else', () => {
    expect(assessClaim({ ...base, trust_tier: 'user_confirmed', expired_at: '2026-10-01T00:00:00Z' }, NOW))
      .toEqual({ claim_status: 'stale', claim_status_reason: 'expired on 2026-10-01' });
    expect(assessClaim({ ...base, superseded_by: 42 }, NOW).claim_status_reason).toBe('superseded by fact 42');
    expect(assessClaim({ ...base, valid_until: '2026-11-01T00:00:00Z' }, NOW).claim_status).toBe('stale');
    expect(assessClaim({ ...base, valid_until: '2026-12-01T00:00:00Z' }, NOW).claim_status).toBe('provisional');
  });

  test('contested: a pending owner decision names it, with the proposal', () => {
    const a = assessClaim({ ...base, trust_tier: 'user_confirmed', contested: { proposal_ref: 'dp7', role: 'challenged' } }, NOW);
    expect(a.claim_status).toBe('contested');
    expect(a.claim_status_reason).toContain('another fact disputes it');
    expect(a.claim_status_reason).toContain('dp7');
  });

  test('unsupported: no source recorded', () => {
    expect(assessClaim({ ...base, trust_tier: 'user_confirmed', source: '  ' }, NOW).claim_status).toBe('unsupported');
    expect(assessClaim({ ...base, source: null }, NOW).claim_status).toBe('unsupported');
  });

  test("accepted: confirmed by the owner or from the owner's own notes, unless confidence is low", () => {
    expect(assessClaim({ ...base, trust_tier: 'user_confirmed' }, NOW).claim_status).toBe('accepted');
    expect(assessClaim({ ...base, trust_tier: 'operator_curated' }, NOW).claim_status).toBe('accepted');
    const low = assessClaim({ ...base, trust_tier: 'user_confirmed', confidence: LOW_CONFIDENCE - 0.1 }, NOW);
    expect(low).toEqual({ claim_status: 'provisional', claim_status_reason: `its confidence is below ${LOW_CONFIDENCE}` });
  });

  test('provisional: agent, tool, outside text or unknown, each with its own reason', () => {
    expect(assessClaim(base, NOW).claim_status_reason).toBe('written by an agent and not confirmed');
    expect(assessClaim({ ...base, trust_tier: 'tool_observed' }, NOW).claim_status_reason).toBe('observed by a tool and not confirmed');
    expect(assessClaim({ ...base, trust_tier: 'external_untrusted' }, NOW).claim_status_reason).toBe('taken from outside text and not confirmed');
    expect(assessClaim({ ...base, trust_tier: undefined }, NOW).claim_status_reason).toBe('its origin is unknown');
  });

  test('withClaimStatus adds the two fields and keeps every other field', () => {
    const [f] = withClaimStatus([{ ...base, id: 3, fact: 'x' }], NOW);
    expect(f.id).toBe(3);
    expect(CLAIM_STATUSES).toContain(f.claim_status);
    expect(typeof f.claim_status_reason).toBe('string');
  });
});

describe('recall returns claim_status on every fact', () => {
  let engine: PGLiteEngine;
  const ctx = (over: Record<string, unknown> = {}) => ({
    engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default', ...over,
  }) as unknown as OperationContext;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    await operationsByName['remember'].handler(ctx(), { fact: 'The pilot starts in January (marker CS1)', provenance: 'claim-status test' });
  });
  afterAll(async () => { await engine.disconnect(); });

  test('an agent-saved fact reads back provisional, with the reason and the fields it was derived from', async () => {
    const res = await operationsByName['recall'].handler(ctx(), {}) as { facts: Array<Record<string, unknown>> };
    const f = res.facts.find(x => String(x.fact).includes('CS1'))!;
    expect(f).toBeDefined();
    expect(f.claim_status).toBe('provisional');
    expect(f.claim_status_reason).toBe('written by an agent and not confirmed');
    expect(assessClaim(f as never).claim_status).toBe(f.claim_status as ClaimStatus);
  });
});
