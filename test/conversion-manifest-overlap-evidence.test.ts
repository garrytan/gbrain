import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APPROVED_BASELINE_SHA = 'a25209bbb2bacf1b88e06fd5282b27f1bf4a3e7a';
const SELECTED_PATHS = [
  'src/core/conversion-manifest.ts',
  'src/schema.sql',
  'src/core/pglite-schema.ts',
  'src/core/schema-embedded.ts',
  'src/core/migrate.ts',
];
const SELECTED_SYMBOLS = [
  'canonicalJson',
  'computeRequestHash',
  'validateCoverage',
  'createConversionManifest',
  'getConversionManifest',
  'listConversionManifests',
  'listConversionMappings',
  'inspectConversionFile',
  'verifyConversionManifestLinkage',
];
const EXCLUDED_OWNERSHIP = [
  'image adapter symbols',
  'global serializer symbols',
  'file-list symbols',
  'uploadRaw',
  'verifyFiles',
  'file_list',
  'listFiles',
  'transport operations',
  'media-ingest documentation',
];
const INSPECTED_REF_IDS = [
  '#2297',
  'PR #2316',
  'PR #472',
  '#2450',
  'PR #2452',
  '#2527',
  'PR #2528',
  'PR #2718',
  '#2706',
  '#1522',
  'PR #1957',
  '#1978',
  '#2683',
  'PR #1449',
];
const TOUCHED_INTERSECTION_REF_IDS = INSPECTED_REF_IDS;
const EXPECTED_HEAD_SHAS = {
  'PR #2316': '0bc3cfb703040a34a5e86adaaa5247a38c1163ab',
  'PR #472': '4c571687e994f1fc48bcfe0da56fc0c76ccea80f',
  'PR #2452': '12df2d5e37efcc3e87bc344d4cab589a4aedd7b8',
  'PR #2528': '6256991cfaa89449c83cbea2d64d058ff434ceae',
  'PR #2718': 'd28b784d0f4e5e38f3eada5e6d0dbfe78a88588d',
  'PR #1957': '19646c06f4e63e81740a8ec1d9bbc069eac9896a14',
} as const;
type Receipt = {
  schema_version: '1';
  baseline_sha: string;
  inspected_refs: Array<{ ref: string }>;
  head_shas: Record<string, string>;
  touched_intersections: Array<{ ref: string }>;
  zero_overlap: false;
  verdict: 'overlap_requires_decomposition';
  selected_scope: { paths: string[]; symbols: string[] };
  exclusions: string[];
  decomposition: { selected_first_pr: 'conversion_evidence_data_foundation'; selected_scope_zero_overlap: true };
  sha256?: string;
  [key: string]: unknown;
};
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const canonical = (value: unknown, topLevel = true): string => {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, false)).join(',')}]`;
  if (isRecord(value)) return `{${Object.entries(value).filter(([key]) => !(topLevel && key === 'sha256')).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, false)}`).join(',')}}`;
  return JSON.stringify(value);
};
const parseReceipt = (value: unknown): Receipt => {
  if (!isRecord(value) || value.schema_version !== '1' || value.baseline_sha !== APPROVED_BASELINE_SHA || !Array.isArray(value.inspected_refs) || !isRecord(value.head_shas) || !Array.isArray(value.touched_intersections) || value.zero_overlap !== false || value.verdict !== 'overlap_requires_decomposition' || !isRecord(value.selected_scope) || !isRecord(value.decomposition) || !isStringArray(value.exclusions)) throw new Error('invalid Stage-1 overlap receipt');
  if (!value.inspected_refs.every((entry) => isRecord(entry) && typeof entry.ref === 'string') || !value.touched_intersections.every((entry) => isRecord(entry) && typeof entry.ref === 'string')) throw new Error('invalid Stage-1 reference arrays');
  if (!isStringArray(value.selected_scope.paths) || !isStringArray(value.selected_scope.symbols) || value.decomposition.selected_scope_zero_overlap !== true || value.decomposition.selected_first_pr !== 'conversion_evidence_data_foundation') throw new Error('invalid Stage-1 selected scope');
  if (JSON.stringify(value.inspected_refs.map((entry) => (entry as { ref: string }).ref)) !== JSON.stringify(INSPECTED_REF_IDS) || JSON.stringify(value.touched_intersections.map((entry) => (entry as { ref: string }).ref)) !== JSON.stringify(TOUCHED_INTERSECTION_REF_IDS)) throw new Error('invalid Stage-1 reference arrays');
  if (JSON.stringify(value.head_shas) !== JSON.stringify(EXPECTED_HEAD_SHAS) || value.sha256 !== undefined && !isSha(value.sha256)) throw new Error('invalid Stage-1 heads or SHA');
  const selectedScope = value.selected_scope as { paths: string[]; symbols: string[] };
  if (JSON.stringify(selectedScope.paths) !== JSON.stringify(SELECTED_PATHS) || JSON.stringify(selectedScope.symbols) !== JSON.stringify(SELECTED_SYMBOLS) || JSON.stringify(value.exclusions) !== JSON.stringify(EXCLUDED_OWNERSHIP)) throw new Error('invalid Stage-1 selected scope or ownership');
  return { ...value, selected_scope: selectedScope } as Receipt;
};
const syntheticFixtureReceipt: Receipt = { schema_version: '1', baseline_sha: APPROVED_BASELINE_SHA, inspected_refs: INSPECTED_REF_IDS.map((ref) => ({ ref })), head_shas: { ...EXPECTED_HEAD_SHAS }, touched_intersections: TOUCHED_INTERSECTION_REF_IDS.map((ref) => ({ ref })), zero_overlap: false, verdict: 'overlap_requires_decomposition', selected_scope: { paths: SELECTED_PATHS, symbols: SELECTED_SYMBOLS }, exclusions: EXCLUDED_OWNERSHIP, decomposition: { selected_first_pr: 'conversion_evidence_data_foundation', selected_scope_zero_overlap: true } };
const liveEvidencePath = process.env.CONVERSION_MANIFEST_OVERLAP_EVIDENCE;
const hasLiveEvidencePath = typeof liveEvidencePath === 'string' && liveEvidencePath.length > 0 && existsSync(resolve(liveEvidencePath));
const certificationMode = process.env.CONVERSION_MANIFEST_CERTIFICATION === '1';

function loadLiveReceipt(): Receipt {
  if (!hasLiveEvidencePath) throw new Error('Stage-1 live evidence path is not available');
  return parseReceipt(JSON.parse(readFileSync(resolve(liveEvidencePath!), 'utf8')) as unknown);
}

describe('conversion manifest Stage-1 overlap evidence', () => {
  test.skipIf(!hasLiveEvidencePath && !certificationMode)('validates the live narrowed-scope decomposition, references, heads, and SHA', () => {
    const value = loadLiveReceipt();
    expect(value.zero_overlap).toBe(false);
    expect(value.verdict).toBe('overlap_requires_decomposition');
    expect(value.decomposition.selected_scope_zero_overlap).toBe(true);
    expect(value.decomposition.selected_first_pr).toBe('conversion_evidence_data_foundation');
    expect(value.selected_scope.paths).toEqual(SELECTED_PATHS);
    expect(value.selected_scope.symbols).toEqual(SELECTED_SYMBOLS);
    expect(value.inspected_refs.map(({ ref }) => ref)).toEqual(INSPECTED_REF_IDS);
    expect(value.touched_intersections.map(({ ref }) => ref)).toEqual(TOUCHED_INTERSECTION_REF_IDS);
    expect(value.head_shas).toEqual(EXPECTED_HEAD_SHAS);
    expect(value.exclusions).toEqual(EXCLUDED_OWNERSHIP);
    expect(value.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(value.sha256).toBe(createHash('sha256').update(canonical(value)).digest('hex'));
  });
  test('synthetic fixture preserves exact selected scope and excluded ownership', () => {
    const value = parseReceipt(syntheticFixtureReceipt);
    expect(value.selected_scope.paths).toEqual(SELECTED_PATHS);
    expect(value.selected_scope.symbols).toEqual(SELECTED_SYMBOLS);
    expect(value.exclusions).toEqual(EXCLUDED_OWNERSHIP);
    expect(value.zero_overlap).toBe(false);
    const signed = { ...value, sha256: createHash('sha256').update(canonical(value)).digest('hex') };
    expect(signed.sha256).toBe(createHash('sha256').update(canonical(signed)).digest('hex'));
  });
});
