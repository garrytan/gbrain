/**
 * GBRA-248 W1: two PGLite brains in one process keep their own pool, AI key,
 * caches, sinks, policies, locks, files and jobs (test/helpers/two-engine.ts).
 * The Postgres half is test/e2e/two-engine-isolation.test.ts.
 */
import { afterAll, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { twoEngineIsolationSuite } from './helpers/two-engine.ts';

const processHome = mkdtempSync(join(tmpdir(), 'gbrain-two-engine-process-home-'));
const savedHome = process.env.GBRAIN_HOME;
beforeAll(() => { process.env.GBRAIN_HOME = processHome; });
afterAll(() => {
  if (savedHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = savedHome;
  rmSync(processHome, { recursive: true, force: true });
});

twoEngineIsolationSuite('pglite');
