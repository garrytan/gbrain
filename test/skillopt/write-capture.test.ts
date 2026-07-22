/**
 * SkillOpt write-capture mode tests (F10).
 *
 * Verifies that buildWriteCaptureRegistry produces:
 *  - A defs array that ADDS put_page/submit_job/file_upload to the read-only base
 *  - Handlers that capture writes in-memory (not persisted)
 *  - Per-rollout isolation (fresh registries don't share state)
 *
 * Hermetic — uses PGLite for the engine but never persists via handlers.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { buildWriteCaptureRegistry } from '../../src/core/skillopt/write-capture.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('F10 write-capture registry', () => {
  test('defs include brain_put_page, brain_submit_job, brain_file_upload', () => {
    const reg = buildWriteCaptureRegistry(engine);
    const names = reg.defs.map((d) => d.name);
    expect(names).toContain('brain_put_page');
    expect(names).toContain('brain_submit_job');
    expect(names).toContain('brain_file_upload');
  });

  test('virtual put_page captures but does NOT persist', async () => {
    const reg = buildWriteCaptureRegistry(engine);
    const handler = reg.handlers.get('brain_put_page')!;
    const ctrl = new AbortController();
    const result = await handler.execute({ slug: 'test/skill', content: 'hello' }, ctrl.signal);
    expect((result as { virtual: boolean }).virtual).toBe(true);
    // Captured in-memory.
    expect(reg.getWrites().length).toBe(1);
    expect(reg.getWrites()[0]!.op).toBe('put_page');
    expect(reg.getWrites()[0]!.key).toBe('test/skill');
    // Virtual page tracked by slug.
    expect(reg.getVirtualPages().get('test/skill')).toBeDefined();
    // No actual page persisted — verify via engine.
    const real = await engine.getPage('test/skill');
    expect(real).toBeNull();
  });

  test('virtual submit_job captures + returns ok', async () => {
    const reg = buildWriteCaptureRegistry(engine);
    const handler = reg.handlers.get('brain_submit_job')!;
    const ctrl = new AbortController();
    const result = await handler.execute({ name: 'shell', params: { cmd: 'echo hi' } }, ctrl.signal);
    expect((result as { virtual: boolean }).virtual).toBe(true);
    expect(reg.getWrites().length).toBe(1);
    expect(reg.getWrites()[0]!.op).toBe('submit_job');
  });

  test('virtual file_upload captures + returns ok', async () => {
    const reg = buildWriteCaptureRegistry(engine);
    const handler = reg.handlers.get('brain_file_upload')!;
    const ctrl = new AbortController();
    const result = await handler.execute({ path: '/tmp/fake.txt' }, ctrl.signal);
    expect((result as { virtual: boolean }).virtual).toBe(true);
    expect(reg.getWrites().length).toBe(1);
    expect(reg.getWrites()[0]!.op).toBe('file_upload');
  });

  test('two separate registries do not share captured state', async () => {
    const a = buildWriteCaptureRegistry(engine);
    const b = buildWriteCaptureRegistry(engine);
    const ctrl = new AbortController();
    await a.handlers.get('brain_put_page')!.execute({ slug: 'a/x', content: 'a' }, ctrl.signal);
    expect(a.getWrites().length).toBe(1);
    expect(b.getWrites().length).toBe(0);
  });

  test('repeated put_page for same slug captures both writes; virtualPages reflects latest', async () => {
    const reg = buildWriteCaptureRegistry(engine);
    const ctrl = new AbortController();
    await reg.handlers.get('brain_put_page')!.execute({ slug: 'dup/slug', content: 'first' }, ctrl.signal);
    await reg.handlers.get('brain_put_page')!.execute({ slug: 'dup/slug', content: 'second' }, ctrl.signal);
    expect(reg.getWrites().length).toBe(2);
    // virtualPages reflects the LATEST write (matches real put_page upsert semantics).
    expect((reg.getVirtualPages().get('dup/slug')!.input as { content: string }).content).toBe('second');
  });

  test('put_page without slug throws (validation)', async () => {
    const reg = buildWriteCaptureRegistry(engine);
    const handler = reg.handlers.get('brain_put_page')!;
    const ctrl = new AbortController();
    let caught: unknown = null;
    try {
      await handler.execute({ content: 'no slug' }, ctrl.signal);
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('slug required');
  });

  test('read-only base ops still work — search is in defs', () => {
    const reg = buildWriteCaptureRegistry(engine);
    const names = reg.defs.map((d) => d.name);
    expect(names).toContain('brain_search');
    expect(names).toContain('brain_get_page');
  });
});
