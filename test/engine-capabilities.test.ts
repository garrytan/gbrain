/**
 * Engine capability set (docs/designs/RUST_ENGINE.md "Capability gating", plan PR 5).
 * PGLite and Postgres report everything they have today, so no existing caller
 * can be refused; an unlisted operation needs raw_sql.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ENGINE_CAPABILITIES,
  REQUIRED_CAPABILITIES,
  capabilitiesForEngineKind,
  hasCapability,
  missingCapabilities,
  requiredCapabilities,
  type Capability,
} from '../src/core/engine-capabilities.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

// commit_log is reported only by a Rust engine whose store keeps a commit log (engine-members/commit-log.ts);
// serialized_transactions only by a Rust engine whose explicit transactions hold the writer.
const shared = ENGINE_CAPABILITIES.filter(c => c !== 'single_owner' && c !== 'postgres_admin' && c !== 'commit_log' && c !== 'serialized_transactions');

describe('engine capabilities', () => {
  // Never connected: capabilities are known without opening a database.
  let pglite: PGLiteEngine;
  let postgres: PostgresEngine;
  beforeAll(() => {
    pglite = new PGLiteEngine();
    postgres = new PostgresEngine();
  });
  afterAll(async () => {
    await pglite.disconnect();
    await postgres.disconnect();
  });

  test('PGLite reports every shared capability, raw_sql and single_owner, and no Postgres administration', () => {
    const engine = pglite;
    for (const c of shared) expect(engine.capabilities.has(c)).toBe(true);
    expect(hasCapability(engine, 'raw_sql')).toBe(true);
    expect(hasCapability(engine, 'single_owner')).toBe(true);
    expect(hasCapability(engine, 'postgres_admin')).toBe(false);
    expect(hasCapability(engine, 'commit_log')).toBe(false);
    expect(engine.capabilities.size).toBe(shared.length + 1);
  });

  test('the multi-user list (I-8.v2) is apart from ENGINE_CAPABILITIES, and neither SQL engine reports served', () => {
    expect((ENGINE_CAPABILITIES as readonly string[]).includes('served')).toBe(false);
    expect(pglite.capabilities.has('served')).toBe(false);
    expect(postgres.capabilities.has('served')).toBe(false);
  });

  test('Postgres reports every shared capability, raw_sql and postgres_admin, and is not single-owner', () => {
    const engine = postgres;
    for (const c of shared) expect(engine.capabilities.has(c)).toBe(true);
    expect(hasCapability(engine, 'raw_sql')).toBe(true);
    expect(hasCapability(engine, 'postgres_admin')).toBe(true);
    expect(hasCapability(engine, 'single_owner')).toBe(false);
    expect(hasCapability(engine, 'commit_log')).toBe(false);
    expect(engine.capabilities.size).toBe(shared.length + 1);
  });

  test('neither SQL engine reports serialized_transactions: they take the locks a Rust brain skips', () => {
    expect(hasCapability(pglite, 'serialized_transactions')).toBe(false);
    expect(hasCapability(postgres, 'serialized_transactions')).toBe(false);
  });

  test('a transaction clone reports the same set as its engine', () => {
    const clone = Object.create(pglite) as PGLiteEngine;
    expect(clone.capabilities).toBe(pglite.capabilities);
  });

  test('each engine gets its own set: changing one never changes another', () => {
    const a = capabilitiesForEngineKind('pglite') as Set<Capability>;
    const b = capabilitiesForEngineKind('pglite');
    a.delete('pages');
    expect(b.has('pages')).toBe(true);
    expect(pglite.capabilities.has('pages')).toBe(true);
  });

  test('an unlisted operation, command, phase or handler needs raw_sql', () => {
    expect(requiredCapabilities('operation', 'put_page')).toEqual(['raw_sql']);
    expect(requiredCapabilities('command', 'doctor')).toEqual(['raw_sql']);
    expect(requiredCapabilities('phase', 'extract')).toEqual(['raw_sql']);
    expect(requiredCapabilities('handler', 'embed')).toEqual(['raw_sql']);
    // Object prototype names are not table rows.
    expect(requiredCapabilities('operation', 'toString')).toEqual(['raw_sql']);
  });

  test('every row in the table names known capabilities, and both SQL engines can run every name', () => {
    const known = new Set<string>(ENGINE_CAPABILITIES);
    const engines = [pglite, postgres];
    for (const [consumer, rows] of Object.entries(REQUIRED_CAPABILITIES)) {
      for (const [name, caps] of Object.entries(rows)) {
        for (const c of caps) expect(known.has(c)).toBe(true);
        for (const e of engines) {
          if (caps.includes('single_owner') || caps.includes('postgres_admin')) continue;
          expect(missingCapabilities(e, consumer as keyof typeof REQUIRED_CAPABILITIES, name)).toEqual([]);
        }
      }
    }
    for (const e of engines) expect(missingCapabilities(e, 'operation', 'put_page')).toEqual([]);
  });

  test('an engine without raw SQL is refused an unlisted operation, naming raw_sql', () => {
    const typedOnly = { capabilities: new Set<Capability>(['pages', 'chunks']) as ReadonlySet<Capability> };
    expect(missingCapabilities(typedOnly, 'operation', 'put_page')).toEqual(['raw_sql']);
  });
});
