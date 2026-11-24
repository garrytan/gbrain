/**
 * A page whose body is stored in segments (a large conversation page) must not stop gbrain dedupe classes or sample:
 * a chat page is read through the segment-aware conversation reader, and a page that reader cannot read is set aside
 * and counted, while the other pages are still classified. A person page stored in segments is read by its keys, as
 * any other, in classes, sample, the finder preview and the confirm list.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import * as conversationBody from '../src/core/conversation-parser/body.ts';
import { opError } from '../src/core/ops/contract.ts';

const MB = 1024 * 1024;
let home: string;
let engine: BrainEngine;

const person = (slug: string, title: string, frontmatter: Record<string, unknown>, sourceId = 'default') =>
  engine.putPage(slug, { type: 'person', title, compiled_truth: `${title} notes.`, timeline: '', frontmatter } as never, { sourceId } as never);

function largeChat(): string {
  const lines = Array.from({ length: Math.ceil((1.5 * MB) / 60) }, (_, i) => `**Alice Example** (2026-01-02 9:${String(i % 60).padStart(2, '0')} AM): line ${i}`);
  return ['---', 'title: Big chat 2026-01-02', 'type: imessage', 'date: 2026-01-02', 'imessage_chat: chat-big', 'group: false', 'visibility: private', '---', '# Big chat', '', ...lines, '**Me** (2026-01-02 9:05 AM): hi', ''].join('\n');
}

async function dedupe(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runDedupe(engine, args); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-dedupe-segmented-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('people-b','people-b') ON CONFLICT DO NOTHING");
  await engine.setConfig('pages.segmented_storage', 'on');
  await person('people/alice-example', 'Alice Example', { email: 'alice@example.invalid' });
  await person('people/alice-example', 'Alice Example', { emails: ['alice@example.invalid'] }, 'people-b');
  const bigNotes = Array.from({ length: Math.ceil((2 * MB) / 24) }, (_, i) => `Meeting note ${String(i).padStart(8, '0')}.`).join('\n\n');
  expect((await importFromContent(engine, 'people/bob-example', `---\ntitle: Bob Example\ntype: person\nemail: bob@example.invalid\n---\n${bigNotes}\n`, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
  await person('people/bob-example', 'Bob Example', { email: 'bob@example.invalid' }, 'people-b');
  expect((await importFromContent(engine, 'imessage/chat-big/2026-01-02', largeChat(), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
  const rows = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE body_storage='segmented' ORDER BY slug");
  expect(rows.map(r => r.slug)).toEqual(['imessage/chat-big/2026-01-02', 'people/bob-example']);
}, 300_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

describe('gbrain dedupe classes with a page stored in segments', () => {
  test('classes completes, reads the segmented chat page whole and classifies the other pages', async () => {
    const report = JSON.parse(await dedupe(['classes', '--json']));
    expect(report.pairs).toBe(2);
    expect(report.classes.C1).toBe(2);
    expect(report.messaging.pages).toBe(1);
    expect(report.messaging.segmented_page).toEqual({ read: 1, set_aside: 0, pages: [] });
    expect(await dedupe(['classes'])).toContain('chat pages stored in segments: 1 read whole, 0 set aside');
  }, 300_000);

  test('sample completes too', async () => {
    const report = JSON.parse(await dedupe(['sample', '--class', 'C1', '--n', '5', '--json']));
    expect(report.pairs.length).toBe(2);
  }, 300_000);

  test('the duplicate finder preview and the confirm list read a person page stored in segments', async () => {
    const preview = await dedupe(['--preview', '--json']);
    expect(preview).toContain('people/bob-example');
    expect(await dedupe(['confirm'])).toContain('bob-example');
  }, 300_000);

  test('a chat page stored in segments that only a window of can be read, or whose read fails, is set aside and listed; the run goes on', async () => {
    for (const fake of [
      async () => ({ body: '', window: { totalBytes: 30 * MB, fallbackDate: null } }),
      async () => { throw opError('page_body_segmented', 'stored in segments', 'read it in pieces'); },
      async () => { throw new Error('Page 1 is not a segmented page.'); },
    ]) {
      const spy = spyOn(conversationBody, 'readConversationInput').mockImplementation(fake as never);
      try {
        const report = JSON.parse(await dedupe(['classes', '--json']));
        expect(report.classes.C1).toBe(2);
        expect(report.messaging.pages).toBe(0);
        expect(report.messaging.segmented_page).toEqual({ read: 0, set_aside: 1, pages: [{ source_id: 'default', slug: 'imessage/chat-big/2026-01-02' }] });
        expect(await dedupe(['classes'])).toContain('1 set aside (over 24 MiB or not readable as one body; their chats add no evidence): default:imessage/chat-big/2026-01-02');
      } finally { spy.mockRestore(); }
    }
  }, 300_000);
});
