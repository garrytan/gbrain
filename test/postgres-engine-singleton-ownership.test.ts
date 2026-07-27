/**
 * postgres-engine.ts module-singleton ownership guardrails (#1471).
 *
 * Root cause: when an engine connects via the module-singleton path (no
 * poolSize), BOTH the engine that creates the shared db.ts `sql` singleton
 * (the owner, e.g. the CLI cycle engine) and any engine constructed while
 * that singleton already exists (a borrower, e.g. the probe engine in
 * resolveLintContentSanity / doctor) got `_connectionStyle = 'module'`. The
 * old disconnect() then called `db.disconnect()` for BOTH, so a short-lived
 * borrower's teardown nulled the shared `sql` the owner was still using —
 * every later cycle phase then threw "No database connection: connect() has
 * not been called" and stranded the cycle lock.
 *
 * Fix: track ownership via a token returned atomically by db.connect(). Only
 * the engine whose connect() actually created the singleton may db.disconnect()
 * it; borrowers clear their own marker without touching the shared connection.
 *
 * Source-level, DB-free guardrails — matching the existing
 * postgres-engine.test.ts convention (runtime mocking of postgres.js's
 * tagged-template interface is painful under bun ESM; live behaviour is
 * exercised by test/e2e/postgres-engine-disconnect-idempotency.test.ts).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ENGINE_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'core', 'postgres-engine.ts'),
  'utf-8',
);
const DB_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'core', 'db.ts'),
  'utf-8',
);

describe('postgres-engine / module-singleton ownership (#1471)', () => {
  // Boolean assertions on purpose: matching a regex against the 4500-line
  // source dumps the whole file into the failure message. `.test()` -> bool
  // keeps RED output (and CI logs) readable.

  test('db.connect() returns the ownership token (Promise<boolean>), not void', () => {
    const sig = /export async function connect\(config: EngineConfig\): Promise<boolean>/.test(DB_SRC);
    expect(sig).toBe(true);
  });

  test('db.connect() borrower path returns false; creator path returns true', () => {
    const connect = stripComments(extractFn(DB_SRC, 'connect'));
    // Borrower (singleton already exists) → return false.
    expect(/if\s*\(\s*sql\s*\)\s*\{[\s\S]*?return false/.test(connect)).toBe(true);
    // Creator (built + validated the pool) → return true.
    expect(/return true/.test(connect)).toBe(true);
  });

  test('PostgresEngine tracks module-singleton ownership with a dedicated flag', () => {
    expect(ENGINE_SRC.includes('_ownsModuleSingleton')).toBe(true);
  });

  test('connect() stores the ownership token from db.connect() — no separate pre-sample (TOCTOU guard)', () => {
    const connect = stripComments(extractMethod(ENGINE_SRC, 'connect'));
    // Ownership is the RETURN of db.connect(), assigned to the flag.
    expect(/_ownsModuleSingleton\s*=\s*await\s+db\.connect\s*\(/.test(connect)).toBe(true);
    // Regression guard against the original TOCTOU shape: no separate
    // db.isConnected() probe sampled before db.connect().
    expect(/db\.isConnected\s*\(/.test(connect)).toBe(false);
  });

  test('disconnect() calls db.disconnect() ONLY when this engine owns the singleton', () => {
    const disconnect = stripComments(extractMethod(ENGINE_SRC, 'disconnect'));
    // The shared-singleton teardown must be guarded by the ownership flag — a
    // borrower clears its marker without nulling the owner's connection.
    const guarded = /if\s*\(\s*this\._ownsModuleSingleton\s*\)\s*\{[\s\S]*?db\.disconnect\s*\(\s*\)/.test(disconnect);
    expect(guarded).toBe(true);
    // And the only db.disconnect() in the method is the guarded one (no
    // unconditional clobber survives).
    const calls = [...disconnect.matchAll(/db\.disconnect\s*\(\s*\)/g)];
    expect(calls.length).toBe(1);
  });

  test('db.disconnect() snapshots + nulls the singleton BEFORE awaiting end() (codex #6)', () => {
    const disconnect = stripComments(extractFn(DB_SRC, 'disconnect'));
    const snapshotIdx = disconnect.search(/const\s+s\s*=\s*sql/);
    const nullIdx = disconnect.search(/\bsql\s*=\s*null/);
    // #1972: the pool end is now wrapped in the gbrain-owned hard bound
    // `endPoolBounded(s)` instead of a bare `s.end()`. The ordering contract is
    // unchanged: snapshot + null the singleton BEFORE awaiting the end.
    const endIdx = disconnect.search(/\bawait\s+(?:s\.end\s*\(|endPoolBounded\s*\(\s*s\b)/);
    expect(snapshotIdx).toBeGreaterThanOrEqual(0);
    expect(nullIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThanOrEqual(0);
    // null the module ref BEFORE the await, so a concurrent connect() can't
    // join a pool that's already closing.
    expect(nullIdx < endIdx).toBe(true);
  });

  test('reconnect() is connection-style aware: module-singleton path never tears down the shared pool (#1745)', () => {
    const reconnect = stripComments(extractMethod(ENGINE_SRC, 'reconnect'));
    // Module-singleton engines must NOT route through this.disconnect()/db.disconnect()
    // on reconnect — they recover idempotently via db.connect() + setReadPool, so a
    // transient blip can't null the shared singleton other phases are using.
    expect(/this\._connectionStyle\s*!==\s*'instance'/.test(reconnect)).toBe(true);
    expect(/db\.connect\(this\._savedConfig\)/.test(reconnect)).toBe(true);
    expect(/setReadPool\(db\.getConnection\(\)\)/.test(reconnect)).toBe(true);
    // The instance path keeps the `_reconnecting` re-entrancy guard.
    expect(/this\._reconnecting\s*=\s*true/.test(reconnect)).toBe(true);
  });
});

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// Balance a `{...}` body starting at the first `{` after `headerIdx`, where
// headerIdx points at (or before) the signature's parameter list. Skips the
// parameter-list parens so a `{` inside a param type isn't mistaken for the body.
function balanceBodyFrom(source: string, headerIdx: number, what: string): string {
  let i = source.indexOf('(', headerIdx);
  let pdepth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') pdepth++;
    else if (source[i] === ')') {
      pdepth--;
      if (pdepth === 0) { i++; break; }
    }
  }
  i = source.indexOf('{', i);
  if (i < 0) throw new Error(`no body brace for ${what}`);
  const start = i;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${what}`);
}

// Class method body by name (async or not).
function extractMethod(source: string, name: string): string {
  const openRe = new RegExp(`^\\s+(?:async\\s+)?${name}\\s*\\(`, 'm');
  const match = openRe.exec(source);
  if (!match) throw new Error(`method ${name} not found`);
  return balanceBodyFrom(source, match.index, name);
}

// Top-level exported function body by name.
function extractFn(source: string, name: string): string {
  const openRe = new RegExp(`export async function ${name}\\s*\\(`);
  const match = openRe.exec(source);
  if (!match) throw new Error(`function ${name} not found`);
  return balanceBodyFrom(source, match.index, name);
}
