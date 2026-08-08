/**
 * Regression: MCP file_upload must use the connected OperationContext engine.
 *
 * A long-running `gbrain serve` owns the PGLite connection. The handler must not
 * reach for the module-global db singleton, which is intentionally uninitialized
 * in the MCP dispatch path and throws "connect() has not been called".
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
let fixtureDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Remote MCP uploads are intentionally confined to the server working tree.
  fixtureDir = mkdtempSync(join(process.cwd(), '.file-upload-engine-context-'));
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe('file_upload engine ownership', () => {
  test('uses the MCP context engine instead of the module-global DB singleton', async () => {
    const fixture = join(fixtureDir, 'capture.json');
    writeFileSync(fixture, '{"source":"camofox"}\n');

    const result = await dispatchToolCall(engine, 'file_upload', {
      path: fixture,
      page_slug: 'concepts/hermes-kanban',
    }, { remote: true, sourceId: 'default' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: 'uploaded',
      storage_path: 'concepts/hermes-kanban/capture.json',
      size_bytes: 21,
    });

    const listed = await dispatchToolCall(engine, 'file_list', {
      slug: 'concepts/hermes-kanban',
    }, { remote: true, sourceId: 'default' });
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(listed.content[0].text)).toEqual([
      expect.objectContaining({
        page_slug: 'concepts/hermes-kanban',
        storage_path: 'concepts/hermes-kanban/capture.json',
      }),
    ]);

    const url = await dispatchToolCall(engine, 'file_url', {
      storage_path: 'concepts/hermes-kanban/capture.json',
    }, { remote: true, sourceId: 'default' });
    expect(url.isError).toBeFalsy();
    expect(JSON.parse(url.content[0].text)).toEqual({
      storage_path: 'concepts/hermes-kanban/capture.json',
      url: 'gbrain:files/concepts/hermes-kanban/capture.json',
    });
  });
});
