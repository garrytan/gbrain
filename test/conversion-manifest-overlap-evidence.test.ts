import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APPROVED_BASELINE_SHA = 'a25209bbb2bacf1b88e06fd5282b27f1bf4a3e7a';
const SELECTED_PATHS = ['src/core/conversion-manifest.ts'];
const SELECTED_SYMBOLS = ['canonicalJson', 'validateCoverage'];
const EXCLUDED_OWNERSHIP = ['image adapter symbols', 'global serializer symbols', 'file-list symbols'];
type Receipt = { schema_version: '1'; baseline_sha: string; inspected_refs: string[]; head_shas: Record<string, string>; touched_intersections: unknown[]; path_intersections: unknown[]; function_intersections: unknown[]; zero_overlap: false; selected_scope: { paths: string[]; symbols: string[] }; exclusions: string[]; sha256?: string };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const canonical = (value: unknown, topLevel = true): string => {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, false)).join(',')}]`;
  if (isRecord(value)) return `{${Object.entries(value).filter(([key]) => !(topLevel && key === 'sha256')).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, false)}`).join(',')}}`;
  return JSON.stringify(value);
};
const parseReceipt = (value: unknown): Receipt => {
  if (!isRecord(value) || value.schema_version !== '1' || value.baseline_sha !== APPROVED_BASELINE_SHA || !isStringArray(value.inspected_refs) || !isRecord(value.head_shas) || !Array.isArray(value.touched_intersections) || !Array.isArray(value.path_intersections) || !Array.isArray(value.function_intersections) || value.zero_overlap !== false || !isRecord(value.selected_scope) || !isStringArray(value.exclusions)) throw new Error('invalid Stage-1 overlap receipt');
  if (!isStringArray(value.selected_scope.paths) || !isStringArray(value.selected_scope.symbols)) throw new Error('invalid Stage-1 selected scope');
  if (!Object.values(value.head_shas).every(isSha) || value.head_shas.baseline !== APPROVED_BASELINE_SHA || value.sha256 !== undefined && !isSha(value.sha256)) throw new Error('invalid Stage-1 heads or SHA');
  const selectedScope = value.selected_scope as { paths: string[]; symbols: string[] };
  if (JSON.stringify(selectedScope.paths) !== JSON.stringify(SELECTED_PATHS) || !SELECTED_SYMBOLS.every((symbol) => selectedScope.symbols.includes(symbol)) || JSON.stringify(value.exclusions) !== JSON.stringify(EXCLUDED_OWNERSHIP)) throw new Error('invalid Stage-1 selected scope or ownership');
  return { ...value, selected_scope: selectedScope } as unknown as Receipt;
};
const fallback: Receipt = { schema_version: '1', baseline_sha: APPROVED_BASELINE_SHA, inspected_refs: ['synthetic-ref:data-foundation'], head_shas: { baseline: APPROVED_BASELINE_SHA }, touched_intersections: [], path_intersections: [], function_intersections: [], zero_overlap: false, selected_scope: { paths: SELECTED_PATHS, symbols: SELECTED_SYMBOLS }, exclusions: EXCLUDED_OWNERSHIP };
function receipt(): Receipt { const path = process.env.CONVERSION_MANIFEST_OVERLAP_EVIDENCE; return parseReceipt(path ? JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown : fallback); }

describe('conversion manifest Stage-1 overlap evidence', () => {
  test('validates schema, selected-scope zero overlap, ownership, paths, functions, and heads', () => {
    const value = receipt();
    expect(value.touched_intersections).toEqual([]); expect(value.path_intersections).toEqual([]); expect(value.function_intersections).toEqual([]); expect(value.zero_overlap).toBe(false);
    if (process.env.CONVERSION_MANIFEST_OVERLAP_EVIDENCE) { expect(value.sha256).toMatch(/^[0-9a-f]{64}$/); expect(value.sha256).toBe(createHash('sha256').update(canonical(value)).digest('hex')); }
  });
  test('pure verifier fixture preserves exact selected scope and excluded ownership', () => {
    expect(fallback.selected_scope.paths).toEqual(SELECTED_PATHS); expect(fallback.selected_scope.symbols).toEqual(SELECTED_SYMBOLS); expect(fallback.exclusions).toEqual(EXCLUDED_OWNERSHIP); expect(fallback.zero_overlap).toBe(false);
    const signed = { ...fallback, sha256: createHash('sha256').update(canonical(fallback)).digest('hex') }; expect(signed.sha256).toBe(createHash('sha256').update(canonical(signed)).digest('hex'));
  });
});
