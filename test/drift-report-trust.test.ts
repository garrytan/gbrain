/**
 * The drift report page (`reports/drift-<date>`) declares its derivation.
 *
 * Protects: the dream drift phase writes its report through publishSinglePage with the derivation of the pages whose takes it
 * judged (channel `derive:drift`, tier = min(agent_written, least trusted judged page), like the dream summary), so the page
 * is stored with a write_origin and a tier instead of `unknown` with no origin, which every page derived from it would
 * inherit. Fails if the report is written without a derivation again. Runs on PGLite.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseDrift } from '../src/core/cycle/drift.ts';
import { withWriteTrust } from '../src/core/persistence/context.ts';
import type { WriteTrust } from '../src/core/trust/tier.ts';

let engine: PGLiteEngine;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'drift-report-trust-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [k, v] of Object.entries({ 'dream.drift.enabled': 'true', 'dream.drift.lookback_days': '30', 'dream.drift.budget': '1.0',
    'models.drift': 'anthropic:claude-sonnet-4-6' })) await engine.setConfig(k, v);
}, 120_000);
afterAll(async () => {
  try { await engine.disconnect(); } finally { rmSync(tmpDir, { recursive: true, force: true }); }
});

async function seed(slug: string, trust: WriteTrust): Promise<void> {
  const page = await engine.transaction(tx => withWriteTrust(tx, trust, () => tx.putPage(slug, { title: slug, type: 'person', compiled_truth: 'Content' })));
  await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: `Claim about ${slug}`, kind: 'take', holder: 'world', weight: 0.6 }]);
  await engine.addTimelineEntriesBatch([{ slug, date: new Date().toISOString().slice(0, 10), source: 'meeting', summary: `Update for ${slug}` }]);
}

async function reportRow(): Promise<{ trust_tier: string; write_origin: { channel?: string; taint_inputs?: unknown[] } | null }> {
  const [row] = await engine.executeRaw<{ trust_tier: string; write_origin: { channel?: string; taint_inputs?: unknown[] } | null }>(
    `SELECT trust_tier, write_origin FROM pages WHERE slug LIKE 'reports/drift-%' AND deleted_at IS NULL`);
  return row!;
}

describe('drift report trust', () => {
  test('the report carries the derive:drift origin and a derived tier, not unknown/legacy', async () => {
    await seed('people/trust-ok-example', { tier: 'operator_curated', origin: { channel: 'test:seed' } });
    const result = await runPhaseDrift(engine, { dryRun: false, auditPath: join(tmpDir, 'd1.jsonl'),
      judge: async () => ({ drifted: true, confidence: 0.9, reasoning: 'moved', suggested_weight: 0.3 }) });
    expect(result.status).toBe('complete');
    const row = await reportRow();
    expect(row.write_origin?.channel).toBe('derive:drift');
    expect(row.trust_tier).toBe('agent_written'); // capped at agent_written; an owner-tier input does not raise it
    expect(row.write_origin?.taint_inputs?.length).toBe(1);
  }, 120_000);

  test('the report takes the least trusted judged page as its tier', async () => {
    await seed('people/trust-low-example', { tier: 'external_untrusted', origin: { channel: 'test:seed' } });
    const result = await runPhaseDrift(engine, { dryRun: false, auditPath: join(tmpDir, 'd2.jsonl'),
      judge: async () => ({ drifted: true, confidence: 0.9, reasoning: 'moved again', suggested_weight: 0.3 }) });
    expect(result.status).toBe('complete');
    const row = await reportRow();
    expect(row.write_origin?.channel).toBe('derive:drift');
    expect(row.trust_tier).toBe('external_untrusted');
  }, 120_000);
});
