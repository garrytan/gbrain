import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { beginSourceIngestionReceipt } from '../src/core/company-brain/receipts.ts';
import { readCompanyBrainSourceStatus } from '../src/core/company-brain/status.ts';
import { readCompanyBrainEvidence } from '../src/core/company-brain/evidence.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('company ingestion status', () => {
  test('ordinary sources do not acquire an ingestion status', async () => {
    expect(await readCompanyBrainSourceStatus(engine, 'default')).toBeNull();
    expect(await readCompanyBrainSourceStatus(engine, 'absent')).toBeNull();
    expect(await readCompanyBrainEvidence(engine, 'default')).toEqual({
      ownership: { status: 'not_applicable' }, supersession: { status: 'not_applicable' }, page: null,
    });
  });

  test('reports the source-scoped durable phase without host paths or raw diagnostics', async () => {
    const incarnation = randomUUID();
    const id = randomUUID();
    await engine.executeRaw('INSERT INTO sources(id,name,incarnation,local_path,config) VALUES($1,$1,$2::uuid,$3,$4::text::jsonb)',
      ['company-status', incarnation, '/private/example-checkout', JSON.stringify({ company_brain: { receiptId: id } })]);
    await beginSourceIngestionReceipt(engine, { id, sourceId: 'company-status', sourceIncarnation: incarnation,
      approvedRevision: 'a'.repeat(40), profile: 'company-brain', schemaFingerprint: 'b'.repeat(64), policyFingerprint: 'c'.repeat(64),
      extractorVersion: '2026-09-21T00:00:00Z', fence: { mode: 'unmanaged' } });
    const result = await readCompanyBrainSourceStatus(engine, 'company-status');
    expect(result).toMatchObject({ state: 'incomplete', phase: 'ADMITTED', receipt_id: id });
    expect(JSON.stringify(result)).not.toContain('/private');
    await engine.executeRaw('INSERT INTO sources(id,name,config) VALUES($1,$1,$2::text::jsonb)',
      ['other-status', JSON.stringify({ company_brain: { receiptId: id } })]);
    expect(await readCompanyBrainSourceStatus(engine, 'other-status')).toEqual({ state: 'missing' });
  });

  test('missing pointers and malformed profile state never report successful completion', async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,config) VALUES($1,$1,$2::text::jsonb)',
      ['missing-status', JSON.stringify({ company_brain: {} })]);
    expect(await readCompanyBrainSourceStatus(engine, 'missing-status')).toEqual({ state: 'missing' });
    await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',
      ['missing-status', JSON.stringify({ company_brain: 'invalid' })]);
    expect(await readCompanyBrainSourceStatus(engine, 'missing-status')).toEqual({ state: 'unavailable' });
  });
});
