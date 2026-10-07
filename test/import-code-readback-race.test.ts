/**
 * #6011: importCodeFile verified its write by reading the page back after its transaction committed, so a
 * concurrent writer committing in between failed an import that had committed ("post-write read-back
 * failed ... silent desync"). The read-back now runs inside the import's transaction, as the markdown path's
 * does. Classic (unmanaged) PGLite brain; the competing writer commits right after the import's transaction.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('a write that commits right after the import transaction does not fail the committed code import', async () => {
  const slug = 'src-a-ts';
  let raced = false;
  const racing = new Proxy(engine, { get(target, key) {
    if (key === 'transaction') return async <T>(fn: (tx: BrainEngine) => Promise<T>) => {
      const result = await target.transaction(fn);
      if (!raced && await target.getPage(slug, { sourceId: 'default' })) {
        raced = true;
        await target.executeRaw("UPDATE pages SET content_hash='competing-writer', compiled_truth='// changed by another writer' WHERE slug=$1 AND source_id='default'", [slug]);
      }
      return result;
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
  const result = await importCodeFile(racing, 'src/a.ts', 'export const a = 1;\n', { noEmbed: true });
  expect(raced).toBe(true);
  expect(result).toMatchObject({ slug, status: 'imported' });
});
