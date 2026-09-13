/**
 * evals/longmemeval/splits-seed42.json + dev-slice-seed42.txt — integrity of
 * the committed, seeded LongMemEval question-id splits (ids only; the file
 * never carries question text or session content).
 *
 * Every pre-registered decision rule reads these lists, so a drifted split
 * (an id in both halves, a dev id leaking into the decision set, an
 * abstention `_abs` id, or a dev-slice txt that no longer equals dev40) would
 * silently corrupt the receipts. Pure file pins — no engine, no network.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SPLITS_PATH = join(ROOT, 'evals', 'longmemeval', 'splits-seed42.json');
const DEV_SLICE_PATH = join(ROOT, 'evals', 'longmemeval', 'dev-slice-seed42.txt');

interface Splits {
  schema_version: number;
  dataset_sha256: string;
  scored: number;
  abstention_excluded: number;
  seeds: { dev: number; halves470: number; halves430: number };
  type_counts: Record<string, number>;
  dev40_type_counts: Record<string, number>;
  dev40: string[];
  decision430: string[];
  halfA470: string[];
  halfB470: string[];
  halfA430: string[];
  halfB430: string[];
}

const splits = JSON.parse(readFileSync(SPLITS_PATH, 'utf-8')) as Splits;
const LISTS = ['dev40', 'decision430', 'halfA470', 'halfB470', 'halfA430', 'halfB430'] as const;

function isPartition(a: string[], b: string[], whole: Set<string>): boolean {
  const union = new Set([...a, ...b]);
  if (union.size !== whole.size || a.length + b.length !== whole.size) return false;
  for (const id of union) if (!whole.has(id)) return false;
  return true;
}

describe('evals/longmemeval/splits-seed42.json', () => {
  test('schema + provenance fields', () => {
    expect(splits.schema_version).toBe(1);
    expect(splits.dataset_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(splits.scored).toBe(470);
    expect(splits.abstention_excluded).toBe(30);
    expect(splits.seeds).toEqual({ dev: 42, halves470: 4242, halves430: 4243 });
  });

  test('every list is unique string ids, no abstention (_abs) id anywhere', () => {
    for (const name of LISTS) {
      const list = splits[name];
      expect(Array.isArray(list), name).toBe(true);
      expect(new Set(list).size, `${name} has duplicates`).toBe(list.length);
      for (const id of list) {
        expect(typeof id, name).toBe('string');
        expect(id.length, name).toBeGreaterThan(0);
        expect(id.endsWith('_abs'), `${name}: ${id}`).toBe(false);
      }
    }
  });

  test('dev40 ∩ decision430 = ∅ and dev40 ∪ decision430 = the 470 scored ids', () => {
    expect(splits.dev40.length).toBe(40);
    expect(splits.decision430.length).toBe(430);
    const dev = new Set(splits.dev40);
    for (const id of splits.decision430) expect(dev.has(id), `dev id leaked into decision430: ${id}`).toBe(false);
    const all = new Set([...splits.dev40, ...splits.decision430]);
    expect(all.size).toBe(splits.scored);
  });

  test('halfA470 / halfB470 partition the 470; halfA430 / halfB430 partition decision430', () => {
    const all470 = new Set([...splits.dev40, ...splits.decision430]);
    expect(splits.halfA470.length).toBe(235);
    expect(splits.halfB470.length).toBe(235);
    expect(isPartition(splits.halfA470, splits.halfB470, all470)).toBe(true);
    const decision = new Set(splits.decision430);
    expect(splits.halfA430.length).toBe(215);
    expect(splits.halfB430.length).toBe(215);
    expect(isPartition(splits.halfA430, splits.halfB430, decision)).toBe(true);
    // The 430-halves never touch the dev slice.
    const dev = new Set(splits.dev40);
    for (const id of [...splits.halfA430, ...splits.halfB430]) expect(dev.has(id), id).toBe(false);
  });

  test('type_counts sum to 470 and dev40_type_counts sum to 40 over the same type set', () => {
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(splits.type_counts)).toBe(470);
    expect(sum(splits.dev40_type_counts)).toBe(40);
    expect(Object.keys(splits.dev40_type_counts).sort()).toEqual(Object.keys(splits.type_counts).sort());
    for (const [t, n] of Object.entries(splits.dev40_type_counts)) expect(n, t).toBeLessThanOrEqual(splits.type_counts[t]);
  });

  test('dev-slice-seed42.txt equals dev40 as a set (one id per line, for --question-ids)', () => {
    const lines = readFileSync(DEV_SLICE_PATH, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(40);
    expect(new Set(lines).size).toBe(40);
    expect([...new Set(lines)].sort()).toEqual([...splits.dev40].sort());
  });
});
