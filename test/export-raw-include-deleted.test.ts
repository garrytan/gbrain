/**
 * `gbrain export` reads each page's raw_data with `includeDeleted: true` —
 * the page list decides which rows export, raw follows its page. Pins the
 * opt-in against the engine-side soft-delete filter so a page the list
 * carries can never export with a silently vanished sidecar. Real PGLite;
 * the engine read is observed through an instance-level wrapper.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExport } from '../src/commands/export.ts';

let engine: PGLiteEngine;
let tmp: string;
let originalLog: typeof console.log;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-export-raw-'));
  originalLog = console.log;
  console.log = () => {};
});

afterEach(() => {
  console.log = originalLog;
  rmSync(tmp, { recursive: true, force: true });
});

describe('export — raw_data sidecar read', () => {
  test('getRawData is called with includeDeleted: true and the page source; the sidecar lands', async () => {
    await engine.putPage(
      'notes/alive',
      { type: 'note', title: 'alive', compiled_truth: 'body', timeline: '' },
      { sourceId: 'default' },
    );
    await engine.putRawData('notes/alive', 'feed', { k: 'v' }, { sourceId: 'default' });

    const seen: unknown[] = [];
    const real = engine.getRawData;
    (engine as unknown as { getRawData: unknown }).getRawData = async (
      slug: string, source: string | undefined, opts: unknown,
    ) => {
      seen.push({ slug, source, opts });
      return real.call(engine, slug, source, opts as never);
    };
    try {
      await runExport(engine, ['--dir', join(tmp, 'out')]);
    } finally {
      delete (engine as unknown as { getRawData?: unknown }).getRawData; // back to the prototype method
    }

    expect(seen).toContainEqual({
      slug: 'notes/alive',
      source: undefined,
      opts: { sourceId: 'default', includeDeleted: true },
    });
    const sidecar = join(tmp, 'out', 'notes', '.raw', 'alive.json');
    expect(existsSync(sidecar)).toBe(true);
    expect(JSON.parse(readFileSync(sidecar, 'utf-8'))).toEqual({ feed: { k: 'v' } });
  });
});
