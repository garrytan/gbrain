/**
 * list_pages clamp local-trust + offset threading — op-level coverage.
 *
 * Pins (upstream draft "gbrain list silently clamps --limit to 100"):
 *   - Local callers (ctx.remote === false) get an explicit limit above 100
 *     honored — full enumeration is a legitimate local operation.
 *   - Remote callers keep the 100-row DoS cap, and the clamp is now LOUD:
 *     exactly one logger.warn (stderr, never stdout) naming both numbers.
 *   - Defaults unchanged: no limit → 50 rows for both local and remote.
 *   - `offset` threads through to the engine (PageFilters supported it all
 *     along; the op layer dropped it, so `--offset` was silently ignored).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

const SEED_COUNT = 120; // must exceed the remote cap (100) and the default (50)

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < SEED_COUNT; i++) {
    // Zero-padded slugs → sort:'slug' gives a deterministic order for the
    // offset assertions regardless of insert timestamps.
    await engine.putPage(`listclamp/page-${String(i).padStart(3, '0')}`, {
      type: 'note',
      title: `Page ${i}`,
      compiled_truth: 'body',
    });
  }
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

function mkCtx(overrides: Partial<OperationContext> = {}): {
  ctx: OperationContext;
  warnings: string[];
} {
  const warnings: string[] = [];
  const ctx = {
    engine,
    config: {} as any,
    logger: {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    } as any,
    dryRun: false,
    remote: false,
    ...overrides,
  } as OperationContext;
  return { ctx, warnings };
}

const op = () => operationsByName['list_pages'];

describe('list_pages — local callers escape the 100-row clamp', () => {
  test('remote=false with limit 100000 returns every page', async () => {
    const { ctx, warnings } = mkCtx({ remote: false });
    const rows = (await op().handler(ctx, { limit: 100000 })) as any[];
    expect(rows.length).toBe(SEED_COUNT);
    expect(warnings.length).toBe(0);
  });

  test('remote=false default (no limit) is still 50 — default unchanged', async () => {
    const { ctx } = mkCtx({ remote: false });
    const rows = (await op().handler(ctx, {})) as any[];
    expect(rows.length).toBe(50);
  });
});

describe('list_pages — remote callers keep the cap, loudly', () => {
  test('remote=true with limit 100000 returns 100 and warns once with both numbers', async () => {
    const { ctx, warnings } = mkCtx({ remote: true });
    const rows = (await op().handler(ctx, { limit: 100000 })) as any[];
    expect(rows.length).toBe(100);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('list limit clamped from 100000 to 100');
  });

  test('remote=true with limit <= 100 does not warn', async () => {
    const { ctx, warnings } = mkCtx({ remote: true });
    const rows = (await op().handler(ctx, { limit: 60 })) as any[];
    expect(rows.length).toBe(60);
    expect(warnings.length).toBe(0);
  });

  test('anything not strictly remote===false is treated as remote (defense in depth)', async () => {
    // ctx.remote contract: consumers treat non-false as untrusted even if the
    // type is bypassed via cast.
    const { ctx, warnings } = mkCtx({ remote: undefined as any });
    const rows = (await op().handler(ctx, { limit: 100000 })) as any[];
    expect(rows.length).toBe(100);
    expect(warnings.length).toBe(1);
  });
});

describe('list_pages — offset threads through (regression: was silently ignored)', () => {
  test('offset shifts the window under sort=slug', async () => {
    const { ctx } = mkCtx({ remote: false });
    const all = (await op().handler(ctx, { limit: 100000, sort: 'slug' })) as any[];
    const paged = (await op().handler(ctx, { limit: 10, offset: 5, sort: 'slug' })) as any[];
    expect(paged.length).toBe(10);
    expect(paged.map(r => r.slug)).toEqual(all.slice(5, 15).map(r => r.slug));
  });

  test('offset near the end truncates the page', async () => {
    const { ctx } = mkCtx({ remote: false });
    const rows = (await op().handler(ctx, {
      limit: 100000,
      offset: SEED_COUNT - 7,
      sort: 'slug',
    })) as any[];
    expect(rows.length).toBe(7);
  });

  test('garbage offset (negative / NaN) is ignored, not fatal', async () => {
    const { ctx } = mkCtx({ remote: false });
    const neg = (await op().handler(ctx, { limit: 10, offset: -5, sort: 'slug' })) as any[];
    const nan = (await op().handler(ctx, { limit: 10, offset: NaN, sort: 'slug' })) as any[];
    const base = (await op().handler(ctx, { limit: 10, sort: 'slug' })) as any[];
    expect(neg.map(r => r.slug)).toEqual(base.map(r => r.slug));
    expect(nan.map(r => r.slug)).toEqual(base.map(r => r.slug));
  });
});
