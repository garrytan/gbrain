/**
 * v0.42.0.0 — world_knowledge first-class TakeKind (Confer fork).
 *
 * Covers the promotion rule (a `take` with an escalated_from lineage +
 * world_consensus ≥ 0.8 graduates to `world_knowledge`; below threshold or
 * without lineage it stays `take`), the named threshold + boundary, kind
 * round-trip through the takes-fence parser, the CLI kind validator, and
 * no-regression of the extractor parse path (the LLM still never produces
 * world_knowledge; unknown kinds still coerce to 'take').
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyWorldKnowledge,
  isWorldKnowledge,
  isAtOrAboveConsensus,
  WORLD_KNOWLEDGE_KIND,
  WORLD_KNOWLEDGE_CONSENSUS_THRESHOLD,
  PROMOTABLE_SOURCE_KIND,
} from '../src/core/facts/world-knowledge.ts';
import {
  parseTakesFence,
  renderTakesFence,
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
} from '../src/core/takes-fence.ts';
import {
  parseExtractorOutput,
  promoteProposal,
  type ProposedTake,
} from '../src/core/cycle/propose-takes.ts';

describe('classifyWorldKnowledge — promotion rule', () => {
  test('take + escalated_from lineage + consensus ≥ 0.8 → world_knowledge', () => {
    expect(
      classifyWorldKnowledge({ kind: 'take', hasEscalatedFromLineage: true, worldConsensus: 0.82 }),
    ).toBe('world_knowledge');
  });

  test('consensus exactly 0.8 promotes (inclusive bound)', () => {
    expect(
      classifyWorldKnowledge({ kind: 'take', hasEscalatedFromLineage: true, worldConsensus: 0.8 }),
    ).toBe('world_knowledge');
  });

  test('consensus just below threshold (0.79) stays take', () => {
    expect(
      classifyWorldKnowledge({ kind: 'take', hasEscalatedFromLineage: true, worldConsensus: 0.79 }),
    ).toBe('take');
  });

  test('no escalated_from lineage stays take even with high consensus', () => {
    expect(
      classifyWorldKnowledge({ kind: 'take', hasEscalatedFromLineage: false, worldConsensus: 0.95 }),
    ).toBe('take');
  });

  test('null consensus is treated as 0 → stays take', () => {
    expect(
      classifyWorldKnowledge({ kind: 'take', hasEscalatedFromLineage: true, worldConsensus: null }),
    ).toBe('take');
  });

  test('non-take kinds are NOT promoted (fact/bet/hunch unchanged)', () => {
    for (const kind of ['fact', 'bet', 'hunch'] as const) {
      expect(
        classifyWorldKnowledge({ kind, hasEscalatedFromLineage: true, worldConsensus: 0.99 }),
      ).toBe(kind);
    }
  });

  test('an already-world_knowledge row is returned unchanged (no double-promote, no demote)', () => {
    expect(
      classifyWorldKnowledge({ kind: 'world_knowledge', hasEscalatedFromLineage: true, worldConsensus: 0.9 }),
    ).toBe('world_knowledge');
    expect(
      classifyWorldKnowledge({ kind: 'world_knowledge', hasEscalatedFromLineage: false, worldConsensus: 0.1 }),
    ).toBe('world_knowledge');
  });

  test('isWorldKnowledge mirrors classifyWorldKnowledge', () => {
    expect(isWorldKnowledge({ kind: 'take', hasEscalatedFromLineage: true, worldConsensus: 0.85 })).toBe(true);
    expect(isWorldKnowledge({ kind: 'take', hasEscalatedFromLineage: true, worldConsensus: 0.5 })).toBe(false);
  });
});

describe('world_knowledge constants', () => {
  test('threshold is the pack-stated 0.8', () => {
    expect(WORLD_KNOWLEDGE_CONSENSUS_THRESHOLD).toBe(0.8);
  });

  test('kind value + promotable source kind', () => {
    expect(WORLD_KNOWLEDGE_KIND).toBe('world_knowledge');
    expect(PROMOTABLE_SOURCE_KIND).toBe('take');
  });

  test('isAtOrAboveConsensus boundary', () => {
    expect(isAtOrAboveConsensus(0.8)).toBe(true);
    expect(isAtOrAboveConsensus(0.7999)).toBe(false);
    expect(isAtOrAboveConsensus(null)).toBe(false);
    expect(isAtOrAboveConsensus(1)).toBe(true);
  });
});

describe('takes-fence — world_knowledge round-trips as a first-class kind', () => {
  const BODY = `## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Distribution beats product in B2B | world_knowledge | world | 0.9 | 2026-05 | consensus |
| 2 | A normal opinion | take | garry | 0.6 | 2026-05 | OH |
| 3 | Bogus kind here | wibble | garry | 0.5 | 2026-05 | x |
${TAKES_FENCE_END}`;

  test('parses a world_knowledge row without warning', () => {
    const { takes, warnings } = parseTakesFence(BODY);
    const wk = takes.find(t => t.rowNum === 1)!;
    expect(wk).toBeDefined();
    expect(wk.kind).toBe('world_knowledge');
    // world_knowledge must NOT be reported as an unknown kind. (The 'wibble'
    // row's warning incidentally contains the literal "world_knowledge" because
    // it's listed in the expected-kinds hint, so match the full unknown-kind
    // phrase keyed on the offending value instead.)
    expect(warnings.some(w => w.includes('unknown kind "world_knowledge"'))).toBe(false);
  });

  test("still flags genuinely unknown kinds (no over-widening)", () => {
    const { takes, warnings } = parseTakesFence(BODY);
    expect(takes.find(t => t.rowNum === 3)).toBeUndefined();
    expect(warnings.some(w => w.includes('unknown kind "wibble"'))).toBe(true);
  });

  test('render → parse preserves the world_knowledge kind', () => {
    const { takes } = parseTakesFence(BODY);
    const rendered = renderTakesFence(takes);
    const { takes: roundTripped } = parseTakesFence(`${rendered}`);
    const wk = roundTripped.find(t => t.rowNum === 1)!;
    expect(wk.kind).toBe('world_knowledge');
  });

  test('the four base kinds still parse unchanged (no regression)', () => {
    const base = `${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | f | fact | world | 1.0 |  |  |
| 2 | t | take | garry | 0.6 |  |  |
| 3 | b | bet | garry | 0.7 |  |  |
| 4 | h | hunch | garry | 0.3 |  |  |
${TAKES_FENCE_END}`;
    const { takes, warnings } = parseTakesFence(base);
    expect(takes).toHaveLength(4);
    expect(takes.map(t => t.kind)).toEqual(['fact', 'take', 'bet', 'hunch']);
    expect(warnings).toEqual([]);
  });
});

describe('propose-takes — promoteProposal seam + no LLM self-assert', () => {
  const baseProposal: ProposedTake = {
    claim_text: 'Marketplaces with cold-start liquidity win',
    kind: 'take',
    holder: 'world',
    weight: 0.7,
    domain: 'market',
  };

  test('promoteProposal graduates a qualifying take (returns a copy)', () => {
    const out = promoteProposal(baseProposal, { hasEscalatedFromLineage: true, worldConsensus: 0.81 });
    expect(out.kind).toBe('world_knowledge');
    // immutability: input untouched
    expect(baseProposal.kind).toBe('take');
    expect(out.claim_text).toBe(baseProposal.claim_text);
  });

  test('promoteProposal leaves a non-qualifying take unchanged (same object)', () => {
    const out = promoteProposal(baseProposal, { hasEscalatedFromLineage: true, worldConsensus: 0.5 });
    expect(out.kind).toBe('take');
    expect(out).toBe(baseProposal); // unchanged → identity preserved
  });

  test('promoteProposal does not promote a bet/hunch/fact', () => {
    for (const kind of ['fact', 'bet', 'hunch'] as const) {
      const out = promoteProposal({ ...baseProposal, kind }, { hasEscalatedFromLineage: true, worldConsensus: 0.99 });
      expect(out.kind).toBe(kind);
    }
  });

  test('the extractor (LLM) parse path NEVER yields world_knowledge — it coerces to take', () => {
    const raw = '[{"claim_text":"X is now settled science","kind":"world_knowledge","holder":"world","weight":0.9}]';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('take'); // model cannot self-assert consensus
  });

  test('unknown kind still coerces to take (existing behavior preserved)', () => {
    const raw = '[{"claim_text":"a","kind":"unknown_kind","holder":"brain","weight":0.5}]';
    const out = parseExtractorOutput(raw);
    expect(out[0]!.kind).toBe('take');
  });

  test('the four base kinds round-trip through parseExtractorOutput', () => {
    const raw = JSON.stringify(
      (['fact', 'take', 'bet', 'hunch'] as const).map((kind, i) => ({
        claim_text: `c${i}`, kind, holder: 'brain', weight: 0.5,
      })),
    );
    const out = parseExtractorOutput(raw);
    expect(out.map(o => o.kind)).toEqual(['fact', 'take', 'bet', 'hunch']);
  });
});
