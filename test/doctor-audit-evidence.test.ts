import { describe, expect, test } from 'bun:test';
import { VERSION } from '../src/version.ts';
import { agentContractCheck } from '../src/commands/doctor/checks/agent-contract.ts';
import { agentContractEventDigest, verifyResolution, type AgentContractResolution } from '../src/commands/doctor/audit/agent-contract-resolution.ts';
import { digest } from '../src/core/persistence/digest.ts';

const event = {
  ts: '2026-01-02T00:00:00Z', version: '0.1.0', command: 'jobs', transport: 'cli', code: 'internal_error',
} as const;
const observation = {
  probe: 'job-recovery', observed_error_code: 'db_unavailable', actionable_next_step: true, recovered: true,
  reproduction_sha256: 'a'.repeat(64), recovery_sha256: 'b'.repeat(64),
} as const;
const binary = 'c'.repeat(64);
const eventHash = agentContractEventDigest(event);
const receipt = {
  version: 1, verified_binary_sha256: binary, proofs: [{
    event_sha256: eventHash, evidence_sha256: digest(observation), evidence: observation, verified_at: '2026-01-03T00:00:00Z',
  }],
} satisfies AgentContractResolution;
const now = Date.parse('2026-01-04T00:00:00Z');

describe('historical agent-contract resolutions', () => {
  test('retains the 7-day raw count and warns for a recurrence or consent rejection', () => {
    expect(verifyResolution(receipt, [event], binary, VERSION, now)).toBe(digest(receipt));
    const closed = new Set([eventHash]);
    expect(agentContractCheck([event], now, closed)).toMatchObject({
      status: 'ok', details: { events: 1, internal_errors: 1, resolved_internal_errors: 1, unresolved_internal_errors: 0 },
    });
    expect(agentContractCheck([event, { ...event, version: VERSION, ts: '2026-01-04T00:00:00Z' }], now, closed)).toMatchObject({
      status: 'warn', details: { events: 2, internal_errors: 2, resolved_internal_errors: 1, unresolved_internal_errors: 1 },
    });
    expect(agentContractCheck([event, { ...event, code: 'confirmation_required', outcome: 'refused' }], now, closed))
      .toMatchObject({ status: 'warn', details: { consent_refused: 1 } });
    expect(agentContractCheck([event], now, new Set(), true)).toMatchObject({
      status: 'warn', details: { resolution_evidence: 'unreadable', unresolved_internal_errors: 1 },
    });
  });

  test('rejects the wrong executable, ambiguous or missing originals, and modified proof', () => {
    expect(() => verifyResolution(receipt, [event], '0'.repeat(64), VERSION, now)).toThrow();
    expect(() => verifyResolution(receipt, [event, event], binary, VERSION, now)).toThrow();
    expect(() => verifyResolution(receipt, [], binary, VERSION, now)).toThrow();
    expect(() => verifyResolution(receipt, [event], binary, event.version, now)).toThrow();
    expect(() => verifyResolution(receipt, [event], binary, VERSION, Date.parse(event.ts))).toThrow();
    expect(() => verifyResolution({ ...receipt, proofs: [{ ...receipt.proofs[0]!, evidence_sha256: binary }] },
      [event], binary, VERSION, now)).toThrow();
  });
});
