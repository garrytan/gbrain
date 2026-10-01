/**
 * The outcome table in docs/architecture/decide.md must equal the canonical
 * vocabulary in src/core/ai/decide/outcomes.ts (the database has no CHECK
 * constraint; this test and the TypeScript writer are the enforcement), and
 * docs/guides/system-one.md keeps a troubleshooting anchor for every
 * REFUSAL_CATALOG reason, a row per slot, and shadow confined to its
 * Advanced diagnostics section.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REFUSAL_CATALOG, SLOT_OUTCOMES, SLOT_PLAIN_NAMES } from '../../src/core/ai/decide/outcomes.ts';
import { DECIDE_SLOTS } from '../../src/core/ai/decide/types.ts';

describe('decide docs sync', () => {
  test('architecture outcome table matches SLOT_OUTCOMES and plain names', () => {
    const doc = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'architecture', 'decide.md'), 'utf8');
    const block = doc.split('<!-- decide-outcomes:begin -->')[1]!.split('<!-- decide-outcomes:end -->')[0]!;
    const rows = block.trim().split('\n').slice(2).map((line) => line.split('|').map((c) => c.trim()).filter(Boolean));
    const expected = DECIDE_SLOTS.map((slot) => [slot, SLOT_PLAIN_NAMES[slot], SLOT_OUTCOMES[slot].join(', ')]);
    expect(rows).toEqual(expected);
  });

  test('operator guide has a troubleshooting row for every catalogued refusal anchor', () => {
    const guide = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'guides', 'system-one.md'), 'utf8');
    for (const [reason, entry] of Object.entries(REFUSAL_CATALOG)) {
      expect(entry.anchor).toBe(`#${reason}`);
      expect(guide).toContain(`<a id="${reason}"></a>\`${reason}\``);
    }
    for (const slot of DECIDE_SLOTS) expect(guide).toContain(`| \`${slot}\` | ${SLOT_PLAIN_NAMES[slot]} |`);
  });

  test('operator guide mentions shadow only under Advanced diagnostics (owner decision: on/off)', () => {
    const guide = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'guides', 'system-one.md'), 'utf8');
    const [before, advanced] = guide.split('\n## Advanced diagnostics\n');
    expect(advanced).toBeDefined();
    expect(before!.toLowerCase()).not.toContain('shadow');
    expect(advanced!.includes('\n## ')).toBe(false);
  });
});
