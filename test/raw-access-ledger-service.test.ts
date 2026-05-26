import { describe, expect, test } from 'bun:test';
import {
  buildRawAccessLedgerEntry,
  evaluateRawAccessRequest,
  readRawAccessLedgerScope,
} from '../src/core/source-registry/raw-access-ledger.ts';

const baseRequest = {
  actor_type: 'runner',
  actor_id: 'runner:local',
  session_id: 'session:1',
  job_id: 'job:1',
  source_id: 'source:codex',
  source_item_id: 'source-item:1',
  chunk_ids: ['source-chunk:1'],
  reason: 'claim extraction',
  input: 'extract only this scoped chunk',
  requested_at: '2026-05-20T09:00:00.000Z',
} as const;

describe('raw access ledger helpers', () => {
  test('revocation prevents future raw access and still yields an audit row', () => {
    const decision = evaluateRawAccessRequest(baseRequest, {
      consent_state: 'revoked',
      enabled: true,
      runner_access: 'local-only',
    });
    const entry = buildRawAccessLedgerEntry(baseRequest, decision);

    expect(decision).toMatchObject({
      policy_decision: 'deny',
      reason: 'source_consent_revoked',
    });
    expect(entry).toMatchObject({
      actor_type: 'runner',
      actor_id: 'runner:local',
      session_id: 'session:1',
      job_id: 'job:1',
      source_id: 'source:codex',
      source_item_id: 'source-item:1',
      chunk_ids: ['source-chunk:1'],
      reason: 'claim extraction',
      policy_decision: 'deny',
      policy_reason: 'source_consent_revoked',
      timestamp: '2026-05-20T09:00:00.000Z',
    });
    expect(entry.input_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('allows scoped raw reads only when source policy permits the actor and chunks are explicit', () => {
    const allowed = evaluateRawAccessRequest(baseRequest, {
      consent_state: 'granted',
      enabled: true,
      runner_access: 'local-only',
    });
    const unscoped = evaluateRawAccessRequest({
      ...baseRequest,
      chunk_ids: [],
    }, {
      consent_state: 'granted',
      enabled: true,
      runner_access: 'local-only',
    });

    expect(allowed).toEqual({
      policy_decision: 'allow',
      reason: 'scoped_access_allowed',
      redaction_required: false,
    });
    expect(unscoped).toMatchObject({
      policy_decision: 'deny',
      reason: 'chunk_scope_required',
    });
  });

  test('applies runner policy to daemon, MCP, and CLI raw access actors', () => {
    for (const actor_type of ['daemon', 'mcp', 'cli']) {
      const decision = evaluateRawAccessRequest({
        ...baseRequest,
        actor_type,
      }, {
        consent_state: 'granted',
        enabled: true,
        runner_access: 'none',
        llm_access: 'redacted_policy_gated',
      });

      expect(decision).toMatchObject({
        policy_decision: 'deny',
        reason: 'runner_access_denied',
      });
    }
  });

  test('uses the requesting actor access mode when deciding redaction', () => {
    const decision = evaluateRawAccessRequest({
      ...baseRequest,
      actor_type: 'llm',
    }, {
      consent_state: 'granted',
      enabled: true,
      runner_access: 'local_only',
      llm_access: 'redacted_policy_gated',
    });

    expect(decision).toEqual({
      policy_decision: 'allow',
      reason: 'scoped_access_allowed',
      redaction_required: true,
    });
  });

  test('returns ledger entries constrained by source, item, actor, and decision scopes', () => {
    const allowed = evaluateRawAccessRequest(baseRequest, {
      consent_state: 'granted',
      enabled: true,
      runner_access: 'local-only',
    });
    const other = buildRawAccessLedgerEntry({
      ...baseRequest,
      actor_id: 'runner:other',
      source_item_id: 'source-item:2',
      chunk_ids: ['source-chunk:2'],
      requested_at: '2026-05-20T09:05:00.000Z',
    }, allowed);
    const target = buildRawAccessLedgerEntry(baseRequest, allowed);

    const scoped = readRawAccessLedgerScope([other, target], {
      source_id: 'source:codex',
      source_item_id: 'source-item:1',
      actor_id: 'runner:local',
      policy_decision: 'allow',
    });

    expect(scoped.map((entry) => entry.id)).toEqual([target.id]);
    expect(readRawAccessLedgerScope([other, target], {
      chunk_id: 'source-chunk:2',
    }).map((entry) => entry.id)).toEqual([other.id]);
  });
});
