/**
 * Regression: MCP file_upload must use the connected OperationContext engine.
 *
 * A long-running `gbrain serve` owns the PGLite connection. The handler must not
 * reach for the module-global db singleton, which is intentionally uninitialized
 * in the MCP dispatch path and throws "connect() has not been called".
 *
 * #4302: file_upload is now fail-closed on storage — with no backend it
 * refuses BEFORE inserting a row (the old path recorded a phantom upload).
 * This suite therefore runs against a real `local` backend in a sandboxed
 * GBRAIN_HOME, and pins the no-backend refusal explicitly.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let fixtureDir: string;
let sandboxHome: string;
let storageDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Remote MCP uploads are intentionally confined to the server working tree.
  fixtureDir = mkdtempSync(join(process.cwd(), '.file-upload-engine-context-'));

  // #4302: dispatch reads ctx.config via loadConfig() → $GBRAIN_HOME/.gbrain/
  // config.json. Point GBRAIN_HOME at a sandbox carrying a `local` storage
  // backend so uploads land in a real (temp) backend.
  sandboxHome = mkdtempSync(join(tmpdir(), 'gb-fuec-home-'));
  storageDir = mkdtempSync(join(tmpdir(), 'gb-fuec-storage-'));
  mkdirSync(join(sandboxHome, '.gbrain'), { recursive: true });
  writeFileSync(
    join(sandboxHome, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      storage: { backend: 'local', bucket: 'test-bucket', localPath: storageDir },
    }),
  );
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const d of [fixtureDir, sandboxHome, storageDir]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('file_upload engine ownership', () => {
  test('uses the MCP context engine instead of the module-global DB singleton', async () => {
    await withEnv({ GBRAIN_HOME: sandboxHome }, async () => {
    const fixture = join(fixtureDir, 'capture.json');
    writeFileSync(fixture, '{"source":"camofox"}\n');

    // WP1/D7: file_upload is localOnly — the dispatch backstop only admits
    // the stdio local pipe. This test is about ENGINE ownership, so dispatch
    // as the local surface (transport policy is pinned in
    // test/dispatch-localonly.test.ts).
    const result = await dispatchToolCall(engine, 'file_upload', {
      path: fixture,
      page_slug: 'concepts/example-board',
    }, { remote: true, transport: 'stdio', sourceId: 'default' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: 'uploaded',
      storage_path: 'concepts/example-board/capture.json',
      size_bytes: 21,
    });

    // #4302: the bytes actually landed in the backend.
    expect(existsSync(join(storageDir, 'concepts/example-board/capture.json'))).toBe(true);

    const listed = await dispatchToolCall(engine, 'file_list', {
      slug: 'concepts/example-board',
    }, { remote: true, transport: 'stdio', sourceId: 'default' });
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(listed.content[0].text)).toEqual([
      expect.objectContaining({
        page_slug: 'concepts/example-board',
        storage_path: 'concepts/example-board/capture.json',
      }),
    ]);

    // #4302: file_url now resolves through the backend (exists + getUrl),
    // not the old `gbrain:files/<path>` placeholder that pointed at nothing.
    const url = await dispatchToolCall(engine, 'file_url', {
      storage_path: 'concepts/example-board/capture.json',
    }, { remote: true, transport: 'stdio', sourceId: 'default' });
    expect(url.isError).toBeFalsy();
    const parsed = JSON.parse(url.content[0].text) as { storage_path: string; url: string };
    expect(parsed.storage_path).toBe('concepts/example-board/capture.json');
    // LocalStorage canonicalizes its base (macOS /var → /private/var).
    expect(parsed.url).toBe(`file://${join(realpathSync(storageDir), 'concepts/example-board/capture.json')}`);
    });
  });
});
