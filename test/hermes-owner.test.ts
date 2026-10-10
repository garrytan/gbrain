import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDelegatedHermesMaintenance, getDelegatedHermesMaintenanceStatus, shutdownDelegatedHermesMaintenance,
  type HermesRunnerDependencies } from '../src/core/serve-hermes-runner.ts';
import { validateDelegatedHermesOptions, hermesReportForWire } from '../src/core/context/hermes-ipc.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { HermesMaintenanceReport } from '../src/core/hermes-maintenance.ts';
import { maintenanceJsonReceipt } from '../src/cli/commands/hermes.ts';

const registration = { id: 'synthetic-cli', credential: 'synthetic-credential', lane: 'cli' as const };
function fixture() {
  const engine = {} as BrainEngine;
  const calls: any[] = [];
  const writer = { remote: false, principal: { id: 'synthetic-cli', kind: 'local_cli' },
    grant: { scopes: ['read', 'write'], sourceIds: ['example'], operations: null, slugPrefixes: null } };
  const report = { schema_version: 1, status: 'ok', source_id: 'example', duration_ms: 1,
    ingest: null, cycle: null, validation: { checked: 0, missing: [] }, reasons: [] } as HermesMaintenanceReport;
  const dependencies: HermesRunnerDependencies = {
    verify: async (eng, reg, task) => { assert.equal(eng, engine); assert.equal(reg, registration); await task(writer as any); },
    context: (eng, sourceId) => ({ engine: eng, sourceId, remote: false } as any),
    run: async (eng, options) => { calls.push({ eng, options }); return report; },
  };
  return { engine, calls, writer, report, dependencies, options: { stateDb: '/synthetic/state.db', sourceId: 'example' } };
}

test('live owner uses its existing engine and trusted context, and lost start ack attaches once', async () => {
  const f = fixture();
  const first = await startDelegatedHermesMaintenance(f.engine, f.options, 'intent', registration, 'example', f.dependencies);
  const retry = await startDelegatedHermesMaintenance(f.engine, f.options, 'intent', registration, 'example', f.dependencies);
  assert.equal(first.ok, true); assert.equal(retry.jobId, first.jobId);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].eng, f.engine); assert.equal(f.calls[0].options.context.engine, f.engine);
  assert.equal(f.calls[0].options.context.remote, false);
  assert.equal(f.calls[0].options.sourceId, 'example');
  const next = await startDelegatedHermesMaintenance(f.engine, f.options, 'next-intent', registration, 'example', f.dependencies);
  assert.equal(next.ok, true); assert.equal(f.calls.length, 2);
  const lateRetry = await startDelegatedHermesMaintenance(f.engine, f.options, 'intent', registration, 'example', f.dependencies);
  assert.equal(lateRetry.jobId, first.jobId); assert.equal(f.calls.length, 2);
  assert.equal(getDelegatedHermesMaintenanceStatus(f.engine, first.jobId!, 'example').state, 'done');
  const changed = await startDelegatedHermesMaintenance(f.engine, { ...f.options, limit: 2 }, 'intent', registration, 'example', f.dependencies);
  assert.equal(changed.error, 'token_options_mismatch');
  await shutdownDelegatedHermesMaintenance(f.engine);
});

test('remote, source-limited, operation-limited and revoked identities start no import', async () => {
  for (const kind of ['remote', 'source', 'operation', 'revoked']) {
    const f = fixture();
    if (kind === 'remote') f.writer.remote = true;
    if (kind === 'source') f.writer.grant.sourceIds = ['elsewhere'];
    if (kind === 'operation') (f.writer.grant as any).operations = ['remember'];
    if (kind === 'revoked') f.dependencies.verify = async () => { throw new Error('revoked'); };
    const result = await startDelegatedHermesMaintenance(f.engine, f.options, 'intent', registration, 'example', f.dependencies);
    assert.equal(result.error, 'permission_denied', kind); assert.equal(f.calls.length, 0, kind);
    await shutdownDelegatedHermesMaintenance(f.engine);
  }
  const f = fixture();
  const wrongSource = await startDelegatedHermesMaintenance(f.engine, { ...f.options, sourceId: 'elsewhere' }, 'intent', registration, 'example', f.dependencies);
  assert.equal(wrongSource.error, 'source_mismatch'); assert.equal(f.calls.length, 0);
  const brainwide = await startDelegatedHermesMaintenance(f.engine, { ...f.options, enrich: true }, 'wide', registration, 'example', f.dependencies);
  assert.equal(brainwide.error, 'permission_denied'); assert.equal(f.calls.length, 0);
  await shutdownDelegatedHermesMaintenance(f.engine);
});

test('shutdown aborts and awaits owner work before its engine can disconnect', async () => {
  const f = fixture();
  let settled = false;
  f.dependencies.run = async (_engine, options) => {
    await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
    settled = true; return { ...f.report, status: 'partial', reasons: ['aborted'] };
  };
  const start = await startDelegatedHermesMaintenance(f.engine, f.options, 'intent', registration, 'example', f.dependencies);
  assert.equal(getDelegatedHermesMaintenanceStatus(f.engine, start.jobId!, 'example').state, 'running');
  await shutdownDelegatedHermesMaintenance(f.engine);
  assert.equal(settled, true);
  assert.equal((await startDelegatedHermesMaintenance(f.engine, f.options, 'next', registration, 'example', f.dependencies)).error, 'shutting_down');
});

test('a grant narrowed between admission and execution never runs with the old authority', async () => {
  const f = fixture();
  let checks = 0;
  f.dependencies.verify = async (_engine, _registration, task) => {
    await task({ ...f.writer, grant: { ...f.writer.grant,
      scopes: ++checks === 1 ? ['read', 'write'] : ['read'] } } as any);
  };
  const start = await startDelegatedHermesMaintenance(f.engine, f.options, 'intent', registration, 'example', f.dependencies);
  assert.equal(start.ok, true);
  await new Promise(resolve => setImmediate(resolve));
  const status = getDelegatedHermesMaintenanceStatus(f.engine, start.jobId!, 'example');
  assert.equal(status.state, 'error'); assert.equal(status.jobError, 'permission_denied');
  assert.equal(f.calls.length, 0);
  await shutdownDelegatedHermesMaintenance(f.engine);
});

test('retained intent capacity refuses new work without evicting an initiating receipt', async () => {
  const f = fixture();
  let first: string | undefined;
  for (let index = 0; index < 20; index++) {
    const start = await startDelegatedHermesMaintenance(f.engine, f.options, `intent-${index}`, registration, 'example', f.dependencies);
    assert.equal(start.ok, true);
    first ??= start.jobId;
    await new Promise(resolve => setImmediate(resolve));
  }
  const full = await startDelegatedHermesMaintenance(f.engine, f.options, 'overflow', registration, 'example', f.dependencies);
  assert.equal(full.error, 'retained_jobs_full'); assert.equal(f.calls.length, 20);
  const retry = await startDelegatedHermesMaintenance(f.engine, f.options, 'intent-0', registration, 'example', f.dependencies);
  assert.equal(retry.jobId, first); assert.equal(f.calls.length, 20);
  assert.equal(getDelegatedHermesMaintenanceStatus(f.engine, first!, 'example').state, 'done');
  await shutdownDelegatedHermesMaintenance(f.engine);
});

test('wire input rejects path, source and paid-work widening; receipt retains omission counts', () => {
  for (const options of [{ stateDb: 'relative.db' }, { stateDb: '/a', sourceId: '../other' },
    { stateDb: '/a', remote: false }, { stateDb: '/a', enrich: 'true' }, { stateDb: '/a', windowSeconds: 3601 }]) {
    assert.equal(validateDelegatedHermesOptions(options).ok, false);
  }
  const f = fixture();
  const report = hermesReportForWire({ ...f.report, ingest: { files: [{ path: '/synthetic/private-store' }], slugsTouched: Array(120).fill('example'),
    sessionsImported: 120, sessionsSeen: 120 } as any, validation: { checked: 120, missing: Array(110).fill('missing') } });
  assert.equal(report.ingest!.sessionsImported, 120); assert.equal(report.validation.checked, 120);
  assert.deepEqual(report.wire_omitted, { files: 1, touched_slugs: 20, missing_slugs: 10, cycle_detail_fields: 0 });
  assert.equal(report.ingest!.files.length, 0);
  const cycle = hermesReportForWire({ ...f.report, cycle: { status: 'partial', phases: [{ phase: 'synthesize', status: 'warn',
    duration_ms: 1, summary: 'budget reached', details: { pages_written: 2, verdicts: Array(10000).fill('private-text') } }] } as any });
  assert.equal(cycle.cycle!.status, 'partial'); assert.equal(cycle.cycle!.phases[0].details.pages_written, 2);
  assert.equal(cycle.wire_omitted.cycle_detail_fields, 1);
  assert.ok(JSON.stringify(cycle).length < 4096);
});

test('lock receipts bound identifiers without truncating or hiding omission counts', () => {
  const f = fixture();
  const ids = ['gbrain-sync:' + 'x'.repeat(300_000), ...Array.from({ length: 500 }, (_, i) => `gbrain-sync:source-${i}`)];
  const report = hermesReportForWire({ ...f.report, lock_reap: { reaped: ids.length, reapedIds: ids } });
  assert.equal(report.lock_reap!.reaped, 501);
  assert.equal(report.lock_reap!.reapedIds.length, 100);
  assert.deepEqual(report.lock_reap!.reapedIds, ids.slice(1, 101));
  assert.equal(report.wire_omitted.reaped_lock_ids, 401);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 16_384);
  assert.equal(ids[0].length, 300_012, 'wire projection must not mutate the original receipt');
});

test('non-success CLI JSON carries a D5 failure envelope without discarding progress', () => {
  const f = fixture();
  for (const status of ['partial', 'failed'] as const) {
    const receipt = JSON.parse(JSON.stringify(maintenanceJsonReceipt({ ...f.report, status,
      validation: { checked: 7, missing: ['conversation/example'] }, reasons: ['imported_pages_missing'] })));
    assert.equal(typeof receipt.code, 'string'); assert.equal(typeof receipt.suggestion, 'string');
    assert.equal(receipt.contract_version, 1); assert.equal(receipt.status, status);
    assert.equal(receipt.validation.checked, 7); assert.deepEqual(receipt.reasons, ['imported_pages_missing']);
  }
});
