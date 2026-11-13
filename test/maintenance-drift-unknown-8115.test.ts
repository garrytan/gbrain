/**
 * #8115: maintenance_write_drift with drift receipts whose live comparison is unavailable
 * on this host (no canonical owner binding) must report unknown health and an incomplete
 * report, not ok. A source with no receipts stays ok and complete.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { maintenanceWriteDriftCheck } from '../src/commands/doctor/checks/maintenance-drift.ts';
import { computeDoctorReport } from '../src/commands/doctor.ts';
import { FILE_DRIFT_MESSAGE } from '../src/core/persistence/drift-conflicts.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const run = { tier: 'standard' as const, startedAt: Date.now(), budgetMs: null };

test('candidates whose live comparison is unavailable report unknown health and an incomplete report', async () => {
  await engine.putPage('notes/alpha', { type: 'note', title: 'Alpha', compiled_truth: 'Alpha.', timeline: '' });
  await engine.transaction(async (tx) => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
        intent_bytes,terminal_reservation,state,error_code,error_message)
      VALUES('local_cli','fixture',$1::uuid,'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'notes/alpha',$2,'{}'::jsonb,0,0,
        'conflict','source_changed',$3)`, [randomUUID(), randomUUID(), FILE_DRIFT_MESSAGE]);
  });
  const check = await maintenanceWriteDriftCheck(engine, ['default']);
  expect(check.details?.sources).toEqual([expect.objectContaining({ source_id: 'default', drifted: 0, unknown: 1 })]);
  expect(check.status).toBe('warn');
  expect(check.details?.health).toBe('unknown');
  const report = computeDoctorReport([check], { run });
  expect(report.complete).toBe(false);
  expect(report.unknown_sections).toEqual(['maintenance_write_drift']);
});

test('control: a source with no drift receipts stays ok and complete', async () => {
  const check = await maintenanceWriteDriftCheck(engine, ['default']);
  expect(check.status).toBe('ok');
  expect(check.details?.health).toBeUndefined();
  expect(computeDoctorReport([check], { run }).complete).toBe(true);
});
