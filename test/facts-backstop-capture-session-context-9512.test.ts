import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsPipeline } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'capture-session-ctx-'));
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [dir]);
  await engine.setConfig('sync.write_through', 'true');
  await engine.setConfig('memory.auto_writeback', 'salient');
  _resetWriteThroughCacheForTest();
  mkdirSync(join(dir, 'people'));
  for (const slug of ['people/ann-example', 'people/bob-example']) {
    await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: '# ' + slug, frontmatter: {} }, { sourceId: 'default' });
    writeFileSync(join(dir, `${slug}.md`), `---\ntype: person\ntitle: ${slug}\n---\n# ${slug}\n`);
  }
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
  _resetWriteThroughCacheForTest();
});

async function capture(source: string, sessionId: string, entity: string): Promise<string | null> {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: [{ fact: `${entity} shipped the capture fix`, kind: 'fact', entity, confidence: 1.0, notability: 'high' }] }),
    blocks: [], stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub', providerId: 'test',
  }));
  const r = await runFactsPipeline('A conversation turn about the capture fix', { engine, sourceId: 'default', sessionId, source });
  expect(r.inserted).toBe(1);
  const rows = await engine.executeRaw<{ context: string | null; row_num: number | null }>(
    `SELECT context, row_num FROM facts WHERE id = $1`, [r.fact_ids[0]]);
  return rows[0].context;
}

describe('#9512 capture-lane fence context names the session', () => {
  test('hook lane: short harness session id', async () => {
    expect(await capture('hook:writeback', 'abcdef12-3456-7890-aaaa-bbbbbbbbbbbb', 'people/ann-example')).toBe('session abcdef12');
  });

  test('sweep lane: harness id from the corpus file name, not the sweep: prefix', async () => {
    expect(await capture('sweep:corpus', 'sweep:corpus:/x/12345678-aaaa-bbbb-cccc-dddddddddddd.txt', 'people/bob-example')).toBe('session 12345678');
  });
});
