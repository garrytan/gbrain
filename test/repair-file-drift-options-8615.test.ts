/**
 * #8615: `gbrain repair file-drift` with a held-selection option (--held, --side, --state, --cursor, --provenance) and no
 * --prefer never silently runs the all-drifted survey, which counts a different set of pages (drift conflicts, not held
 * files) with nothing saying the options were ignored. GST-2568: a valid held selection without --prefer compares the
 * selected holds and writes nothing; a narrowing option without --held is still refused.
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

test('held-selection options without --prefer compare the held selection or are refused, never surveyed', async () => {
  for (const selection of [{ held: true, side: 'deleted' }, { held: true }]) {
    const plan = await fileDriftRepair.plan(engine, scope, null, { apply: false, remote: false, ...selection });
    expect([plan.items, plan.details?.compare, plan.details?.writes, plan.details?.window]).toEqual([[], true, 'none', { previewed: 0, remaining: 0, complete: true }]);
  }
  for (const selection of [{ side: 'deleted' }, { state: 'file_gone' }, { cursor: 'next' }, { provenance: 'never_committed' }]) {
    const outcome = await fileDriftRepair.plan(engine, scope, null, { apply: false, remote: false, ...selection })
      .then(plan => ({ selection, surveyed: plan.listing }), (error: unknown) => error);
    expect(outcome).toBeInstanceOf(OperationError);
    expect([(outcome as OperationError).code, (outcome as OperationError).message]).toEqual(['invalid_params', 'Select pages one way: --slug, --request, --all-drifted or --held.']);
  }
});

test('no selection at all still runs the survey', async () => {
  const plan = await fileDriftRepair.plan(engine, scope, null, { apply: false, remote: false });
  expect(plan.listing).toEqual([]);
});
