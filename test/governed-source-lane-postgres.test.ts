/**
 * RED-ONLY tests for governed-source-lane — POSTGRES engine parity.
 * Registers the SAME shared 12-case suite as the PGLite file. Conditional on
 * DATABASE_URL (skipped otherwise). Engine lifecycle owned at file scope.
 */

import { beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import {
  registerLaneCases,
  type LaneEngine,
} from './_governed-lane-cases.ts';

let engine: PostgresEngine;
const database_url = process.env.DATABASE_URL;

if (database_url) {
  beforeAll(async () => {
    engine = new PostgresEngine();
  }, 120_000);
  afterAll(async () => {
    await engine?.disconnect();
  }, 60_000);

  registerLaneCases(
    'Postgres',
    () => engine as unknown as LaneEngine,
    { database_url, engine: 'postgres' as const },
  );
} else {
  // eslint-disable-next-line no-console
  console.warn(
    '[governed-source-lane-postgres] DATABASE_URL unset; Postgres parity suite skipped.',
  );
}
