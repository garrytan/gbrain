// Write-path audit C-14: atoms follow their source.
//  - An undated source page dates its atoms by the page's creation date, not
//    the run date, so re-extraction on a later day upserts the same slugs.
//  - Re-extracting an edited source retires the atoms the previous
//    extraction produced and the new one did not (LLM-chosen titles drift),
//    so live atoms per source stay flat instead of piling up.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
}, 60_000);

function chatWithTitles(titles: string[]): (o: ChatOpts) => Promise<ChatResult> {
  const text = JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `Body for ${title}.` })));
  return async (o: ChatOpts) => ({
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: o.model ?? 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  });
}

async function liveAtoms(where: string, param: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE type = 'atom' AND deleted_at IS NULL AND ${where} ORDER BY slug`, [param]);
  return rows.map(r => r.slug);
}

const body = (n: number) => `Detailed notes about a careful operator and the lessons drawn, revision ${n}. `.repeat(20);

describe('extract_atoms reconciles atoms with their source (C-14)', () => {
  test('an undated page dates its atoms by creation date and an edit retires stale atoms', async () => {
    const slug = 'meetings/frank-example';
    const write = (n: number) => importFromContent(engine, slug, `---\ntype: meeting\ntitle: Frank sync\n---\n${body(n)}`, { noEmbed: true, sourceId: 'default' });
    await write(1);
    await engine.executeRaw(`UPDATE pages SET created_at = '2025-01-02T12:00:00Z' WHERE slug = $1`, [slug]);

    await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: chatWithTitles(['Patience compounds', 'Hire slowly']) });
    const first = await liveAtoms(`frontmatter->>'source_slug' = $1`, slug);
    expect(first).toHaveLength(2);
    for (const atom of first) expect(atom.startsWith('atoms/2025-01-02/')).toBe(true);

    await write(2);
    await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: chatWithTitles(['Patience compounds over years', 'Hire slowly']) });
    const second = await liveAtoms(`frontmatter->>'source_slug' = $1`, slug);
    expect(second).toHaveLength(2);
    expect(second.some(s => s.includes('/patience-compounds-over-years-'))).toBe(true);
    expect(second.some(s => /\/patience-compounds-[0-9a-f]+$/.test(s))).toBe(false);
  }, 60_000);

  test('a re-extracted transcript retires atoms its new extraction dropped', async () => {
    const filePath = '/corpus/2026-05-01-standup.txt';
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath, content: 'v1', contentHash: 'a'.repeat(64) }], _pages: [],
      _chat: chatWithTitles(['Ship smaller', 'Measure first']),
    });
    expect(await liveAtoms(`frontmatter->>'source_path' = $1`, filePath)).toHaveLength(2);
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath, content: 'v2', contentHash: 'b'.repeat(64) }], _pages: [],
      _chat: chatWithTitles(['Ship smaller']),
    });
    const live = await liveAtoms(`frontmatter->>'source_path' = $1`, filePath);
    expect(live).toHaveLength(1);
    expect(live[0]).toContain('/ship-smaller-');
  }, 60_000);

  test('an undated transcript gets a stable date segment instead of the run date', async () => {
    const filePath = '/corpus/standup-notes.txt';
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath, content: 'v1', contentHash: 'c'.repeat(64) }], _pages: [],
      _chat: chatWithTitles(['Keep a changelog']),
    });
    expect(await liveAtoms(`frontmatter->>'source_path' = $1`, filePath)).toEqual([expect.stringMatching(/^atoms\/undated\/keep-a-changelog-/)]);
  }, 60_000);
});
