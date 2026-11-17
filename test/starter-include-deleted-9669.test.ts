/**
 * #9669 — a remote client on the starter surface cannot read soft-deleted pages
 * through include_deleted, and its page_not_found no longer suggests it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const get_page = operations.find(o => o.name === 'get_page')!;
const list_pages = operations.find(o => o.name === 'list_pages')!;

function ctxOf(surface?: 'starter' | 'full'): OperationContext {
  return {
    engine: engine as any,
    config: { engine: 'pglite', embedding_disabled: true },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: { token: 't', clientId: 'c1', principal: { kind: 'oauth_client', id: 'c1' }, scopes: ['read'], sourceId: 'default', ...(surface ? { effectiveSurface: surface } : {}) },
  } as unknown as OperationContext;
}

async function outcome(op: typeof get_page, ctx: OperationContext, params: Record<string, unknown>) {
  try {
    return { value: await op.handler(ctx, params) as any, error: undefined as any };
  } catch (e) {
    return { value: undefined as any, error: e as any };
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/gone', { type: 'note' as any, title: 'Gone', compiled_truth: 'secret body', timeline: '', frontmatter: {} });
  await engine.softDeletePage('notes/gone');
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

describe('include_deleted on a starter-surface remote client', () => {
  test('get_page refuses include_deleted instead of returning the tombstone', async () => {
    const r = await outcome(get_page, ctxOf('starter'), { slug: 'notes/gone', include_deleted: true });
    expect(r.value?.compiled_truth).toBeUndefined();
    expect(r.error?.code).toBe('invalid_params');
  });

  test('list_pages refuses include_deleted instead of enumerating tombstones', async () => {
    const r = await outcome(list_pages, ctxOf('starter'), { include_deleted: true });
    expect(r.value?.some?.((x: any) => x.slug === 'notes/gone')).not.toBe(true);
    expect(r.error?.code).toBe('invalid_params');
  });

  test('page_not_found does not suggest include_deleted to that client', async () => {
    const r = await outcome(get_page, ctxOf('starter'), { slug: 'notes/gone' });
    expect(r.error?.code).toBe('page_not_found');
    expect(JSON.stringify([r.error?.suggestion, r.error?.fix])).not.toContain('include_deleted');
  });

  test('a full-surface remote client still reads the tombstone', async () => {
    const r = await outcome(get_page, ctxOf('full'), { slug: 'notes/gone', include_deleted: true });
    expect(r.error).toBeUndefined();
    expect(r.value?.slug).toBe('notes/gone');
  });
});
