import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APPROVED_BASELINE_SHA = 'a25209bbb2bacf1b88e06fd5282b27f1bf4a3e7a';
const DDL_VARIANTS = ['native', 'pglite_split'] as const;
type DdlVariant = (typeof DDL_VARIANTS)[number];
type Probe = { command: string; exit_code: number; ddl_variant: DdlVariant; passed: true };
type Receipt = { schema_version: '1'; baseline_sha: string; postgres: Probe; pglite: Probe; selected_ddl_variant: DdlVariant; created_at: string; sha256?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
const isVariant = (value: unknown): value is DdlVariant => typeof value === 'string' && (DDL_VARIANTS as readonly string[]).includes(value);
const canonical = (value: unknown, topLevel = true): string => {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, false)).join(',')}]`;
  if (isRecord(value)) return `{${Object.entries(value).filter(([key]) => !(topLevel && key === 'sha256')).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, false)}`).join(',')}}`;
  return JSON.stringify(value);
};
const parseProbe = (value: unknown): Probe => {
  if (!isRecord(value) || typeof value.command !== 'string' || value.exit_code !== 0 || value.passed !== true || !isVariant(value.ddl_variant)) throw new Error('invalid Stage-0 probe');
  return { command: value.command, exit_code: 0, ddl_variant: value.ddl_variant, passed: true };
};
const parseReceipt = (value: unknown): Receipt => {
  if (!isRecord(value) || value.schema_version !== '1' || typeof value.baseline_sha !== 'string' || !isSha(value.baseline_sha) || typeof value.created_at !== 'string' || !isVariant(value.selected_ddl_variant)) throw new Error('invalid Stage-0 receipt');
  const postgres = parseProbe(value.postgres);
  const pglite = parseProbe(value.pglite);
  if (value.sha256 !== undefined && !isSha(value.sha256)) throw new Error('invalid Stage-0 sha256');
  const sha256: string | undefined = value.sha256 === undefined ? undefined : String(value.sha256);
  return { schema_version: '1', baseline_sha: value.baseline_sha, postgres, pglite, selected_ddl_variant: value.selected_ddl_variant, created_at: value.created_at, ...(sha256 === undefined ? {} : { sha256 }) };
};

const fixtureReceipt: Receipt = { schema_version: '1', baseline_sha: APPROVED_BASELINE_SHA, postgres: { command: 'synthetic postgres probe', exit_code: 0, ddl_variant: 'native', passed: true }, pglite: { command: 'synthetic pglite probe', exit_code: 0, ddl_variant: 'native', passed: true }, selected_ddl_variant: 'native', created_at: '2026-01-01T00:00:00.000Z' };
const liveEvidencePath = process.env.CONVERSION_MANIFEST_COMPAT_EVIDENCE;
const hasLiveEvidencePath = typeof liveEvidencePath === 'string' && liveEvidencePath.length > 0 && existsSync(resolve(liveEvidencePath));
const certificationMode = process.env.CONVERSION_MANIFEST_CERTIFICATION === '1';

function loadLiveReceipt(): Receipt {
  if (!hasLiveEvidencePath) throw new Error('Stage-0 live evidence path is not available');
  return parseReceipt(JSON.parse(readFileSync(resolve(liveEvidencePath!), 'utf8')) as unknown);
}

describe('conversion manifest Stage-0 compatibility evidence', () => {
  test.skipIf(!hasLiveEvidencePath && !certificationMode)('validates the live receipt schema and recomputable SHA from explicit evidence', () => {
    const value = loadLiveReceipt();
    expect(value.baseline_sha).toBe(APPROVED_BASELINE_SHA);
    for (const variant of ['postgres', 'pglite'] as const) { expect(value[variant].command).toEqual(expect.any(String)); expect(value[variant].exit_code).toBe(0); expect(value[variant].passed).toBe(true); }
    expect(value.pglite.ddl_variant).toBe(value.selected_ddl_variant);
    expect(value.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(value.sha256).toBe(createHash('sha256').update(canonical(value)).digest('hex'));
  });
  test('pure verifier fixture proves the canonical hash excludes only top-level sha256', () => {
    const value = parseReceipt(fixtureReceipt);
    const signed = { ...value, sha256: createHash('sha256').update(canonical(value)).digest('hex') };
    expect(signed.sha256).toBe(createHash('sha256').update(canonical(signed)).digest('hex'));
    expect(createHash('sha256').update(canonical({ ...value, created_at: '2026-01-02T00:00:00.000Z' })).digest('hex')).not.toBe(signed.sha256);
  });
});
