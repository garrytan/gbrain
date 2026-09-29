/**
 * Read-path audit #19: get_tags had no private or soft-delete filter, so a
 * remote caller learned that a `visibility: private` page exists and read its
 * tags. Remote callers now get [] for private and soft-deleted pages; trusted
 * local callers keep the full view.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const get_tags = operations.find(o => o.name === 'get_tags')!;

const ctxOf = (remote: boolean): OperationContext => ({
  engine: engine as any, config: {} as any, logger: console as any, dryRun: false, remote, sourceId: 'default',
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/world', { type: 'note', title: 'World', compiled_truth: 'body' } as any);
  await engine.putPage('notes/secret', { type: 'note', title: 'Secret', compiled_truth: 'body', frontmatter: { visibility: 'private' } } as any);
  await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'body' } as any);
  await engine.addTag('notes/world', 'world-tag');
  await engine.addTag('notes/secret', 'secret-tag');
  await engine.addTag('notes/gone', 'gone-tag');
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/gone'`);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

describe('get_tags respects page visibility for remote callers', () => {
  test('world page tags are visible to remote callers', async () => {
    expect(await get_tags.handler(ctxOf(true), { slug: 'notes/world' })).toEqual(['world-tag']);
  });

  test('a private page returns no tags to a remote caller', async () => {
    expect(await get_tags.handler(ctxOf(true), { slug: 'notes/secret' })).toEqual([]);
  });

  test('a soft-deleted page returns no tags to a remote caller', async () => {
    expect(await get_tags.handler(ctxOf(true), { slug: 'notes/gone' })).toEqual([]);
  });

  test('trusted local callers keep the full view', async () => {
    expect(await get_tags.handler(ctxOf(false), { slug: 'notes/secret' })).toEqual(['secret-tag']);
    expect(await get_tags.handler(ctxOf(false), { slug: 'notes/gone' })).toEqual(['gone-tag']);
  });
});
