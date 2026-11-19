/**
 * The streamed import and the segmented re-chunk write through typed engine members, not raw SQL.
 *
 * 1. Protects: a streamed re-import that drops a frontmatter tag prunes it through `pruneFrontmatterTags`, and the
 *    re-chunk stamps the page's chunker version through `setChunkerVersion`. Both members have parity cases on all
 *    three arms (test/engine-parity/import-writes.test.ts), so these two callers now run on any engine that serves them.
 * 2. Fails when: either caller sends its statement through `executeRaw` again (the Rust engine refuses raw SQL).
 * PGLite only: a transaction engine inherits the instance's spies (`Object.create`); the members' own arms are the parity cases.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { importStreamedMarkdownFile } from '../../src/core/page-body/streamed-import.ts';
import { runSegmentedRechunk } from '../../src/core/page-body/rechunk.ts';
import { SEGMENTED_CHUNKER_VERSION } from '../../src/core/page-body/segment-chunks.ts';
import { conversationBody } from '../helpers/conversation-page.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('pages.segmented_storage', 'on');
  dir = mkdtempSync(join(tmpdir(), 'gbrain-segmented-typed-writes-'));
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

/** Records every raw statement and every call of `member` while `run` runs, on the engine and its transaction engines. */
async function spied<T>(member: 'pruneFrontmatterTags' | 'setChunkerVersion', run: () => Promise<T>) {
  const raw: string[] = [];
  const calls: unknown[][] = [];
  const target = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
  const executeRaw = target.executeRaw!;
  const typed = target[member]!;
  target.executeRaw = function (this: unknown, ...args: unknown[]) { raw.push(String(args[0])); return executeRaw.apply(this, args); };
  target[member] = function (this: unknown, ...args: unknown[]) { calls.push(args); return typed.apply(this, args); };
  try { return { result: await run(), raw, calls }; }
  finally { delete target.executeRaw; delete target[member]; }
}

async function streamed(slug: string, tags: string[], body: string) {
  const file = join(dir, `${slug.replace('/', '-')}.md`);
  writeFileSync(file, `---\ntype: note\ntitle: ${slug}\ntags: [${tags.join(', ')}]\n---\n\n${body}\n`);
  const stat = statSync(file);
  return importStreamedMarkdownFile(engine, file, `${slug}.md`, { noEmbed: true }, stat, await readPageBodyPolicy(engine));
}

test('a streamed re-import prunes the frontmatter tag it dropped through pruneFrontmatterTags', async () => {
  const body = conversationBody(64 * 1024, { seed: 5 });
  expect((await streamed('notes/tagged', ['alpha', 'beta'], body)).status).toBe('imported');
  expect((await engine.getTags('notes/tagged')).sort()).toEqual(['alpha', 'beta']);
  const { result, raw, calls } = await spied('pruneFrontmatterTags', () => streamed('notes/tagged', ['alpha'], body));
  expect(result.status).toBe('imported');
  expect(await engine.getTags('notes/tagged')).toEqual(['alpha']);
  expect(calls).toEqual([['notes/tagged', ['alpha'], { sourceId: 'default' }]]);
  expect(raw.filter(sql => sql.includes('DELETE FROM tags'))).toEqual([]);
}, 120_000);

test('the segmented re-chunk stamps the chunker version through setChunkerVersion', async () => {
  expect((await streamed('notes/rechunk', [], conversationBody(64 * 1024, { seed: 9 }))).status).toBe('imported');
  const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug='notes/rechunk'");
  await engine.executeRaw('UPDATE pages SET chunker_version=4 WHERE id=$1', [page!.id]);
  const { result, raw, calls } = await spied('setChunkerVersion', () => runSegmentedRechunk(engine, { apply: true, slug: 'notes/rechunk' }));
  expect(result.pages.map(p => [p.slug, p.state])).toEqual([['notes/rechunk', expect.stringMatching(/^(rechunked|stamped)$/)]]);
  expect(calls).toEqual([['notes/rechunk', SEGMENTED_CHUNKER_VERSION, { sourceId: 'default' }]]);
  expect(raw.filter(sql => /SET chunker_version/.test(sql))).toEqual([]);
  const [after] = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages WHERE id=$1', [page!.id]);
  expect(after!.chunker_version).toBe(SEGMENTED_CHUNKER_VERSION);
}, 120_000);
