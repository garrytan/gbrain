/**
 * v0.32.2 — facts-fence parser/renderer tests.
 *
 * Mirrors test/takes-fence.test.ts coverage: canonical happy path, lenient
 * hand-edits, malformed-row recovery, strikethrough semantics (superseded
 * vs forgotten — the Codex R2-#3 contract), pipe-escape round-trip, and
 * the privacy-aware stripFactsFence contract that the chunker (Layer A)
 * and get_page (Layer B) both consume.
 */

import { describe, test, expect } from 'bun:test';

import {
  parseFactsFence,
  renderFactsTable,
  upsertFactRow,
  stripFactsFence,
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  type ParsedFact,
  type FactKind,
  type FactNotability,
} from '../src/core/facts-fence.ts';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const minimalFact = (rowNum: number, overrides: Partial<ParsedFact> = {}): ParsedFact => ({
  rowNum,
  claim: 'A claim about something',
  kind: 'fact',
  confidence: 1.0,
  visibility: 'world',
  notability: 'medium',
  validFrom: '2026-01-01',
  active: true,
  ...overrides,
});

const wrapFenceBody = (rows: string): string => `# Page

Some preamble.

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
${FACTS_FENCE_END}
`;

// ─────────────────────────────────────────────────────────────────
// parseFactsFence
// ─────────────────────────────────────────────────────────────────

describe('parseFactsFence — canonical happy path', () => {
  test('returns empty + empty warnings when no fence is present', () => {
    const r = parseFactsFence('# Some page\n\nJust prose, no fence.');
    expect(r.facts).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('parses a clean single-row fence', () => {
    const body = wrapFenceBody(
      `| 1 | Founded Acme in 2017 | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.warnings).toEqual([]);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]).toMatchObject({
      rowNum: 1,
      claim: 'Founded Acme in 2017',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'world',
      notability: 'high',
      validFrom: '2017-01-01',
      validUntil: undefined,
      source: 'linkedin',
      active: true,
    });
  });

  test('parses multi-row fence preserving row order', () => {
    const body = wrapFenceBody(
      `| 1 | First claim | fact | 1.0 | world | high | 2026-01-01 |  | src1 |  |
| 2 | Second claim | preference | 0.85 | private | medium | 2026-01-02 |  | src2 |  |
| 3 | Third claim | commitment | 0.5 | world | low | 2026-01-03 | 2026-12-31 | src3 |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts).toHaveLength(3);
    expect(r.facts.map(f => f.rowNum)).toEqual([1, 2, 3]);
    expect(r.facts[2]).toMatchObject({
      kind: 'commitment',
      validUntil: '2026-12-31',
    });
  });

  test('all five kinds parse', () => {
    const kinds: FactKind[] = ['event', 'preference', 'commitment', 'belief', 'fact'];
    const body = wrapFenceBody(
      kinds.map((k, i) =>
        `| ${i + 1} | claim${i} | ${k} | 1.0 | world | medium | 2026-01-01 |  | src |  |`,
      ).join('\n'),
    );
    const r = parseFactsFence(body);
    expect(r.facts.map(f => f.kind)).toEqual(kinds);
    expect(r.warnings).toEqual([]);
  });

  test('both visibility values parse', () => {
    const body = wrapFenceBody(
      `| 1 | private one | fact | 1.0 | private | medium | 2026-01-01 |  | src |  |
| 2 | world one | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts.map(f => f.visibility)).toEqual(['private', 'world']);
  });

  test('all three notability values parse', () => {
    const tiers: FactNotability[] = ['high', 'medium', 'low'];
    const body = wrapFenceBody(
      tiers.map((n, i) =>
        `| ${i + 1} | claim | fact | 1.0 | world | ${n} | 2026-01-01 |  | src |  |`,
      ).join('\n'),
    );
    const r = parseFactsFence(body);
    expect(r.facts.map(f => f.notability)).toEqual(tiers);
  });
});

describe('parseFactsFence — strikethrough semantics (Codex R2-#3 contract)', () => {
  test('strikethrough + "superseded by #N" context → supersededBy populated', () => {
    const body = wrapFenceBody(
      `| 1 | ~~Old claim~~ | fact | 0.8 | world | medium | 2026-01-01 |  | src | superseded by #2 |
| 2 | New claim | fact | 0.9 | world | medium | 2026-06-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts[0]).toMatchObject({
      claim: 'Old claim',  // strikethrough markers stripped
      active: false,
      supersededBy: 2,
      forgotten: false,
    });
    expect(r.facts[1].active).toBe(true);
  });

  test('strikethrough + "forgotten: <reason>" context → forgotten=true', () => {
    const body = wrapFenceBody(
      `| 1 | ~~Stale fact~~ | fact | 1.0 | private | low | 2018-01-01 | 2026-05-10 | inferred | forgotten: user asked to remove |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts[0]).toMatchObject({
      claim: 'Stale fact',
      active: false,
      forgotten: true,
      supersededBy: undefined,
      context: 'forgotten: user asked to remove',
      validUntil: '2026-05-10',
    });
  });

  test('strikethrough with unrecognized context → inactive but no superseded/forgotten flag', () => {
    const body = wrapFenceBody(
      `| 1 | ~~Something~~ | fact | 1.0 | world | medium | 2026-01-01 |  | src | random note |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts[0]).toMatchObject({
      claim: 'Something',
      active: false,
      supersededBy: undefined,
      forgotten: false,
    });
  });

  test('NO strikethrough but context contains "superseded by #N" → active stays true, supersededBy NOT populated', () => {
    // The strikethrough is the trigger. A row whose claim text mentions
    // superseded but isn't struck-through stays active. Prevents a stray
    // mention in `context` from inadvertently marking a row inactive.
    const body = wrapFenceBody(
      `| 1 | Talked about the superseded by #3 issue | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts[0].active).toBe(true);
    expect(r.facts[0].supersededBy).toBeUndefined();
  });

  test('case-insensitive "Superseded By #N" still parses', () => {
    const body = wrapFenceBody(
      `| 1 | ~~Old~~ | fact | 0.8 | world | medium | 2026-01-01 |  | src | Superseded By #42 |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts[0].supersededBy).toBe(42);
  });
});

describe('parseFactsFence — lenient hand-edits', () => {
  test('skips separator row (just dashes)', () => {
    const body = wrapFenceBody(
      `| 1 | claim | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts).toHaveLength(1);
  });

  test('tolerates extra whitespace inside cells', () => {
    const body = wrapFenceBody(
      `|   1   |   claim   |   fact   |   1.0   |   world   |   medium   |   2026-01-01   |    |   src   |    |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts[0]).toMatchObject({
      claim: 'claim',
      source: 'src',
    });
  });

  test('missing trailing context cell (9 cells instead of 10) still parses', () => {
    // Markdown editors often drop empty trailing pipes. The parser tolerates
    // this by treating context as defaulted-empty.
    const inner = `| 1 | claim | fact | 1.0 | world | medium | 2026-01-01 |  | src |`;
    const body = `${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n${inner}\n${FACTS_FENCE_END}`;
    const r = parseFactsFence(body);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].context).toBeUndefined();
  });
});

describe('parseFactsFence — malformed rows surface warnings', () => {
  test('unknown kind → warning, row skipped', () => {
    const body = wrapFenceBody(
      `| 1 | claim | bogus | 1.0 | world | medium | 2026-01-01 |  | src |  |
| 2 | ok | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].rowNum).toBe(2);
    expect(r.warnings.some(w => w.includes('unknown kind "bogus"'))).toBe(true);
  });

  test('unknown visibility → warning, row skipped', () => {
    const body = wrapFenceBody(
      `| 1 | claim | fact | 1.0 | restricted | medium | 2026-01-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts).toHaveLength(0);
    expect(r.warnings.some(w => w.includes('unknown visibility "restricted"'))).toBe(true);
  });

  test('unknown notability → warning, row skipped', () => {
    const body = wrapFenceBody(
      `| 1 | claim | fact | 1.0 | world | critical | 2026-01-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts).toHaveLength(0);
    expect(r.warnings.some(w => w.includes('unknown notability "critical"'))).toBe(true);
  });

  test('non-numeric confidence → warning, row skipped', () => {
    const body = wrapFenceBody(
      `| 1 | claim | fact | high | world | medium | 2026-01-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts).toHaveLength(0);
    expect(r.warnings.some(w => w.includes('non-numeric confidence "high"'))).toBe(true);
  });

  test('duplicate row_num → warning, second occurrence skipped', () => {
    const body = wrapFenceBody(
      `| 1 | first | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |
| 1 | second | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].claim).toBe('first');
    expect(r.warnings.some(w => w.includes('FACTS_ROW_NUM_COLLISION'))).toBe(true);
  });

  test('invalid row_num (zero) → warning, row skipped', () => {
    const body = wrapFenceBody(
      `| 0 | claim | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |`,
    );
    const r = parseFactsFence(body);
    expect(r.facts).toHaveLength(0);
    expect(r.warnings.some(w => w.includes('invalid row_num'))).toBe(true);
  });

  test('unbalanced fence (begin without end) → warning, empty facts', () => {
    const body = `# Page\n\n${FACTS_FENCE_BEGIN}\n| 1 | claim | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |\n`;
    const r = parseFactsFence(body);
    expect(r.facts).toEqual([]);
    expect(r.warnings.some(w => w.includes('FACTS_FENCE_UNBALANCED'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// renderFactsTable
// ─────────────────────────────────────────────────────────────────

describe('renderFactsTable', () => {
  test('produces a canonical-shape fence with header + separator + rows', () => {
    const out = renderFactsTable([
      minimalFact(1, { claim: 'C1', source: 's1' }),
      minimalFact(2, { claim: 'C2', kind: 'preference', confidence: 0.85, visibility: 'private' }),
    ]);
    expect(out).toContain(FACTS_FENCE_BEGIN);
    expect(out).toContain(FACTS_FENCE_END);
    expect(out).toContain('| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |');
    expect(out).toContain('| 1 | C1 | fact | 1.0 | world | medium | 2026-01-01 |');
    expect(out).toContain('| 2 | C2 | preference | 0.85 | private | medium |');
  });

  test('inactive rows render with strikethrough on claim', () => {
    const out = renderFactsTable([
      minimalFact(1, { claim: 'Old', active: false, context: 'superseded by #2' }),
      minimalFact(2, { claim: 'New' }),
    ]);
    expect(out).toContain('~~Old~~');
    expect(out).toContain('superseded by #2');
  });

  test('escapes literal pipes in claim/source/context cells', () => {
    const out = renderFactsTable([
      minimalFact(1, {
        claim: 'Has | a | pipe',
        source: 'src | with pipes',
        context: 'context | with pipes',
      }),
    ]);
    expect(out).toContain('Has \\| a \\| pipe');
    expect(out).toContain('src \\| with pipes');
    expect(out).toContain('context \\| with pipes');
  });

  test('confidence formatting: integer .0, fractional trim trailing zeros', () => {
    const out = renderFactsTable([
      minimalFact(1, { confidence: 1.0 }),
      minimalFact(2, { confidence: 0.85 }),
      minimalFact(3, { confidence: 0.5 }),
    ]);
    expect(out).toContain('| 1.0 |');
    expect(out).toContain('| 0.85 |');
    expect(out).toContain('| 0.5 |');
  });
});

// ─────────────────────────────────────────────────────────────────
// Round-trip: render → parse → identical (modulo escape decoding)
// ─────────────────────────────────────────────────────────────────

describe('round-trip: render then parse returns equivalent rows', () => {
  test('canonical row survives render+parse with all fields intact', () => {
    const original: ParsedFact = minimalFact(1, {
      claim: 'Founded Acme in 2017',
      kind: 'event',
      confidence: 0.95,
      visibility: 'world',
      notability: 'high',
      validFrom: '2017-01-01',
      validUntil: undefined,
      source: 'linkedin',
      context: 'Founder bio',
      active: true,
    });
    const rendered = renderFactsTable([original]);
    const reparsed = parseFactsFence(rendered);
    expect(reparsed.warnings).toEqual([]);
    expect(reparsed.facts).toHaveLength(1);
    expect(reparsed.facts[0]).toMatchObject({
      rowNum: original.rowNum,
      claim: original.claim,
      kind: original.kind,
      confidence: original.confidence,
      visibility: original.visibility,
      notability: original.notability,
      validFrom: original.validFrom,
      source: original.source,
      context: original.context,
      active: true,
    });
  });

  test('strikethrough-superseded row round-trips with supersededBy preserved', () => {
    const original: ParsedFact = minimalFact(1, {
      claim: 'Old',
      active: false,
      context: 'superseded by #2',
    });
    const rendered = renderFactsTable([original]);
    const reparsed = parseFactsFence(rendered);
    expect(reparsed.facts[0]).toMatchObject({
      claim: 'Old',
      active: false,
      supersededBy: 2,
    });
  });

  test('strikethrough-forgotten row round-trips with forgotten flag', () => {
    const original: ParsedFact = minimalFact(1, {
      claim: 'Stale',
      active: false,
      context: 'forgotten: user removed',
    });
    const rendered = renderFactsTable([original]);
    const reparsed = parseFactsFence(rendered);
    expect(reparsed.facts[0]).toMatchObject({
      claim: 'Stale',
      active: false,
      forgotten: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// upsertFactRow
// ─────────────────────────────────────────────────────────────────

describe('upsertFactRow', () => {
  test('appends to empty body by creating ## Facts section + fence', () => {
    const body = '# Some Entity\n\nProse here.\n';
    const { body: out, rowNum } = upsertFactRow(body, {
      claim: 'A new fact',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'world',
      notability: 'medium',
    });
    expect(rowNum).toBe(1);
    expect(out).toContain('## Facts');
    expect(out).toContain(FACTS_FENCE_BEGIN);
    expect(out).toContain('| 1 | A new fact | fact');
    expect(out).toContain('Prose here.');  // preamble preserved
  });

  test('appends to existing fence with row_num = max + 1', () => {
    const body = wrapFenceBody(
      `| 1 | First | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |
| 7 | Seventh | fact | 1.0 | world | medium | 2026-01-01 |  | src |  |`,
    );
    const { body: out, rowNum } = upsertFactRow(body, {
      claim: 'New row',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'world',
      notability: 'medium',
    });
    expect(rowNum).toBe(8);
    expect(out).toContain('| 8 | New row | fact');
    // Existing rows preserved
    expect(out).toContain('| 1 | First |');
    expect(out).toContain('| 7 | Seventh |');
  });

  test('round-trip-preservation: hand-edited strikethrough row survives an unrelated append', () => {
    // Regression guard for the codex F3-style silent-data-loss bug class.
    // If upsertFactRow blindly serialized fresh state without re-parsing
    // existing rows through parseFactsFence, strikethrough on row 1 would
    // disappear when we add row 2.
    const body = wrapFenceBody(
      `| 1 | ~~Old~~ | fact | 0.8 | world | medium | 2026-01-01 |  | src | superseded by #2 |`,
    );
    const { body: out } = upsertFactRow(body, {
      claim: 'Replacement',
      kind: 'fact',
      confidence: 0.9,
      visibility: 'world',
      notability: 'medium',
      context: undefined,
    });
    // The strikethrough on row 1 must still be there.
    expect(out).toContain('~~Old~~');
    expect(out).toContain('superseded by #2');
    expect(out).toContain('Replacement');
  });
});

// ─────────────────────────────────────────────────────────────────
// stripFactsFence — privacy boundary (Codex R2-#1 + Q5)
// ─────────────────────────────────────────────────────────────────

describe('stripFactsFence', () => {
  test('no-fence body returns unchanged', () => {
    const body = '# Page\n\nNo fence here.\n';
    expect(stripFactsFence(body)).toBe(body);
  });

  test('default (no opts) drops the entire fence block — used by the chunker', () => {
    const body = wrapFenceBody(
      `| 1 | private fact | fact | 1.0 | private | high | 2026-01-01 |  | src |  |
| 2 | world fact | fact | 1.0 | world | high | 2026-01-01 |  | src |  |`,
    );
    const stripped = stripFactsFence(body);
    expect(stripped).not.toContain(FACTS_FENCE_BEGIN);
    expect(stripped).not.toContain(FACTS_FENCE_END);
    expect(stripped).not.toContain('private fact');
    expect(stripped).not.toContain('world fact');
    // Preamble + Facts heading still present (we only stripped the fence body)
    expect(stripped).toContain('Some preamble');
  });

  test('keepVisibility:["world"] keeps world rows, drops private rows', () => {
    const body = wrapFenceBody(
      `| 1 | PRIVATE_TEXT_PROOF | fact | 1.0 | private | high | 2026-01-01 |  | src |  |
| 2 | WORLD_TEXT_PROOF | fact | 1.0 | world | high | 2026-01-01 |  | src |  |`,
    );
    const stripped = stripFactsFence(body, { keepVisibility: ['world'] });
    expect(stripped).toContain('WORLD_TEXT_PROOF');
    expect(stripped).not.toContain('PRIVATE_TEXT_PROOF');
    // Fence shape preserved so callers can still parse/round-trip
    expect(stripped).toContain(FACTS_FENCE_BEGIN);
    expect(stripped).toContain(FACTS_FENCE_END);
  });

  test('keepVisibility with NO world rows produces an empty-but-well-formed fence', () => {
    const body = wrapFenceBody(
      `| 1 | private only | fact | 1.0 | private | high | 2026-01-01 |  | src |  |`,
    );
    const stripped = stripFactsFence(body, { keepVisibility: ['world'] });
    expect(stripped).not.toContain('private only');
    expect(stripped).toContain(FACTS_FENCE_BEGIN);
    expect(stripped).toContain(FACTS_FENCE_END);
  });

  test('keepVisibility:[] (empty array) is treated as whole-fence strip — defensive at the boundary', () => {
    // If a caller accidentally passes an empty list, the safe behavior is
    // "strip everything" rather than "keep everything." Privacy boundaries
    // default to deny.
    const body = wrapFenceBody(
      `| 1 | something | fact | 1.0 | world | high | 2026-01-01 |  | src |  |`,
    );
    const stripped = stripFactsFence(body, { keepVisibility: [] });
    expect(stripped).not.toContain('something');
    expect(stripped).not.toContain(FACTS_FENCE_BEGIN);
  });
});
