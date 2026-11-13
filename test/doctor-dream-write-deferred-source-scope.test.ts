/**
 * W3 x W4 (Train B review): dream_write_deferred lists source ids, request ids and status commands, so a
 * source-bound run_doctor caller (the ops tier and the alert tier's page-class `only`) must see only its own
 * sources' deferrals, as parked_effects does.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runRemoteDoctorTier } from '../src/commands/doctor/remote-tier.ts';
import { DREAM_WRITE_DEFERRALS_KEY } from '../src/core/cycle/dream-write-deferral.ts';

let engine: PGLiteEngine;
const ACME_REQ = '11111111-1111-4111-8111-111111111111';
const FUND_REQ = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('acme-a','acme-a'),('fund-b','fund-b') ON CONFLICT DO NOTHING");
  const entry = (source: string, request: string) => ({ phase: 'purge', source_id: source, subject: source + '/notes/x', request_id: request,
    receipt_id: null, replays: 3, deferred_at: '2026-11-13T00:00:00.000Z' });
  await engine.setConfig(DREAM_WRITE_DEFERRALS_KEY, JSON.stringify({ 'purge:acme-a': entry('acme-a', ACME_REQ), 'purge:fund-b': entry('fund-b', FUND_REQ) }));
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

const ctx = (sourceId: string): OperationContext => ({ engine, remote: true, transport: 'http', sourceId, config: {} as never,
  logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext);

for (const only of [['dream_write_deferred'], ['dream_write_deferred', 'jsonb_integrity']]) {
  test(`a source-bound run_doctor only=${only.join(',')} sees its own deferrals and none of another source's`, async () => {
    const report = await runRemoteDoctorTier(ctx('acme-a'), { only });
    const text = JSON.stringify(report);
    expect(text).toContain(ACME_REQ);
    expect(text).not.toContain(FUND_REQ);
    expect(text).not.toContain('fund-b');
  }, 60_000);
}
