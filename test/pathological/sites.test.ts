/**
 * GBRA-130 ratchet: every per-item site registered in ISOLATE_SITES has a
 * pathological item case and a run-scoped case in the file the catalogue names,
 * and every site names an inventory row.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISOLATE_SITES } from '../../src/core/item-failure.ts';
import { CATALOGUE, type SiteCases } from './catalogue.ts';

const ROOT = join(import.meta.dir, '..', '..');

describe('pathological catalogue covers every isolate site', () => {
  for (const [site, row] of Object.entries(ISOLATE_SITES)) {
    test(`${site} (${row})`, () => {
      expect(row).toMatch(/^[ABC]-\d+$/);
      const cases = (CATALOGUE as Record<string, SiteCases | undefined>)[site]!;
      expect(cases).toBeDefined();
      const path = join(ROOT, cases.file);
      expect({ file: cases.file, exists: existsSync(path) }).toEqual({ file: cases.file, exists: true });
      const text = readFileSync(path, 'utf8');
      expect({ site, item: text.includes(cases.item) }).toEqual({ site, item: true });
      expect({ site, run: text.includes(cases.run) }).toEqual({ site, run: true });
      expect(cases.item).not.toBe(cases.run);
    });
  }

  test('isolateItem call sites use a registered literal site', () => {
    expect(Object.keys(CATALOGUE).sort()).toEqual(Object.keys(ISOLATE_SITES).sort());
  });
});
