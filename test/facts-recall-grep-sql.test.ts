/**
 * recall (MCP op) — `grep` must filter in SQL, BEFORE the limit.
 *
 * A client-side post-limit grep silently returns nothing on a
 * high-cardinality entity: the matching fact sits outside the newest-N
 * window the engine fetched, so `recall --entity X --grep needle` comes
 * back empty while the fact exists — indistinguishable from "not in
 * memory" (found by the 2026-08-06 memory eval on an entity with hundreds
 * of facts; reimplemented from community PR #3851 by miroslavb).
 *
 * Seed order matters: the needle fact goes in FIRST (older created_at /
 * lowest id), then `limit`-plus newer non-matching facts go in AFTER.
 * With ORDER BY ... DESC, id DESC the needle falls OUTSIDE the fetch
 * window — a post-limit filter finds nothing, so these tests only pass
 * when the engines apply grep in the WHERE clause. (Seeding the needle
 * last would let a client-side grep pass too — non-discriminative.)
 *
 * The supersessions arm bypasses FactListOpts, so its client-side grep
 * is pinned separately below.
 *
 * PGLite-only; no DATABASE_URL, no API keys.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

const ENTITY = 'people/alice-example';
const SESSION = 'grep-session-a';
const NEEDLE_FACT = 'alice prefers oat milk in coffee';
// More filler rows than the limit used below, so the needle fact is
// guaranteed to sit outside the newest-N window on every arm's sort key.
const FILLER_COUNT = 10;
const LIMIT = 5;

async function recall(params: Record<string, unknown>) {
  const result = await dispatchToolCall(engine, 'recall', params, {
    remote: false,
    sourceId: 'default',
  });
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text) as {
    facts: Array<{ fact: string; entity_slug: string | null }>;
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await engine.insertFact(
    { fact: NEEDLE_FACT, kind: 'preference', entity_slug: ENTITY, source: 'test', source_session: SESSION },
    { source_id: 'default' },
  );
  // A literal-wildcard row for the escaping test: '100%' must be matched
  // as text, not as a LIKE pattern.
  await engine.insertFact(
    { fact: 'alice keeps battery at 100% before travel', kind: 'fact', entity_slug: ENTITY, source: 'test', source_session: SESSION },
    { source_id: 'default' },
  );
  for (let i = 0; i < FILLER_COUNT; i++) {
    await engine.insertFact(
      { fact: `alice filler fact number ${i}`, kind: 'fact', entity_slug: ENTITY, source: 'test', source_session: SESSION },
      { source_id: 'default' },
    );
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall grep filters in SQL before the limit', () => {
  test('entity arm: needle outside the newest-N window is still found', async () => {
    const payload = await recall({ entity: ENTITY, grep: 'oat milk', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
    expect(payload.facts.every(f => f.fact.includes('oat milk'))).toBe(true);
  });

  test('session arm: needle outside the newest-N window is still found', async () => {
    const payload = await recall({ session_id: SESSION, grep: 'oat milk', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
  });

  test('since arm: needle outside the newest-N window is still found', async () => {
    const payload = await recall({ since: '1 hour ago', grep: 'oat milk', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
  });

  test('no-filter arm: needle outside the newest-N window is still found', async () => {
    const payload = await recall({ grep: 'oat milk', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
  });

  test('grep is case-insensitive', async () => {
    const payload = await recall({ entity: ENTITY, grep: 'OAT MILK', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
  });

  test('LIKE wildcards in the needle are literal, not patterns', async () => {
    // Unescaped, '100%' becomes the pattern %100%% and would also match
    // every 'filler fact number 100'-style row containing '100'. Escaped,
    // it matches only the literal-percent row.
    const payload = await recall({ entity: ENTITY, grep: '100%', limit: LIMIT });
    expect(payload.facts.length).toBe(1);
    expect(payload.facts[0].fact).toBe('alice keeps battery at 100% before travel');
  });

  test('non-matching grep returns empty, not the unfiltered window', async () => {
    const payload = await recall({ entity: ENTITY, grep: 'no-such-needle-anywhere', limit: LIMIT });
    expect(payload.facts.length).toBe(0);
  });
});

describe('supersessions arm keeps its client-side grep', () => {
  test('grep filters the supersession audit log', async () => {
    const old = await engine.insertFact(
      { fact: 'bob-example lives in kirkland', kind: 'fact', entity_slug: 'people/bob-example', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'bob-example lives in bellevue', kind: 'fact', entity_slug: 'people/bob-example', source: 'test' },
      { source_id: 'default', supersedeId: old.id },
    );
    const hit = await recall({ supersessions: true, grep: 'kirkland' });
    expect(hit.facts.some(f => f.fact === 'bob-example lives in kirkland')).toBe(true);
    const miss = await recall({ supersessions: true, grep: 'no-such-needle-anywhere' });
    expect(miss.facts.length).toBe(0);
  });
});
