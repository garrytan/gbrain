import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frontmatterEntry } from '../src/commands/doctor/checks/content-quality.ts';
import { frontmatterRepairableFromReport } from '../src/commands/doctor/checks/frontmatter-repairable.ts';
import { finalizeCheckFixes } from '../src/commands/doctor/check-fix.ts';
import { classifyWaveFindings } from '../src/commands/doctor/remediate.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { printAuditHumanReport } from '../src/commands/frontmatter.ts';
import { scanBrainSources, type AuditReport } from '../src/core/brain-writer.ts';
import type { Check } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'missing-root-7889-'));
  mkdirSync(join(root, 'empty'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2),($3,$3,$4)',
    ['ghost', join(root, 'absent'), 'empty', join(root, 'empty')]);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

test('missing registered roots are unverified in both frontmatter doctor checks', async () => {
  const report = await scanBrainSources(engine);
  expect(report.ok).toBe(false);
  expect(report.partial).toBe(true);
  expect(report.aborted_at_source).toBe(null);
  expect(report.per_source.find(source => source.source_id === 'ghost')).toMatchObject({ status: 'missing', files_scanned: 0 });
  expect(report.per_source.find(source => source.source_id === 'empty')).toMatchObject({ status: 'scanned', files_scanned: 0 });

  const checks = await frontmatterEntry.run({ engine, args: [], progress: { heartbeat() {} } } as never) as Array<{ name: string; status: string; message: string }>;
  const integrity = checks.find(check => check.name === 'frontmatter_integrity')!;
  const repairable = checks.find(check => check.name === 'frontmatter_repairable')!;
  for (const check of [integrity, repairable]) {
    expect(check.status).toBe('warn');
    expect(check.message).toContain('missing');
    expect(check.message).toContain('restore');
    expect(check.message).toContain(join(root, 'absent'));
    expect(check.message).not.toContain('timeout');
  }
  expect(integrity.message).toContain('correct the source path');
  expect(repairable.message).toContain('correct the source path');
});

const repairableSpec = WAVE_CHECKS.find(spec => spec.id === 'frontmatter_repairable')!;
const classify = (check: Check) => classifyWaveFindings([], [{ spec: repairableSpec, check, state: 'finding' }], { repairs: [], repairs_skipped: [] })[0]!;

test('a missing root is not a deadline: details, remediation and fix carry no timeout guidance', async () => {
  const checks = await frontmatterEntry.run({ engine, args: [], progress: { heartbeat() {} } } as never) as Check[];
  const integrity = checks.find(check => check.name === 'frontmatter_integrity')!;
  const repairable = checks.find(check => check.name === 'frontmatter_repairable')!;
  for (const check of [integrity, repairable]) {
    expect(check.details?.partial).toBe(false);
    expect(check.details?.missing).toEqual(['ghost']);
    expect(check.details?.health).toBeUndefined();
    expect(check.message).not.toContain('GBRAIN_DOCTOR_FM_TIMEOUT_MS');
    expect(check.message).not.toContain('PARTIAL SCAN');
  }
  const finding = classify(repairable);
  expect(finding.class).toBe('operator_required');
  expect(finding.instruction).toContain('correct the source path');
  expect(finding.instruction).not.toMatch(/deadline|TIMEOUT/);
  const [rendered] = finalizeCheckFixes([repairable]);
  const command = (rendered!.fix as { command?: string } | undefined)?.command ?? '';
  expect(command).not.toContain('repair frontmatter');
  expect(command).toContain('gbrain sources list');
});

test('a real deadline keeps its partial details and timeout remediation', () => {
  const report: AuditReport = { ok: false, total: 0, errors_by_code: {}, aborted_at_source: 'slow', partial: true, scanned_at: new Date(0).toISOString(),
    per_source: [{ source_id: 'slow', source_path: '/x', total: 0, errors_by_code: {}, sample: [], ignoredMissingOpen: 0, status: 'partial', files_scanned: 3 }] } as AuditReport;
  const check = frontmatterRepairableFromReport(report, 30000);
  expect(check.details?.partial).toBe(true);
  expect(check.details?.missing).toBeUndefined();
  expect(check.message).toContain('raise GBRAIN_DOCTOR_FM_TIMEOUT_MS');
  expect(classify(check).instruction).toContain('raise GBRAIN_DOCTOR_FM_TIMEOUT_MS');
});

test('frontmatter audit human output never calls a missing root clean', async () => {
  const report = await scanBrainSources(engine);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { printAuditHumanReport(report); } finally { console.log = log; }
  const out = lines.join('\n');
  const ghost = out.slice(out.indexOf('[ghost]'), out.indexOf('[empty]') > out.indexOf('[ghost]') ? out.indexOf('[empty]') : undefined);
  expect(ghost).toContain('registered directory is missing');
  expect(ghost).toContain('correct the source path');
  expect(ghost).not.toContain('clean');
  expect(out.slice(out.indexOf('[empty]'))).toContain('clean');
});
