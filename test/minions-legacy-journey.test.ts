/**
 * #5157 restored-operation journey on PGLite (DX-O15(a), DX-O3(f)(g)); the
 * Postgres run is `test/e2e/minions-legacy-journey-postgres.test.ts`. Both
 * drive `test/helpers/legacy-journey.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runLegacyJourney, runUnsupportedRowRecovery } from './helpers/legacy-journey.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('legacy job recovery journey (PGLite)', () => {
  test('/ingest 409 -> printed commands verbatim -> 202, worker runs, search finds the memory', async () => {
    const { commands } = await runLegacyJourney(engine);
    expect(commands).toHaveLength(6);
  }, 120_000);

  test('an unsupported non-NULL row needs its own printed cancel before a worker starts', async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
    const commands = await runUnsupportedRowRecovery(engine);
    expect(commands).toHaveLength(3);
  }, 120_000);
});
