/**
 * postgres-engine.ts module-singleton ownership guardrails (#1471).
 *
 * Root cause: when an engine connects via the module-singleton path (no
 * poolSize), BOTH the engine that creates the shared db.ts `sql` singleton
 * (the owner, e.g. the CLI cycle engine) and any engine constructed while
 * that singleton already exists (a borrower, e.g. the probe engine in
 * resolveLintContentSanity / doctor) get `_connectionStyle = 'module'`. The
 * old disconnect() then called `db.disconnect()` for BOTH, so a short-lived
 * borrower's teardown nulled the shared `sql` the owner was still using -
 * every later cycle phase then threw "No database connection: connect() has
 * not been called" and stranded the cycle lock.
 *
 * Fix: track ownership. Only the engine whose connect() actually created the
 * singleton may db.disconnect() it; borrowers clear their own marker without
 * touching the shared connection.
 *
 * Source-level, DB-free guardrails - matching the existing
 * postgres-engine.test.ts convention (runtime mocking of postgres.js's
 * tagged-template interface is painful under bun ESM; live behaviour is
 * exercised by the dream cycle e2e + the manual `gbrain dream --dry-run`
 * repro recorded on the fix).
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
  test('db.ts exposes isConnected() so the engine can detect singleton ownership', () => {
    const hasIsConnected = /export function isConnected\s*\(\s*\)\s*:\s*boolean/.test(DB_SRC);
    expect(hasIsConnected).toBe(true);
  });

  test('PostgresEngine tracks module-singleton ownership with a dedicated flag', () => {
    expect(ENGINE_SRC.includes('_ownsModuleSingleton')).toBe(true);
  });

  test('connect() decides ownership from the PRE-EXISTING singleton state, before db.connect()', () => {
    // stripComments: the explanatory comment mentions "db.connect()", which
    // would otherwise match before the real call and invert the ordering check.
    const connect = stripComments(extractMethod(ENGINE_SRC, 'connect'));
    const ownIdx = connect.search(/db\.isConnected\s*\(/);
    const connIdx = connect.search(/db\.connect\s*\(/);
    expect(ownIdx).toBeGreaterThanOrEqual(0);
    expect(connIdx).toBeGreaterThanOrEqual(0);
    // Ownership must be sampled BEFORE we (possibly) create the singleton.
    expect(ownIdx < connIdx).toBe(true);
    expect(/_ownsModuleSingleton\s*=/.test(connect)).toBe(true);
  });

  test('disconnect() calls db.disconnect() ONLY when this engine owns the singleton', () => {
    const disconnect = stripComments(extractMethod(ENGINE_SRC, 'disconnect'));
    // The shared-singleton teardown must be guarded by the ownership flag - a
    // borrower clears its marker without nulling the owner's connection.
    const guarded = /if\s*\(\s*this\._ownsModuleSingleton\s*\)\s*\{[\s\S]*?db\.disconnect\s*\(\s*\)/.test(disconnect);
    expect(guarded).toBe(true);
    // And the only db.disconnect() in the method is the guarded one (no
    // unconditional clobber survives).
    const calls = [...disconnect.matchAll(/db\.disconnect\s*\(\s*\)/g)];
    expect(calls.length).toBe(1);
  });
});

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// Brace-match a class method body by name. Mirrors the helper in
// postgres-engine.test.ts.
function extractMethod(source: string, name: string): string {
  const openRe = new RegExp(`^\\s+async\\s+${name}\\s*\\(`, 'm');
  const match = openRe.exec(source);
  if (!match) throw new Error(`method ${name} not found in postgres-engine.ts`);
  // Balance the parameter-list parens first, so a `{` inside a param type
  // (e.g. connect(config: ... & { poolSize?: number })) isn't mistaken for
  // the body brace. The body `{` is the first one after the signature's `)`.
  let i = source.indexOf('(', match.index);
  let pdepth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') pdepth++;
    else if (source[i] === ')') {
      pdepth--;
      if (pdepth === 0) { i++; break; }
    }
  }
  i = source.indexOf('{', i);
  if (i < 0) throw new Error(`no body brace for ${name}`);
  const start = i;
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
