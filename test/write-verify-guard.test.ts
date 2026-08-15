/**
 * Post-write read-back verification tests.
 *
 * Reproduces the silent-desync case: a page write commits but the DB index
 * silently never picks it up. Without the guard, importFromContent reports
 * success. With the guard, it fails loudly (throws).
 *
 * Also verifies the happy path: a normal write passes read-back.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-verify-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('post-write read-back verification', () => {
  test('normal write passes read-back and returns imported', async () => {
    const slug = 'inbox/verify-happy';
    const content = '---\ntitle: Happy\n---\n\n# Body that should round-trip cleanly';
    const result = await importFromContent(engine, slug, content, {
      noEmbed: true,
      sourceId: 'default',
    });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe(slug);

    // The page is resolvable via getPage in the same operation.
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Happy');
  });

  test('silent desync (page on disk, absent from index) fails loudly', async () => {
    // Simulate the desync: write a page, then DELETE it from the DB
    // between the transaction and the read-back. In production, this
    // happens when the DB index silently fails to pick up the write
    // (e.g. a trigger dropped, a partition routing error, or an index
    // corruption). The guard must catch this and throw.
    //
    // We achieve this by wrapping the engine to intercept getPage
    // after the transaction and return null (simulating an index miss).

    const slug = 'inbox/verify-desync';
    const content = '---\ntitle: Desync\n---\n\n# Body that will be silently lost';

    // First, write the page normally to prove it works.
    const result1 = await importFromContent(engine, slug, content, {
      noEmbed: true,
      sourceId: 'default',
    });
    expect(result1.status).toBe('imported');

    // Now simulate the desync: delete the page from the DB, then
    // try to write it again. But this time, we intercept getPage
    // to return null after the write (simulating an index miss).
    //
    // We do this by monkey-patching the engine's getPage method
    // to return null for this specific slug on the NEXT call
    // (which is the read-back).
    await engine.executeRaw(`DELETE FROM pages WHERE slug = $1`, [slug]);
    // Verify the page is gone (simulating the index miss state).
    const gone = await engine.getPage(slug, { sourceId: 'default' });
    expect(gone).toBeNull();

    // Now write again, but intercept getPage to simulate the desync.
    // We need to intercept the read-back call specifically. Since
    // importFromContent calls getPage twice (once for existing check
    // at the top, once for read-back), we intercept the second call
    // for this specific slug.
    const slugCallCount = new Map<string, number>();
    const originalGetPage = engine.getPage.bind(engine);
    const interceptingGetPage = async (
      s: string,
      opts?: { sourceId?: string },
    ) => {
      const count = (slugCallCount.get(s) ?? 0) + 1;
      slugCallCount.set(s, count);
      // The first getPage call is the "existing" check at the top of
      // importFromContent (line 561). The second is the read-back.
      // We let the first call through (returning null since we deleted
      // the page), but intercept the read-back to return null.
      if (s === slug && count === 2) {
        return null; // Simulate index miss on read-back.
      }
      return originalGetPage(s, opts);
    };
    engine.getPage = interceptingGetPage as typeof engine.getPage;

    try {
      // This should throw — the read-back fails, so the write is not "done".
      await expect(
        importFromContent(engine, slug, content, {
          noEmbed: true,
          sourceId: 'default',
        }),
      ).rejects.toThrow(/post-write read-back failed/);
    } finally {
      // Restore the original getPage.
      engine.getPage = originalGetPage;
    }
  });

  test('stale content_hash fails loudly', async () => {
    // Simulate a stale hash: write a page, then corrupt the content_hash
    // before the read-back. The guard should detect the mismatch.
    const slug = 'inbox/verify-stale-hash';
    const content = '---\ntitle: Stale\n---\n\n# Body with stale hash';

    // Write the page normally first.
    await importFromContent(engine, slug, content, {
      noEmbed: true,
      sourceId: 'default',
    });

    // Corrupt the content_hash to simulate a stale row.
    await engine.executeRaw(
      `UPDATE pages SET content_hash = $1 WHERE slug = $2`,
      ['stale-hash-value-that-does-not-match', slug],
    );

    // Now try to write again. The existing check will find the page
    // (with the stale hash), so it won't be skipped. The write will
    // commit, but the read-back should detect the stale hash...
    // except wait — the write will UPDATE the hash, so the read-back
    // will see the NEW hash. We need to intercept getPage to return
    // the stale hash instead.
    const slugCallCount = new Map<string, number>();
    const originalGetPage = engine.getPage.bind(engine);
    const stalePage = await originalGetPage(slug, { sourceId: 'default' });

    // Write the stale hash back so the existing check sees a mismatch.
    await engine.executeRaw(
      `UPDATE pages SET content_hash = $1 WHERE slug = $2`,
      ['stale-hash-value-that-does-not-match', slug],
    );

    const interceptingGetPage = async (
      s: string,
      opts?: { sourceId?: string },
    ) => {
      const count = (slugCallCount.get(s) ?? 0) + 1;
      slugCallCount.set(s, count);
      // The read-back call (second getPage for this slug) returns the
      // stale page with the old hash.
      if (s === slug && count === 2 && stalePage) {
        return { ...stalePage, content_hash: 'stale-hash-value-that-does-not-match' };
      }
      return originalGetPage(s, opts);
    };
    engine.getPage = interceptingGetPage as typeof engine.getPage;

    try {
      await expect(
        importFromContent(engine, slug, content, {
          noEmbed: true,
          sourceId: 'default',
        }),
      ).rejects.toThrow(/stale content_hash/);
    } finally {
      engine.getPage = originalGetPage;
    }
  });

  test('put_page operation surfaces read-back failure to the caller', async () => {
    // Verify that the put_page MCP operation also surfaces the read-back
    // failure (not just importFromContent directly). This is the path
    // agents actually call.
    const putPage = operations.find((o) => o.name === 'put_page')!;
    const slug = 'inbox/verify-putpage-desync';
    const content = '---\ntitle: Desync\n---\n\n# Body that will be silently lost';

    // Intercept getPage to simulate index miss on the read-back.
    // Use a slug-specific counter to avoid interference from other tests
    // that might call getPage on the same engine.
    //
    // The put_page handler calls getPage via importFromContent, which makes
    // two getPage calls for this slug:
    //   1. importFromContent's existing-page check
    //   2. verifyPageReadable's read-back (the one we intercept)
    const slugCallCount = new Map<string, number>();
    const originalGetPage = engine.getPage.bind(engine);
    const interceptingGetPage = async (
      s: string,
      opts?: { sourceId?: string },
    ) => {
      const count = (slugCallCount.get(s) ?? 0) + 1;
      slugCallCount.set(s, count);
      // Intercept the read-back call (callCount == 2 for this slug).
      if (s === slug && count === 2) {
        return null;
      }
      return originalGetPage(s, opts);
    };
    engine.getPage = interceptingGetPage as typeof engine.getPage;

    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      agentIdentity: { name: 'Test Agent', email: 'test-agent@example.com' },
    } as OperationContext;

    try {
      await expect(
        putPage.handler(ctx, { slug, content }),
      ).rejects.toThrow(/post-write read-back failed/);
    } finally {
      engine.getPage = originalGetPage;
    }
  });
});
