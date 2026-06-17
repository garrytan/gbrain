/**
 * v118 — federated_write: per-call write-target authorization.
 *
 * federated_write is the WRITE-side mirror of federated_read (#876): an OAuth
 * client carries `source_id` (its single write-AUTHORITY) plus an optional
 * `federated_write` array of additional sources it may write to. Write ops
 * (put_page, put_raw_data) accept an optional per-call write target, authorized
 * via `resolveWriteSource` against `{ctx.sourceId} ∪ ctx.auth.federatedWrite`.
 *
 * These tests mirror put-page-namespace.test.ts: dry-run with a stub engine so
 * no DB / network is needed. The dry-run return echoes the resolved `source`,
 * so we assert the authorized write target directly.
 *
 * Coverage:
 *   (a) no `source`            → resolves to ctx.sourceId (UNCHANGED behavior)
 *   (b) `source` in the set    → allowed (own source_id OR a federated_write src)
 *   (c) `source` NOT in the set → rejected with the federated_write auth error
 *   plus the pure-function contract for resolveWriteSource.
 */

import { describe, test, expect } from 'bun:test';
import { operations, OperationError, resolveWriteSource } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const put_page = operations.find(o => o.name === 'put_page') as Operation;
if (!put_page) throw new Error('put_page op missing');
const put_raw_data = operations.find(o => o.name === 'put_raw_data') as Operation;
if (!put_raw_data) throw new Error('put_raw_data op missing');

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const engine = {} as BrainEngine; // dry_run short-circuits before touching the engine
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true,
    remote: true,
    sourceId: 'directorio',
    ...overrides,
  };
}

// A "directorio" curator token: writes to its own source plus campo + lideres.
function directorioCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return makeCtx({
    sourceId: 'directorio',
    auth: {
      token: 'stub',
      clientId: 'gbrain_cl_director',
      scopes: ['read', 'write'],
      sourceId: 'directorio',
      allowedSources: ['campo', 'lideres', 'directorio'],
      federatedWrite: ['campo', 'lideres'],
    },
    ...overrides,
  });
}

describe('v118 resolveWriteSource (pure function)', () => {
  test('(a) no requested source → ctx.sourceId (unchanged behavior)', () => {
    expect(resolveWriteSource(directorioCtx(), undefined)).toBe('directorio');
    expect(resolveWriteSource(directorioCtx(), '')).toBe('directorio');
  });

  test('(b) requested === ctx.sourceId → allowed (own write authority always admitted)', () => {
    expect(resolveWriteSource(directorioCtx(), 'directorio')).toBe('directorio');
  });

  test('(b) requested in federated_write set → allowed', () => {
    expect(resolveWriteSource(directorioCtx(), 'campo')).toBe('campo');
    expect(resolveWriteSource(directorioCtx(), 'lideres')).toBe('lideres');
  });

  test('(c) requested NOT in set → throws permission_denied with the federated_write error', () => {
    let threw: unknown;
    try {
      resolveWriteSource(directorioCtx(), 'finanzas');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(OperationError);
    expect((threw as OperationError).code).toBe('permission_denied');
    expect((threw as OperationError).message).toMatch(/federated_write/);
    expect((threw as OperationError).message).toMatch(/finanzas/);
  });

  test('(c) no federatedWrite grant → only ctx.sourceId is admitted; anything else rejected', () => {
    const ctx = makeCtx({ sourceId: 'campo' }); // no auth.federatedWrite
    expect(resolveWriteSource(ctx, undefined)).toBe('campo');
    expect(resolveWriteSource(ctx, 'campo')).toBe('campo');
    expect(() => resolveWriteSource(ctx, 'directorio')).toThrow(OperationError);
  });

  test('attacker-supplied empty federatedWrite does NOT widen scope', () => {
    const ctx = makeCtx({
      sourceId: 'campo',
      auth: {
        token: 'stub', clientId: 'c', scopes: ['write'],
        sourceId: 'campo', federatedWrite: [],
      },
    });
    expect(() => resolveWriteSource(ctx, 'directorio')).toThrow(/federated_write/);
  });
});

describe('v118 put_page honors federated_write', () => {
  test('(a) no source → writes to ctx.sourceId', async () => {
    const result = await put_page.handler(directorioCtx(), { slug: 'wiki/x', content: 'stub' });
    expect(result).toMatchObject({ dry_run: true, action: 'put_page', slug: 'wiki/x', source: 'directorio' });
  });

  test('(b) source in federated_write set → writes there', async () => {
    const result = await put_page.handler(directorioCtx(), { slug: 'wiki/x', content: 'stub', source: 'campo' });
    expect(result).toMatchObject({ dry_run: true, source: 'campo' });
  });

  test('(c) source not in set → rejected (preview surfaces the rejection)', async () => {
    const p = put_page.handler(directorioCtx(), { slug: 'wiki/x', content: 'stub', source: 'finanzas' });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/federated_write/);
  });
});

describe('v118 put_raw_data honors federated_write (write_source, distinct from data-source `source`)', () => {
  test('(a) no write_source → writes to ctx.sourceId; data `source` label preserved', async () => {
    const result = await put_raw_data.handler(directorioCtx(), { slug: 'wiki/x', source: 'crustdata', data: {} });
    expect(result).toMatchObject({ dry_run: true, action: 'put_raw_data', source: 'crustdata', write_source: 'directorio' });
  });

  test('(b) write_source in set → writes there', async () => {
    const result = await put_raw_data.handler(directorioCtx(), { slug: 'wiki/x', source: 'crustdata', data: {}, write_source: 'lideres' });
    expect(result).toMatchObject({ dry_run: true, write_source: 'lideres' });
  });

  test('(c) write_source not in set → rejected', async () => {
    const p = put_raw_data.handler(directorioCtx(), { slug: 'wiki/x', source: 'crustdata', data: {}, write_source: 'finanzas' });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/finanzas/);
  });
});
