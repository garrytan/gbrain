/**
 * Pack-driven extractable-type allowlist (unionExtractableTypes): honors the
 * schema-pack manifest's `extractable: true` flags while preserving the legacy
 * hardcoded floor and excluding synthesis outputs. Closes the D2 TODO in
 * extract-atoms.ts (page discovery was ignoring the pack's extractable flag, so
 * a type declared extractable — e.g. `note` — never actually extracted).
 */
import { describe, test, expect } from 'bun:test';
import { unionExtractableTypes } from '../src/core/cycle/extract-atoms.ts';

const LEGACY = ['meeting', 'source', 'article', 'video', 'book', 'original'];

describe('unionExtractableTypes', () => {
  test('legacy floor is always present (back-compat)', () => {
    const r = unionExtractableTypes([]);
    for (const t of LEGACY) expect(r).toContain(t);
  });

  test('pack-declared extractable types are added (e.g. note)', () => {
    const r = unionExtractableTypes(['note', 'writing']);
    expect(r).toContain('note');
    expect(r).toContain('writing');
    for (const t of LEGACY) expect(r).toContain(t);
  });

  test('synthesis outputs are excluded even when the pack marks them extractable', () => {
    // gbrain-base declares `concept` extractable:true, but extracting atoms FROM
    // concepts would loop (concepts are synthesized from atoms).
    const r = unionExtractableTypes(['note', 'concept', 'atom']);
    expect(r).toContain('note');
    expect(r).not.toContain('concept');
    expect(r).not.toContain('atom');
  });

  test('no duplicates when the pack repeats a legacy type', () => {
    const r = unionExtractableTypes(['meeting', 'source']);
    expect(r.filter((t) => t === 'meeting')).toHaveLength(1);
  });
});
