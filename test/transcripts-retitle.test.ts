/**
 * A retitled conversation (ChatGPT/Claude rename, or Claude.ai naming a
 * thread after its first exchange) keeps its existing page and slug, and the
 * messages added since the last import land. Real PGLite, no provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';

let engine: PGLiteEngine;
let dir: string;

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
  dir = mkdtempSync(join(tmpdir(), 'gb-retitle-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

function exportFile(name: string, title: string, grown: boolean): string {
  const message = (role: string, t: number, text: string) => ({ author: { role }, create_time: t, content: { content_type: 'text', parts: [text] } });
  const mapping: Record<string, unknown> = {
    root: { id: 'root', parent: null, children: ['n1'], message: null },
    n1: { id: 'n1', parent: 'root', children: ['n2'], message: message('user', 1786080005, 'First question about acme-example.') },
    n2: { id: 'n2', parent: 'n1', children: grown ? ['n3'] : [], message: message('assistant', 1786080015, 'First answer.') },
  };
  if (grown) {
    mapping.n3 = { id: 'n3', parent: 'n2', children: ['n4'], message: message('user', 1786090005, 'FOLLOWUP-MARKER new question') };
    mapping.n4 = { id: 'n4', parent: 'n3', children: [], message: message('assistant', 1786090015, 'Follow-up answer.') };
  }
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify([{ title, create_time: 1786080000, update_time: grown ? 1786090015 : 1786080015,
    conversation_id: 'cgpt-retitle-1', current_node: grown ? 'n4' : 'n2', mapping }]));
  return path;
}

async function livePages(): Promise<Array<{ slug: string; title: string; has_new: boolean }>> {
  return engine.executeRaw(`SELECT slug, title, compiled_truth LIKE '%FOLLOWUP-MARKER%' AS has_new
    FROM pages WHERE deleted_at IS NULL AND slug LIKE 'conversations/%' ORDER BY slug`);
}

describe('retitled conversation', () => {
  test('rename + new messages update the existing page in place', async () => {
    await runTranscriptsIngest(engine, { paths: [exportFile('a.json', 'Original title', false)], sourceId: 'default', format: 'chatgpt' });
    const [first] = await livePages();
    expect(first.slug).toContain('original-title');

    const second = await runTranscriptsIngest(engine, { paths: [exportFile('b.json', 'Renamed by user', true)], sourceId: 'default', format: 'chatgpt' });

    expect(second.pages.imported).toBe(1);
    expect(second.pages.skipped).toBe(0);
    const pages = await livePages();
    expect(pages).toHaveLength(1);
    expect(pages[0].slug).toBe(first.slug);
    expect(pages[0].has_new).toBe(true);
    expect(pages[0].title).toBe('Renamed by user');
  });

  test('re-importing the renamed export after the update is a clean skip', async () => {
    await runTranscriptsIngest(engine, { paths: [exportFile('a.json', 'Original title', false)], sourceId: 'default', format: 'chatgpt' });
    const b = exportFile('b.json', 'Renamed by user', true);
    await runTranscriptsIngest(engine, { paths: [b], sourceId: 'default', format: 'chatgpt' });
    const again = await runTranscriptsIngest(engine, { paths: [b], sourceId: 'default', format: 'chatgpt' });
    expect(again.pages).toMatchObject({ imported: 0, skipped: 1 });
    expect(await livePages()).toHaveLength(1);
  });
});
