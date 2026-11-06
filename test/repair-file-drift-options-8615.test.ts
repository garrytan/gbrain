/**
 * #8615: `gbrain repair file-drift` with a held-selection option (--held, --side, --state, --cursor, --provenance) and no
 * --prefer is refused with the usage line instead of silently running the all-drifted survey, which counts a different
 * set of pages (drift conflicts, not held files) with nothing saying the options were ignored.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { fileDriftRepair } from '../src/core/repair/file-drift.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', ['source-a']);
});

afterAll(async () => {
  await engine.disconnect();
});

const scope = { brain_id: 'host', source_ids: ['source-a'] };

test('held-selection options without --prefer are refused, never surveyed', async () => {
  const selections = [
    { held: true, side: 'deleted' },
    { held: true },
    { side: 'deleted' },
    { state: 'file_gone' },
    { cursor: 'next' },
    { provenance: 'never_committed' },
  ];
  for (const selection of selections) {
    const outcome = await fileDriftRepair.plan(engine, scope, null, { apply: false, remote: false, ...selection })
      .then(plan => ({ selection, surveyed: plan.listing }), (error: unknown) => error);
    expect(outcome).toBeInstanceOf(OperationError);
    expect((outcome as OperationError).code).toBe('invalid_params');
    expect((outcome as OperationError).message).toBe('gbrain repair file-drift needs --prefer file or --prefer database.');
  }
});

test('no selection at all still runs the survey', async () => {
  const plan = await fileDriftRepair.plan(engine, scope, null, { apply: false, remote: false });
  expect(plan.listing).toEqual([]);
});
