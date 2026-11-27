/**
 * serve-health.ts:69 (lane 8's refusal-swallow triage): the serve transport asks only a Postgres server for its
 * application name (Supavisor is a Postgres pooler). PGLite and the Rust engine have none, so they are asked nothing.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readServeTransport sends `SHOW application_name` once on Postgres and never on PGLite or Rust, and
 *    reports no application name there.
 *  - Regression: every engine was asked; a Rust brain refused the statement and the `.catch(() => [])` read the refusal
 *    as "no pooler", a quiet default the refusal-swallow guard counts.
 *  - Why existing coverage misses it: the serve-health tests run on PGLite, where the statement answered.
 *  - Seam: a counting proxy over the engine's executeRaw; real engines. The Rust part needs the addon (skipped without
 *    it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1); the Postgres part needs DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readServeTransport } from '../src/commands/serve-health.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const addonReady = existsSync(rustArmAddonPath());
const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';

/** The transport, and how many times the engine was asked `SHOW application_name`. */
async function transportOf(engine: BrainEngine): Promise<{ asked: number; application_name: string | null }> {
  let asked = 0;
  const counting = new Proxy(engine, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === 'executeRaw') {
      return (sql: string, params?: unknown[]) => { if (/SHOW application_name/.test(sql)) asked++; return (value as BrainEngine['executeRaw']).call(target, sql, params); };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const transport = await readServeTransport(counting);
  return { asked, application_name: transport.application_name ?? null };
}

describe('serve-health.ts:69 only a Postgres server is asked for its application name', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  });
  afterAll(() => engine.disconnect());

  test('PGLite is asked nothing', async () => {
    expect(await transportOf(engine)).toEqual({ asked: 0, application_name: null });
  });

  test.skipIf(!addonReady && !required)('a Rust brain is asked nothing, so no refusal is read as "no pooler"', async () => {
    const brain = await openRustBrain();
    try {
      expect(await transportOf(brain.engine as unknown as BrainEngine)).toEqual({ asked: 0, application_name: null });
    } finally {
      await brain.engine.disconnect();
      removeBrainDir(brain.dir);
    }
  });
});
