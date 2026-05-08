import { describe, test, expect } from 'bun:test';
import {
  parseTakesFence,
  renderTakesFence,
  upsertTakeRow,
  supersedeRow,
  stripTakesFence,
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
} from '../src/core/takes-fence.ts';

const SAMPLE_BODY = `# Alice Example

Some prose at the top.

## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | CEO of Acme | fact | world | 1.0 | 2017-01 | Crustdata |
| 2 | Strong technical founder | take | garry | 0.85 | 2026-04-29 | OH 2026-04-29 |
| 3 | ~~Will reach $50B~~ | bet | garry | 0.7 | 2026-04-29 → 2026-06 | superseded by #4 |
| 4 | Will reach $30B | bet | garry | 0.55 | 2026-06 | revised after Q2 |
${TAKES_FENCE_END}

## Notes

Other content below the fence.
`;

describe('parseTakesFence', () => {
  test('parses canonical-form table', () => {
    const { takes, warnings } = parseTakesFence(SAMPLE_BODY);
    expect(warnings).toEqual([]);
    expect(takes).toHaveLength(4);
    expect(takes[0]).toMatchObject({
      rowNum: 1,
      claim: 'CEO of Acme',
      kind: 'fact',
      holder: 'world',
      weight: 1.0,
      sinceDate: '2017-01',
      source: 'Crustdata',
      active: true,
    });
  });

  test('strikethrough → active=false; claim text stripped', () => {
    const { takes } = parseTakesFence(SAMPLE_BODY);
    const row3 = takes.find(t => t.rowNum === 3)!;
    expect(row3.active).toBe(false);
    expect(row3.claim).toBe('Will reach $50B');
  });

  test('date range splits into since + until', () => {
    const { takes } = parseTakesFence(SAMPLE_BODY);
    const row3 = takes.find(t => t.rowNum === 3)!;
    expect(row3.sinceDate).toBe('2026-04-29');
    expect(row3.untilDate).toBe('2026-06');
  });

  test('returns empty + no warnings when no fence present', () => {
    const { takes, warnings } = parseTakesFence('# Just prose\n\nNo takes here.');
    expect(takes).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('warns on unbalanced fence (missing end)', () => {
    const body = `## Takes\n\n${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n`;
    const { takes, warnings } = parseTakesFence(body);
    expect(takes).toEqual([]);
    expect(warnings.some(w => w.includes('TAKES_FENCE_UNBALANCED'))).toBe(true);
  });

  test('skips malformed rows + records TAKES_TABLE_MALFORMED warnings', () => {
    const body = `${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Valid row | fact | world | 1.0 | 2026-01 | source |
| 2 | Bad weight | take | garry | not-a-number | 2026-01 | x |
| 3 | Unknown kind | wibble | garry | 0.5 | 2026-01 | x |
| zzz | Bad rownum | fact | world | 1.0 | 2026-01 | x |
${TAKES_FENCE_END}`;
    const { takes, warnings } = parseTakesFence(body);
    expect(takes).toHaveLength(1);
    expect(takes[0].claim).toBe('Valid row');
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(warnings.some(w => w.includes('non-numeric weight'))).toBe(true);
    expect(warnings.some(w => w.includes('unknown kind'))).toBe(true);
    expect(warnings.some(w => w.includes('invalid row_num'))).toBe(true);
  });

  test('flags TAKES_ROW_NUM_COLLISION on duplicate row_num', () => {
    const body = `${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | First | fact | world | 1.0 |  |  |
| 1 | Duplicate | fact | world | 1.0 |  |  |
${TAKES_FENCE_END}`;
    const { takes, warnings } = parseTakesFence(body);
    expect(takes).toHaveLength(1);
    expect(warnings.some(w => w.includes('TAKES_ROW_NUM_COLLISION'))).toBe(true);
  });
});

describe('renderTakesFence', () => {
  test('round-trip preserves all fields', () => {
    const original = parseTakesFence(SAMPLE_BODY);
    const rendered = renderTakesFence(original.takes);
    expect(rendered.startsWith(TAKES_FENCE_BEGIN)).toBe(true);
    expect(rendered.endsWith(TAKES_FENCE_END)).toBe(true);
    // Re-parse the rendered fence and confirm round-trip equivalence.
    const reparsed = parseTakesFence(rendered);
    expect(reparsed.warnings).toEqual([]);
    expect(reparsed.takes).toHaveLength(original.takes.length);
    for (let i = 0; i < original.takes.length; i++) {
      const before = original.takes[i];
      const after = reparsed.takes[i];
      expect(after.rowNum).toBe(before.rowNum);
      expect(after.claim).toBe(before.claim);
      expect(after.kind).toBe(before.kind);
      expect(after.holder).toBe(before.holder);
      expect(after.weight).toBe(before.weight);
      expect(after.active).toBe(before.active);
      expect(after.sinceDate).toBe(before.sinceDate);
      expect(after.untilDate).toBe(before.untilDate);
      expect(after.source).toBe(before.source);
    }
  });
});

describe('upsertTakeRow', () => {
  test('appends to existing fence at next row_num', () => {
    const { body, rowNum } = upsertTakeRow(SAMPLE_BODY, {
      claim: 'Best founder I have met this batch',
      kind: 'take',
      holder: 'garry',
      weight: 0.95,
      sinceDate: '2026-05-01',
      source: 'OH 2026-05-01',
      active: true,
    });
    expect(rowNum).toBe(5);
    const { takes } = parseTakesFence(body);
    expect(takes).toHaveLength(5);
    expect(takes[4].claim).toBe('Best founder I have met this batch');
    expect(takes[4].rowNum).toBe(5);
  });

  test('creates a new Takes section when no fence exists', () => {
    const fresh = '# New Page\n\nSome content.\n';
    const { body, rowNum } = upsertTakeRow(fresh, {
      claim: 'First take',
      kind: 'fact',
      holder: 'world',
      weight: 1.0,
      active: true,
    });
    expect(rowNum).toBe(1);
    expect(body).toContain('## Takes');
    expect(body).toContain(TAKES_FENCE_BEGIN);
    const { takes } = parseTakesFence(body);
    expect(takes).toHaveLength(1);
  });

  test('row_num is monotonic — never reuses gaps', () => {
    // Body where rows 2 and 4 are present (1 and 3 deleted by hand-edit)
    const body = `## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 2 | Two | fact | world | 1.0 | 2026-01 | x |
| 4 | Four | fact | world | 1.0 | 2026-01 | x |
${TAKES_FENCE_END}
`;
    const { rowNum } = upsertTakeRow(body, {
      claim: 'Five',
      kind: 'fact',
      holder: 'world',
      weight: 1.0,
      active: true,
    });
    expect(rowNum).toBe(5); // max(2,4)+1, NOT 1 (gap-fill would break refs)
  });
});

describe('supersedeRow', () => {
  test('strikes old row + appends new at end', () => {
    const { body, oldRowNum, newRowNum } = supersedeRow(SAMPLE_BODY, 2, {
      claim: 'Strongest technical founder I have met',
      kind: 'take',
      holder: 'garry',
      weight: 0.95,
      sinceDate: '2026-05-01',
      source: 'OH 2026-05-01',
    });
    expect(oldRowNum).toBe(2);
    expect(newRowNum).toBe(5);
    const { takes } = parseTakesFence(body);
    const old = takes.find(t => t.rowNum === 2)!;
    expect(old.active).toBe(false);
    const fresh = takes.find(t => t.rowNum === 5)!;
    expect(fresh.claim).toBe('Strongest technical founder I have met');
    expect(fresh.active).toBe(true);
  });

  test('throws when target row not found', () => {
    expect(() =>
      supersedeRow(SAMPLE_BODY, 999, {
        claim: 'x',
        kind: 'fact',
        holder: 'world',
        weight: 1.0,
      }),
    ).toThrow();
  });
});

describe('stripTakesFence', () => {
  test('removes the fence block from the body (privacy fix)', () => {
    const stripped = stripTakesFence(SAMPLE_BODY);
    expect(stripped).not.toContain(TAKES_FENCE_BEGIN);
    expect(stripped).not.toContain(TAKES_FENCE_END);
    expect(stripped).not.toContain('Strong technical founder');
    expect(stripped).not.toContain('Will reach $50B');
    // Surrounding prose preserved.
    expect(stripped).toContain('Some prose at the top.');
    expect(stripped).toContain('## Notes');
    expect(stripped).toContain('Other content below the fence.');
  });

  test('returns body unchanged when no fence present', () => {
    const body = '# Plain page\n\nNo takes here.';
    expect(stripTakesFence(body)).toBe(body);
  });
});

// ============================================================
// v0.30.0 (Slice A1): resolution columns + round-trip preservation.
// The round-trip preservation tests are the codex-F3 regression gate.
// Without these, every `gbrain takes update` after a resolve silently
// deletes the resolution data on the next render.
// ============================================================

describe('v0.30.0 resolution columns', () => {
  const RESOLVED_BODY = `# Some Page\n\n## Takes\n\n${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |
|---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|
| 1 | First bet | bet | garry | 0.7 | 2026-04 | OH | 2026-04-30 | correct | Series A closed | 50 | usd | garry |
| 2 | Pending bet | bet | garry | 0.6 | 2026-04 | OH |  |  |  |  |  |  |
${TAKES_FENCE_END}\n`;

  test('parses v0.30-shape fence: resolved row has resolution fields populated', () => {
    const { takes, warnings } = parseTakesFence(RESOLVED_BODY);
    expect(warnings).toEqual([]);
    expect(takes).toHaveLength(2);
    expect(takes[0]).toMatchObject({
      rowNum: 1,
      resolvedAt: '2026-04-30',
      resolvedQuality: 'correct',
      resolvedOutcome: true,
      resolvedEvidence: 'Series A closed',
      resolvedValue: 50,
      resolvedUnit: 'usd',
      resolvedBy: 'garry',
    });
  });

  test('parses v0.30-shape fence: unresolved row has resolution fields undefined', () => {
    const { takes } = parseTakesFence(RESOLVED_BODY);
    expect(takes[1].resolvedQuality).toBeUndefined();
    expect(takes[1].resolvedOutcome).toBeUndefined();
    expect(takes[1].resolvedAt).toBeUndefined();
  });

  test('renderer: page with no resolved rows keeps narrow 7-column shape', () => {
    const { takes } = parseTakesFence(SAMPLE_BODY);
    const rendered = renderTakesFence(takes);
    expect(rendered).toContain('| # | claim | kind | who | weight | since | source |');
    expect(rendered).not.toContain('quality');
    expect(rendered).not.toContain('resolved');
  });

  test('renderer: any resolved row triggers wide 13-column shape', () => {
    const { takes } = parseTakesFence(SAMPLE_BODY);
    // Mutate one row to have resolution data.
    takes[0] = {
      ...takes[0],
      resolvedAt: '2026-05-01',
      resolvedQuality: 'correct',
      resolvedOutcome: true,
      resolvedEvidence: 'verified',
    };
    const rendered = renderTakesFence(takes);
    expect(rendered).toContain('quality');
    expect(rendered).toContain('evidence');
    expect(rendered).toContain('correct');
    expect(rendered).toContain('verified');
  });

  // ============================================================
  // CODEX F3 REGRESSION GATE — DATA-LOSS BUG GUARD
  // ============================================================
  // Without these tests, `gbrain takes update --row 2` on a page where row 1
  // is resolved would render only the 7-column shape on parse + render,
  // silently deleting row 1's resolution cells on the next disk write.
  // ============================================================
  test('REGRESSION (codex F3): round-trip preserves resolution fields on a resolved row', () => {
    const { takes } = parseTakesFence(RESOLVED_BODY);
    const rendered = renderTakesFence(takes);
    const { takes: roundTripped } = parseTakesFence(rendered);
    expect(roundTripped).toHaveLength(2);
    expect(roundTripped[0].resolvedQuality).toBe('correct');
    expect(roundTripped[0].resolvedOutcome).toBe(true);
    expect(roundTripped[0].resolvedAt).toBe('2026-04-30');
    expect(roundTripped[0].resolvedEvidence).toBe('Series A closed');
    expect(roundTripped[0].resolvedValue).toBe(50);
    expect(roundTripped[0].resolvedUnit).toBe('usd');
    expect(roundTripped[0].resolvedBy).toBe('garry');
  });

  test('REGRESSION (codex F3): updating an unrelated row preserves resolution on the resolved row', () => {
    const { takes } = parseTakesFence(RESOLVED_BODY);
    // Simulate cmdUpdate's spread pattern on row 2 (the unresolved one).
    const updated = takes.map(t =>
      t.rowNum === 2 ? { ...t, weight: 0.95 } : t,
    );
    const rendered = renderTakesFence(updated);
    const { takes: after } = parseTakesFence(rendered);
    // Row 1 (resolved) — resolution survives intact.
    expect(after[0].resolvedQuality).toBe('correct');
    expect(after[0].resolvedEvidence).toBe('Series A closed');
    // Row 2 — weight changed, no resolution.
    expect(after[1].weight).toBe(0.95);
    expect(after[1].resolvedQuality).toBeUndefined();
  });

  test('REGRESSION: parsing a v0.28-shape fence (no resolution columns) round-trips byte-identical narrow shape', () => {
    const { takes } = parseTakesFence(SAMPLE_BODY);
    const rendered = renderTakesFence(takes);
    expect(rendered).not.toContain('quality');
    expect(rendered).not.toContain('| resolved |');
    // Re-parse verifies fidelity.
    const { takes: roundTripped } = parseTakesFence(rendered);
    expect(roundTripped).toHaveLength(takes.length);
    for (let i = 0; i < takes.length; i++) {
      expect(roundTripped[i].claim).toBe(takes[i].claim);
      expect(roundTripped[i].weight).toBe(takes[i].weight);
      expect(roundTripped[i].active).toBe(takes[i].active);
    }
  });

  test('partial quality renders + parses correctly (outcome left empty)', () => {
    const { takes } = parseTakesFence(SAMPLE_BODY);
    takes[0] = {
      ...takes[0],
      resolvedAt: '2026-05-01',
      resolvedQuality: 'partial',
      resolvedOutcome: undefined, // partial has no boolean outcome
      resolvedEvidence: 'kind of right',
    };
    const rendered = renderTakesFence(takes);
    expect(rendered).toContain('partial');
    const { takes: roundTripped } = parseTakesFence(rendered);
    expect(roundTripped[0].resolvedQuality).toBe('partial');
    expect(roundTripped[0].resolvedOutcome).toBeUndefined();
  });

  test('upsertTakeRow on a page with resolved rows preserves the resolution + uses wide shape', () => {
    const { body: nextBody, rowNum } = upsertTakeRow(RESOLVED_BODY, {
      claim: 'Brand new bet',
      kind: 'bet',
      holder: 'garry',
      weight: 0.4,
      active: true,
    });
    expect(rowNum).toBe(3);
    const { takes } = parseTakesFence(nextBody);
    expect(takes).toHaveLength(3);
    // Row 1's resolution survived the upsert.
    expect(takes[0].resolvedQuality).toBe('correct');
    expect(takes[0].resolvedEvidence).toBe('Series A closed');
    // New row is unresolved.
    expect(takes[2].resolvedQuality).toBeUndefined();
    // Wide shape was emitted (resolution columns visible).
    expect(nextBody).toContain('quality');
  });

  test('supersedeRow preserves resolution on the row being struck through', () => {
    // Note: superseding a RESOLVED bet would normally throw at the engine
    // layer (TAKE_RESOLVED_IMMUTABLE). The fence-layer supersedeRow doesn't
    // enforce that — it just strikes through. The point of this test is
    // that whatever resolution data lives on the old row survives the strike.
    const { body: nextBody } = supersedeRow(RESOLVED_BODY, 1, {
      claim: 'Updated bet',
      kind: 'bet',
      holder: 'garry',
      weight: 0.5,
    });
    const { takes } = parseTakesFence(nextBody);
    const oldRow = takes.find(t => t.rowNum === 1)!;
    expect(oldRow.active).toBe(false);
    // Resolution data on the old (struck) row preserved.
    expect(oldRow.resolvedQuality).toBe('correct');
    expect(oldRow.resolvedEvidence).toBe('Series A closed');
  });
});
