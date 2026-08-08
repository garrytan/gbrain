/**
 * RED-ONLY tests for governed-source-lane (restrict_slug_prefixes + dual-lane
 * hybridSearch) — PGLite engine. Registers the shared 12-case suite.
 *
 * Engine lifecycle owned at file scope per check:test-isolation R3/R4: the
 * PGLiteEngine literal lives in beforeAll and the afterAll disconnects it.
 * registerLaneCases connects + seeds + registers the cases.
 */

import { beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  registerLaneCases,
  type LaneEngine,
} from './_governed-lane-cases.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
}, 60_000);
afterAll(async () => {
  await engine?.disconnect();
}, 30_000);

registerLaneCases(
  'PGLite',
  () => engine as unknown as LaneEngine,
  {},
);
