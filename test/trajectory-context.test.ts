import { describe, expect, test } from 'bun:test';
import { parseTrajectoryEvidence } from '../src/core/trajectory-context.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

describe('parseTrajectoryEvidence', () => {
  test('legacy prose and contexts without a trajectory key stay legacy', () => {
    expect(parseTrajectoryEvidence(null)).toBeUndefined();
    expect(parseTrajectoryEvidence('superseded by #3')).toBeUndefined();
    expect(parseTrajectoryEvidence('{"other":true}')).toBeUndefined();
  });

  test('explicit but malformed trajectory metadata degrades to unknown, never legacy', () => {
    for (const trajectory of [null, 'bad', {}, { scope: '', time_basis: 'future' }]) {
      expect(parseTrajectoryEvidence(JSON.stringify({ trajectory }))).toEqual({ scope: null, time_basis: 'unknown', reported_on: null });
    }
  });

  test('only the evidence subset is projected, never other context fields', () => {
    expect(parseTrajectoryEvidence(JSON.stringify({ secret: 'not projected', trajectory: {
      scope: ' pilot-a ', time_basis: 'valid', reported_on: '2026-02-01', other: 'not projected',
    } }))).toEqual({ scope: 'pilot-a', time_basis: 'valid', reported_on: '2026-02-01' });
  });
});

test('a facts fence keeps JSON context intact through parsing', () => {
  const context = JSON.stringify({ producer: 'fixture', trajectory: { scope: null, time_basis: 'reported', reported_on: '2026-02-03' } });
  const body = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Phase A serves 90 people | fact | 0.8 | world | medium | 2026-02-03 | | meetings/fixture | ${context} | users | 90 | people | |
<!--- gbrain:facts:end -->`;
  const parsed = parseFactsFence(body);
  expect(parsed.facts).toHaveLength(1);
  expect(parsed.facts[0].context).toBe(context);
  expect(parseTrajectoryEvidence(parsed.facts[0].context)?.time_basis).toBe('reported');
});
