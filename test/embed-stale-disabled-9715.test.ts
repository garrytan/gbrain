/**
 * #9715: embedStalePages must not embed when embedding_disabled is set
 * (DB plane), regardless of the caller's own availability guard.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { embedStalePages } from '../src/core/embed-stale.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

test('embedStalePages sends nothing while embedding_disabled is true', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-9715-'));
  await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
    await engine.putPage('notes/a', { type: 'note', title: 'a', compiled_truth: '# a\n\nbody' });
    await installFixtureChunks(engine, 'notes/a', [{ chunk_index: 0, chunk_text: 'chunk of a', chunk_source: 'compiled_truth', token_count: 4, embedding: undefined }]);
    await engine.setConfig('embedding_disabled', 'true');
    let calls = 0;
    const result = await embedStalePages(engine, ['notes/a'], 'default', {
      embedFn: async (texts) => { calls++; return texts.map(() => { const v = new Float32Array(1536); v[0] = 1; return v; }); },
    });
    expect(calls).toBe(0);
    expect(result.embedded).toBe(0);
  });
});
