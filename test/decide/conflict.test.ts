/**
 * S9 `conflict` pure logic: the pair reducer (duplicate threshold, proposal
 * floor, independent), candidate eligibility (the decideSingleFact guards and
 * self-exclusion), unordered pair keys and proposal direction, the watermark
 * commit-order lag window, the facts-fixtures dataset format and the
 * production request shape, and the accept/undo fence plans (strike, restore,
 * refuse when the row changed).
 */
import { describe, expect, test } from 'bun:test';
import {
  CONFLICT_MIN_COSINE, CONFLICT_OPTIONS, conflictQuestion, conflictState, eligibleCandidate, pairKey, proposalDirection,
  reduceConflict, supersedeProbability, sweepWindow,
} from '../../src/core/ai/decide/conflict.ts';
import { datasetAdapter, datasetBuilder, families } from '../../src/core/ai/decide/dataset.ts';
import { parseConflictPairs, registerConflictDatasets } from '../../src/core/ai/decide/datasets-conflict.ts';

registerConflictDatasets();
import { planAcceptFence, planUndoFence, staleReason, undoRefusal, factFields, type PairFact } from '../../src/core/facts/proposal-supersede.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import type { ChoiceAnswer } from '../../src/core/ai/decide/types.ts';

const answer = (choice: string, probabilities: Record<string, number>): ChoiceAnswer => ({ kind: 'choice', choice, confidence: probabilities[choice] ?? 0, probabilities });

describe('reduceConflict', () => {
  const policy = { threshold: 0.8, proposalFloor: 0.5 };
  test('duplicate at or above threshold is a duplicate', () => {
    expect(reduceConflict(answer('duplicate', { duplicate: 0.8, supersede: 0.1, independent: 0.1 }), policy)).toBe('duplicate');
  });
  test('a duplicate below threshold falls through to the proposal floor, then independent', () => {
    expect(reduceConflict(answer('duplicate', { duplicate: 0.45, supersede: 0.5, independent: 0.05 }), policy)).toBe('proposal');
    expect(reduceConflict(answer('duplicate', { duplicate: 0.6, supersede: 0.3, independent: 0.1 }), policy)).toBe('independent');
  });
  test('supersede at or above the floor is a proposal even when not the chosen label', () => {
    expect(reduceConflict(answer('supersede', { duplicate: 0.1, supersede: 0.7, independent: 0.2 }), policy)).toBe('proposal');
    expect(reduceConflict(answer('independent', { duplicate: 0, supersede: 0.5, independent: 0.5 }), policy)).toBe('proposal');
    expect(reduceConflict(answer('supersede', { duplicate: 0.1, supersede: 0.49, independent: 0.41 }), policy)).toBe('independent');
  });
  test('missing probabilities fall back to the confidence of a chosen supersede', () => {
    const a: ChoiceAnswer = { kind: 'choice', choice: 'supersede', confidence: 0.9, probabilities: {} };
    expect(supersedeProbability(a)).toBe(0.9);
    expect(reduceConflict(a, policy)).toBe('proposal');
  });
  test('without a threshold (shadow diagnostics) the chosen duplicate label decides', () => {
    expect(reduceConflict(answer('duplicate', { duplicate: 0.4, supersede: 0.3 }), { proposalFloor: 0.5 })).toBe('duplicate');
  });
});

describe('candidate eligibility', () => {
  const fact = { id: 10, source_id: 'default', entity_slug: 'people/alice-example', visibility: 'private' };
  const base = { id: 3, source_id: 'default', entity_slug: 'people/alice-example', visibility: 'private', expired_at: null, valid_until: null, source_markdown_slug: 'people/alice-example', similarity: 0.9 };
  const now = Date.parse('2026-09-30T00:00:00Z');
  test('passes the decideSingleFact guards', () => { expect(eligibleCandidate(fact, base, now)).toBe(true); });
  for (const [name, patch] of [
    ['self', { id: 10 }], ['other source', { source_id: 'other' }], ['other entity', { entity_slug: 'people/bob-example' }],
    ['other visibility', { visibility: 'world' }], ['expired', { expired_at: '2026-01-01T00:00:00Z' }],
    ['validity lapsed', { valid_until: '2026-09-01T00:00:00Z' }], ['other page fence', { source_markdown_slug: 'companies/acme-example' }],
    ['below cosine floor', { similarity: CONFLICT_MIN_COSINE - 0.001 }],
  ] as const) {
    test(`excludes ${name}`, () => { expect(eligibleCandidate(fact, { ...base, ...patch } as typeof base, now)).toBe(false); });
  }
  test('a candidate with no fence page and a future valid_until is eligible', () => {
    expect(eligibleCandidate(fact, { ...base, source_markdown_slug: null, valid_until: '2027-01-01T00:00:00Z' }, now)).toBe(true);
  });
});

describe('pairs and direction', () => {
  test('pair keys are unordered and source-scoped', () => {
    expect(pairKey('default', 3, 9)).toBe(pairKey('default', 9, 3));
    expect(pairKey('default', 3, 9)).not.toBe(pairKey('other', 3, 9));
  });
  test('direction records whether the superseding fact is the newer one', () => {
    expect(proposalDirection(9, 3)).toBe('new_supersedes_old');
    expect(proposalDirection(3, 9)).toBe('old_supersedes_new');
  });
});

describe('sweepWindow (commit-order lag)', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  test('stops at the first fact younger than 60 s so a later id never passes an uncommitted earlier one', () => {
    const facts = [{ id: 1, created_at: at(300) }, { id: 2, created_at: at(61) }, { id: 3, created_at: at(10) }, { id: 4, created_at: at(600) }];
    expect(sweepWindow(facts, now).map((f) => f.id)).toEqual([1, 2]);
  });
  test('everything old enough is swept', () => {
    expect(sweepWindow([{ id: 1, created_at: at(120) }], now).map((f) => f.id)).toEqual([1]);
    expect(sweepWindow([{ id: 1, created_at: at(59) }], now)).toEqual([]);
  });
});

describe('request shape and dataset', () => {
  test('state is the new fact; one choice per candidate with fact provenance', () => {
    const state = conflictState({ id: 7, source_id: 'default', fact: 'Alice leads design', visibility: 'private' });
    expect(state.fact).toEqual({ text: 'Alice leads design', class: 'facts', fact_id: 7, source_id: 'default', visibility: 'private' });
    const q = conflictQuestion('conflict:0', 0, { id: 3, source_id: 'default', fact: 'Alice leads research', visibility: 'private' });
    expect(q.kind).toBe('choice');
    expect(q.kind === 'choice' && Object.keys(q.options)).toEqual(Object.keys(CONFLICT_OPTIONS));
    expect(q.inputs?.candidate).toMatchObject({ class: 'facts', fact_id: 3, visibility: 'private' });
  });

  test('facts-fixtures parses labelled pairs; the duplicate label is the positive class', async () => {
    const text = [
      JSON.stringify({ id: 'a1', family: 'alice', fact: 'Alice is CTO of Acme', candidate: 'Alice is VP Eng at Acme', label: 'supersede' }),
      JSON.stringify({ id: 'a2', family: 'alice', fact: 'Alice is CTO of Acme', candidate: 'Alice is the CTO at Acme', label: 'duplicate' }),
      JSON.stringify({ id: 'b1', fact: 'Bob likes tea', candidate: 'Bob lives in Paris', label: 'independent' }),
    ].join('\n');
    const items = parseConflictPairs(text);
    expect(items.map((i) => [i.id, i.family, i.label, i.slice, i.rank])).toEqual([
      ['a1', 'alice', false, 'supersede', 0], ['a2', 'alice', true, 'duplicate', 1], ['b1', 'b1', false, 'independent', 0]]);
    expect(new Set(items.filter((i) => i.family === 'alice').map((i) => i.split)).size).toBe(1);
    expect(() => parseConflictPairs('{"id":"x","fact":"a","candidate":"b","label":"maybe"}')).toThrow(/label must be one of/);
    expect(datasetBuilder('facts-fixtures')).toBeDefined();
    const adapter = datasetAdapter('conflict')!;
    const req = adapter.request([...families(items).values()][0]!);
    expect(req.state.fact).toMatchObject({ text: 'Alice is CTO of Acme', class: 'facts' });
    expect(req.questions.map((q) => q.inputs?.candidate?.text)).toEqual(['Alice is VP Eng at Acme', 'Alice is the CTO at Acme']);
    expect(adapter.harmfulActions).toBeUndefined();
  });
});

const FENCE = `# Alice Example

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Alice leads research | fact | 1.0 | private | medium | 2026-01-01 |  | chat |  |
| 2 | Alice leads design | fact | 1.0 | private | medium | 2026-09-01 |  | chat |  |
<!--- gbrain:facts:end -->
`;

function pf(over: Partial<PairFact>): PairFact {
  return { id: 1, source_id: 'default', entity_slug: 'people/alice-example', visibility: 'private', fact: 'x', expired_at: null, valid_until: null,
    superseded_by: null, row_num: 1, source_markdown_slug: 'people/alice-example', ...over };
}

describe('accept and undo plans', () => {
  const oldF = pf({ id: 1, row_num: 1, fact: 'Alice leads research' });
  const newF = pf({ id: 2, row_num: 2, fact: 'Alice leads design' });

  test('accept strikes the old row with a superseded-by reference; undo restores it exactly', () => {
    const plan = planAcceptFence(FENCE, oldF, newF, '2026-09-30')!;
    expect(plan.after).toMatchObject({ rowNum: 1, active: false, supersededBy: 2, validUntil: '2026-09-30' });
    expect(plan.before).toMatchObject({ rowNum: 1, active: true });
    expect(plan.body).toContain('~~Alice leads research~~');
    const fence = { slug: 'people/alice-example', row_num: 1, page_revision: null, file: true };
    const undo = planUndoFence(plan.body, { ...fence, row: plan.before }, { ...fence, row: plan.after });
    expect(undo).not.toBe('changed');
    expect(parseFactsFence((undo as { body: string }).body).facts).toEqual(parseFactsFence(FENCE).facts);
  });

  test('undo refuses when the fence row changed after accept', () => {
    const plan = planAcceptFence(FENCE, oldF, newF, '2026-09-30')!;
    const fence = { slug: 'people/alice-example', row_num: 1, page_revision: null, file: true };
    const edited = plan.body.replace('superseded by #2', 'superseded by #2 | edited');
    expect(planUndoFence(edited, { ...fence, row: plan.before }, { ...fence, row: plan.after })).toBe('changed');
  });

  test('a DB-only fact or a missing fence row has no fence plan', () => {
    expect(planAcceptFence(FENCE, pf({ row_num: null }), newF, '2026-09-30')).toBeNull();
    expect(planAcceptFence(FENCE, pf({ row_num: 9 }), newF, '2026-09-30')).toBeNull();
  });

  test('stale reasons: missing, inactive, lapsed validity and scope drift', () => {
    const p = { source_id: 'default' };
    const now = Date.parse('2026-09-30T00:00:00Z');
    expect(staleReason(p, oldF, newF, now)).toBeNull();
    expect(staleReason(p, null, newF, now)).toBe('fact_missing');
    expect(staleReason(p, pf({ expired_at: '2026-09-29T00:00:00Z' }), newF, now)).toBe('old_fact_inactive');
    expect(staleReason(p, oldF, pf({ valid_until: '2026-09-01T00:00:00Z' }), now)).toBe('new_fact_inactive');
    expect(staleReason(p, oldF, pf({ visibility: 'world' }), now)).toBe('scope_changed');
    expect(staleReason(p, oldF, pf({ entity_slug: 'people/bob-example' }), now)).toBe('scope_changed');
  });

  test('undo refuses when either fact changed since accept', () => {
    const after = { old: factFields(pf({ expired_at: '2026-09-30T00:00:00.000Z', superseded_by: 2 })), new: factFields(newF), fence: null };
    const states = { before: { old: factFields(oldF), new: factFields(newF), fence: null }, after };
    expect(undoRefusal(states, pf({ expired_at: '2026-09-30T00:00:00.000Z', superseded_by: 2 }), newF)).toBeNull();
    expect(undoRefusal(states, pf({ expired_at: '2026-09-30T00:00:00.000Z', superseded_by: 5 }), newF)).toBe('old_fact_changed');
    expect(undoRefusal(states, pf({ expired_at: '2026-09-30T00:00:00.000Z', superseded_by: 2 }), { ...newF, fact: 'Alice leads marketing' })).toBe('new_fact_changed');
  });
});
