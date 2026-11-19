/**
 * Whether the brain has the `fact_relink_attempts` table (facts/conversation-memo.ts `hasRelinkAttemptsTable`): the
 * probe the conversation relink and the paid re-extraction memo ask before they read or write attempts.
 *
 * 1. Contract: PGLite and Postgres ask the catalog (`to_regclass`) and answer true on an initialized schema, false
 *    once the table is gone. An engine that reports a capability set without `raw_sql` (the Rust engine) answers from
 *    its `facts` capability (rust-engine/store-members/catalog.ts) and never calls `executeRaw`.
 * 2. Regressions: the probe running `to_regclass` on the Rust engine, which refuses raw SQL, so `gbrain facts relink
 *    --conversation` and every conversation extraction that records its paid memo stop on `engine_capability_missing`;
 *    or the probe answering "present" on an engine that does not report `facts`.
 * 3. Existing coverage: the parity harness cannot call this probe (it is not an engine member), and the relink tests
 *    run on PGLite only, where the catalog query always answered.
 * 4. Seams: engine fakes with a capability set for the Rust branch; a real PGLite engine for the SQL branch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hasRelinkAttemptsTable, recordReextractMemo } from '../src/core/facts/conversation-memo.ts';

/** An engine that reports `caps` and refuses raw SQL the way the Rust engine does. */
function catalogEngine(caps: string[]): BrainEngine & { rawCalls: number } {
  const engine = {
    capabilities: new Set(caps),
    rawCalls: 0,
    async executeRaw() {
      engine.rawCalls++;
      throw Object.assign(new Error('raw SQL refused'), { code: 'engine_capability_missing' });
    },
  };
  return engine as unknown as BrainEngine & { rawCalls: number };
}

describe('hasRelinkAttemptsTable on an engine without raw SQL', () => {
  test('answers false without the facts capability, and never runs SQL', async () => {
    const engine = catalogEngine(['pages', 'links']);
    expect(await hasRelinkAttemptsTable(engine)).toBe(false);
    expect(engine.rawCalls).toBe(0);
  });

  test('answers true with the facts capability, and never runs SQL', async () => {
    const engine = catalogEngine(['pages', 'facts']);
    expect(await hasRelinkAttemptsTable(engine)).toBe(true);
    expect(engine.rawCalls).toBe(0);
  });

  test('recordReextractMemo writes nothing and runs no SQL when the table is absent', async () => {
    const engine = catalogEngine(['pages']);
    await recordReextractMemo(engine, 'default', 'conversations/a');
    expect(engine.rawCalls).toBe(0);
  });
});

describe('hasRelinkAttemptsTable on PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('answers true on an initialized schema, false once the table is gone', async () => {
    expect(await hasRelinkAttemptsTable(engine)).toBe(true);
    await engine.executeRaw('DROP TABLE fact_relink_attempts');
    expect(await hasRelinkAttemptsTable(engine)).toBe(false);
  });
});
