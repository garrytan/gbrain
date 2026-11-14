import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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

test('source exclusion blocks atom discovery and dispatch and keeps excluded audit history visible', async () => {
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('archive','Archive')");
  const prose = 'This note documents an eligible extraction candidate. '.repeat(24);
  await engine.putPage('notes/main', { type: 'note', title: 'Main note', compiled_truth: prose });
  await engine.putPage('notes/archive', { type: 'note', title: 'Archive note', compiled_truth: prose }, { sourceId: 'archive' });
  expect(await countExtractAtomsBacklog(engine, 'archive')).toBe(1);
  await engine.setConfig('cycle.extract_atoms.exclude_sources', '["archive"]');
  await engine.executeRaw("INSERT INTO extract_rollup_7d(kind,source_id,day,halt_count,cost_usd) VALUES('atoms','archive',CURRENT_DATE,1,0.012)");
  expect(await countExtractAtomsBacklog(engine, 'archive')).toBe(0);
  expect(await countExtractAtomsBacklog(engine)).toBe(1);
  expect(await discoverExtractablePages(engine, 'archive')).toEqual([]);
  const phase = await runPhaseExtractAtoms(engine, {
    sourceId: 'archive',
    _chat: async () => { throw new Error('Excluded source reached the model'); },
  });
  expect(phase.details.reason).toBe('source_excluded');
  const health = await computeExtractHealthCheck(engine);
  expect(health.status).toBe('ok');
  expect(health.details?.excluded_atom_history_7d).toMatchObject([{ source_id: 'archive', halts: 1 }]);
}, 15_000);
