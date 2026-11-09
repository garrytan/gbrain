/**
 * #7052 — a tag longer than the btree indexes on `tags` store is refused at the
 * write boundary as `tag_too_long` (put_page, add_tag, file import, the shared
 * content screen sync uses) instead of failing the insert with error 54000 and
 * reporting `storage_error`. The bound counts UTF-8 bytes, so multibyte tags
 * are measured as stored; a tag exactly at the bound stores.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { classifyImportHold, parseMarkdown } from '../src/core/markdown.ts';
import { TAG_MAX_BYTES } from '../src/core/tag-limit.ts';
import { contentRefusalFromReceipt, isContentRefusal, screenImportContent } from '../src/core/import-screen.ts';
import { importFromFile } from '../src/core/import-file.ts';

const config = { engine: 'pglite' } as never;
const LOCAL = { remote: false, sourceId: 'default', config };
const REMOTE = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config };

/** `bytes` of incompressible text: random 3-byte CJK characters, padded with ASCII letters. */
function randomTag(bytes: number): string {
  let tag = '';
  while (Buffer.byteLength(tag) + 3 <= bytes) tag += String.fromCodePoint(0x4e00 + randomInt(0x5000));
  while (Buffer.byteLength(tag) < bytes) tag += String.fromCharCode(97 + randomInt(26));
  return tag;
}
const page = (tags: string[]) => `---\ntitle: Tagged\ntags: [${tags.map(t => JSON.stringify(t)).join(', ')}]\n---\n\nBody text.\n`;

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-7052-'));
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

async function call(op: string, args: Record<string, unknown>, ctx: Record<string, unknown>) {
  const r = await dispatchToolCall(engine, op, args, ctx as never);
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) as Record<string, unknown> };
}

describe('#7052 tag byte limit', () => {
  test('the bound is the real one: an incompressible tag at the bound stores, one byte over fails the index', async () => {
    await engine.putPage('notes/bound', { type: 'note', title: 'Bound', compiled_truth: 'x', frontmatter: {} }, { sourceId: 'default' });
    const atLimit = randomTag(TAG_MAX_BYTES);
    expect(Buffer.byteLength(atLimit)).toBe(TAG_MAX_BYTES);
    await engine.addTag('notes/bound', atLimit, { sourceId: 'default' });
    expect(await engine.getTags('notes/bound', { sourceId: 'default' })).toEqual([atLimit]);
    await expect(engine.addTag('notes/bound', randomTag(TAG_MAX_BYTES + 1), { sourceId: 'default' })).rejects.toThrow(/index row size/);
  });

  test('the shared screen holds a tag over the bound by its byte length, naming position and size but not the text', () => {
    const over = randomTag(TAG_MAX_BYTES + 1);
    expect(over.length).toBeLessThan(TAG_MAX_BYTES);
    expect(classifyImportHold(parseMarkdown(page(['ok', randomTag(TAG_MAX_BYTES)]), 'notes/a.md', { validate: true }))).toBeNull();
    const hold = classifyImportHold(parseMarkdown(page(['ok', over]), 'notes/a.md', { validate: true }))!;
    expect(hold).toEqual(expect.objectContaining({ code: 'tag_too_long', key: 'tags' }));
    expect(hold.message).toContain(`Tag 2 of 2 is ${TAG_MAX_BYTES + 1} bytes`);
    expect(hold.message).not.toContain(over.slice(0, 20));
    const screen = screenImportContent({ content: page([over]), path: 'notes/a.md', expectedSlug: 'notes/a' });
    expect(screen).toEqual({ status: 'refused', refusal: expect.objectContaining({ code: 'tag_too_long' }) });
    expect(isContentRefusal('invalid_params', hold.message)).toBe(true);
    expect(contentRefusalFromReceipt('invalid_params', hold.message)?.code).toBe('tag_too_long');
  });

  test('put_page refuses tag_too_long for local and remote callers and writes nothing', async () => {
    for (const [i, ctx] of [LOCAL, REMOTE].entries()) {
      const slug = `notes/put-${i}`;
      const r = await call('put_page', { slug, content: page(['ok', randomTag(3200)]) }, ctx);
      expect(r.isError).toBe(true);
      expect(r.body.code).toBe('tag_too_long');
      expect(String(r.body.suggestion)).toContain('Shorten that tag');
      expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    }
  });

  test('add_tag refuses tag_too_long and leaves the page\'s tags as they were', async () => {
    expect((await call('put_page', { slug: 'notes/add', content: page(['ok']) }, LOCAL)).isError).toBe(false);
    const r = await call('add_tag', { slug: 'notes/add', tag: randomTag(3200) }, REMOTE);
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe('tag_too_long');
    expect(await engine.getTags('notes/add', { sourceId: 'default' })).toEqual(['ok']);
  });

  test('a file import skips the file as tag_too_long instead of failing the insert', async () => {
    const file = join(dir, 'imported.md');
    writeFileSync(file, page([randomTag(3200)]));
    const result = await importFromFile(engine, file, 'notes/imported.md', { noEmbed: true } as never);
    expect(result).toEqual(expect.objectContaining({ status: 'skipped', skip_reason: 'tag_too_long', refusal: expect.objectContaining({ code: 'tag_too_long' }) }));
    expect(await engine.getPage('notes/imported', { sourceId: 'default' })).toBeNull();
  });
});
