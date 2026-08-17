/**
 * PR6 D5 — source-scoped advisory-lock key helpers.
 *
 * Pins the EXACT key strings (they are cross-process wire contracts: every
 * writer hashing a different string holds a different lock) plus the
 * writer-side transaction routing: WriteTxImpl runs inside exactly ONE
 * engine.transaction (BrainWriter.transaction's), and the advisory lock,
 * the slug-registry existence probes, and the paired putPage all flow
 * through the tx engine — so the pg_advisory_xact_lock genuinely spans the
 * TOCTOU window until the outer commit. A nested engine.transaction inside
 * createEntity would throw on both engines (postgres tx clones have no
 * `.begin`; PGLite tx proxies have no `.transaction`); the txCount === 1
 * assertion pins that no such wrap exists.
 */

import { describe, test, expect } from 'bun:test';
import { autoLinkLockKey } from '../src/core/ops/pages.ts';
import { registerClientNameLockKey } from '../src/commands/agent-register.ts';
import { slugRegistryLockKey, BrainWriter } from '../src/core/output/writer.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ResolverContext } from '../src/core/resolvers/index.ts';

describe('autoLinkLockKey (ops/pages.ts)', () => {
  test('exact string with a sourceId', () => {
    expect(autoLinkLockKey('src-a', 'people/alice-example')).toBe('auto_link:src-a:people/alice-example');
  });

  test('exact string with undefined sourceId (belt-and-braces empty segment)', () => {
    expect(autoLinkLockKey(undefined, 'people/alice-example')).toBe('auto_link::people/alice-example');
  });

  test('different sources produce different keys (no cross-source contention)', () => {
    expect(autoLinkLockKey('src-a', 'notes/x')).not.toBe(autoLinkLockKey('src-b', 'notes/x'));
  });

  test('same (source, slug) produces the same key (same-scope writers still serialize)', () => {
    expect(autoLinkLockKey('src-a', 'notes/x')).toBe(autoLinkLockKey('src-a', 'notes/x'));
  });
});

describe('registerClientNameLockKey (commands/agent-register.ts)', () => {
  test('exact string (cross-process wire contract shared by register + reissue rotation)', () => {
    expect(registerClientNameLockKey('aurora-coder')).toBe('register_client_name:aurora-coder');
  });

  test('different names produce different keys; same name serializes', () => {
    expect(registerClientNameLockKey('a')).not.toBe(registerClientNameLockKey('b'));
    expect(registerClientNameLockKey('a')).toBe(registerClientNameLockKey('a'));
  });
});

describe('slugRegistryLockKey (output/writer.ts)', () => {
  test('exact string with a sourceId', () => {
    expect(slugRegistryLockKey('src-a', 'people/alice-example')).toBe('slug_registry:src-a:people/alice-example');
  });

  test("exact string with undefined sourceId falls back to 'default' (mirrors putPage's implicit source)", () => {
    expect(slugRegistryLockKey(undefined, 'people/alice-example')).toBe('slug_registry:default:people/alice-example');
  });

  test('different sources produce different keys (no cross-source contention)', () => {
    expect(slugRegistryLockKey('src-a', 'people/x')).not.toBe(slugRegistryLockKey('src-b', 'people/x'));
  });
});

// ---------------------------------------------------------------------------
// Writer transaction routing proof (stub engine)
// ---------------------------------------------------------------------------

type RecordedCall = { method: string; onTx: boolean; sql?: string; params?: unknown[] };

function makeStubEngine(): { engine: BrainEngine; calls: RecordedCall[]; getTxCount: () => number } {
  const calls: RecordedCall[] = [];
  let txCount = 0;
  const base = {
    isTx: false,
    async transaction(fn: (e: unknown) => Promise<unknown>) {
      txCount++;
      // Mirrors both real engines: the tx engine is a prototype clone whose
      // connection routes to the transaction. A SECOND transaction() call on
      // the clone would throw on both real engines — txCount pins there is
      // exactly one.
      const clone = Object.create(this) as typeof base;
      clone.isTx = true;
      return fn(clone);
    },
    async executeRaw(sql: string, params?: unknown[]) {
      calls.push({ method: 'executeRaw', onTx: this.isTx, sql, params });
      return [];
    },
    async getPage(_slug: string, _opts?: unknown) {
      calls.push({ method: 'getPage', onTx: this.isTx });
      return null; // desired slug is free — fast path, no disambiguation
    },
    async putPage(slug: string, _page: unknown, _opts?: unknown) {
      calls.push({ method: 'putPage', onTx: this.isTx });
      return { slug };
    },
  };
  return { engine: base as unknown as BrainEngine, calls, getTxCount: () => txCount };
}

function makeCtx(): ResolverContext {
  return {
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    requestId: 'lock-keys-test',
    remote: false,
  };
}

describe('createEntity advisory lock — transaction scope + key routing', () => {
  test('lock + slug probes + putPage all run inside the ONE wrapping transaction, keyed per source', async () => {
    const { engine, calls, getTxCount } = makeStubEngine();
    const writer = new BrainWriter(engine, { strictMode: 'off', sourceId: 'src-a' });

    const { result } = await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/alice-example',
      displayName: 'Alice Example',
      type: 'person',
      compiledTruth: 'Alice is a person.',
    }), makeCtx());

    expect(result).toBe('people/alice-example');
    // Exactly ONE transaction — createEntity must NOT nest engine.transaction
    // (nesting throws on both real engines).
    expect(getTxCount()).toBe(1);

    const lock = calls.find((c) => c.sql?.includes('pg_advisory_xact_lock'));
    expect(lock).toBeDefined();
    expect(lock!.params).toEqual([slugRegistryLockKey('src-a', 'people/alice-example')]);
    expect(lock!.params).toEqual(['slug_registry:src-a:people/alice-example']);

    // Every statement in the TOCTOU window (lock, registry getPage probe,
    // putPage) flowed through the tx engine — the xact lock spans them all.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c.onTx).toBe(true);
    expect(calls.map((c) => c.method)).toContain('putPage');
  });

  test("writer without an explicit source locks the 'default' key (matches putPage's implicit source)", async () => {
    const { engine, calls } = makeStubEngine();
    const writer = new BrainWriter(engine, { strictMode: 'off' });

    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/bob-example',
      displayName: 'Bob Example',
      type: 'person',
      compiledTruth: 'Bob is a person.',
    }), makeCtx());

    const lock = calls.find((c) => c.sql?.includes('pg_advisory_xact_lock'));
    expect(lock!.params).toEqual(['slug_registry:default:people/bob-example']);
  });
});
