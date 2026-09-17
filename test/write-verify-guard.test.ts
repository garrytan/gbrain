/** Readback failure must roll back the canonical write and surface a failed receipt. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { Page } from '../src/core/types.ts';

let engine: PGLiteEngine;
let root: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); resetGateway(); }, 60_000);
beforeEach(async () => {
  await resetPgliteState(engine); resetGateway();
  root = mkdtempSync(join(tmpdir(), 'gbrain-verify-')); const brain = join(root, 'brain'); mkdirSync(brain);
  await engine.setConfig('sync.repo_path', brain);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Preserve the dynamic receiver, including every transaction/savepoint clone. */
async function withBrokenReadback(slug: string, fault: 'missing' | 'stale', run: () => Promise<void>) {
  const originalPut = engine.putPage; const originalGet = engine.getPage;
  let written = false; let injected = false;
  engine.putPage = async function(this: PGLiteEngine, target, input, opts) {
    const page = await originalPut.call(this, target, input, opts);
    if (target === slug) written = true;
    return page;
  };
  engine.getPage = async function(this: PGLiteEngine, target, opts) {
    const page = await originalGet.call(this, target, opts);
    if (target !== slug || !written) return page;
    injected = true;
    return fault === 'missing' ? null : { ...page!, content_hash: 'synthetic-stale-hash' } as Page;
  };
  try { await run(); expect(injected).toBe(true); }
  finally { engine.putPage = originalPut; engine.getPage = originalGet; }
}

describe('post-write read-back verification', () => {
  test('normal write passes read-back and returns imported', async () => {
    const slug = 'inbox/verify-happy';
    const result = await importFromContent(engine, slug, '---\ntitle: Happy\n---\n\n# Body that round-trips', { noEmbed: true, sourceId: 'default' });
    expect(result.status).toBe('imported'); expect(result.slug).toBe(slug);
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.title).toBe('Happy');
  });

  test('a missing readback rolls back the newly written page', async () => {
    const slug = 'inbox/verify-desync';
    await withBrokenReadback(slug, 'missing', async () => {
      await expect(importFromContent(engine, slug, '---\ntitle: Missing\n---\n\n# Uncommitted body',
        { noEmbed: true, sourceId: 'default' })).rejects.toThrow(/post-write read-back failed/);
    });
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
  });

  test('a stale readback preserves the preceding canonical revision', async () => {
    const slug = 'inbox/verify-stale';
    await importFromContent(engine, slug, '---\ntitle: Before\n---\n\n# Original body', { noEmbed: true, sourceId: 'default' });
    const before = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    await withBrokenReadback(slug, 'stale', async () => {
      await expect(importFromContent(engine, slug, '---\ntitle: After\n---\n\n# Replacement body',
        { noEmbed: true, sourceId: 'default' })).rejects.toThrow(/stale content_hash/);
    });
    const after = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    expect(after?.revision).toBe(before?.revision); expect(after?.page.compiled_truth).toBe(before?.page.compiled_truth);
  });

  test('put_page exposes a failed receipt and leaves no canonical write', async () => {
    const slug = 'inbox/verify-operation';
    const ctx: OperationContext = { engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } };
    await withBrokenReadback(slug, 'missing', async () => {
      await expect(operationsByName.put_page.handler(ctx, { slug, content: '---\ntitle: Failed receipt\n---\n\n# Receipt body' }))
        .rejects.toMatchObject({ code: 'storage_error', writeRequest: { state: 'failed' } });
    });
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    const rows = await engine.executeRaw<{ state: string; error_code: string }>(
      'SELECT state,error_code FROM persistence_requests WHERE slug=$1', [slug]);
    expect(rows).toEqual([{ state: 'failed', error_code: 'storage_error' }]);
  });
});
