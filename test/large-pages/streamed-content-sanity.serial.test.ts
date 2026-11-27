/**
 * Wave B PR 2 switch-on: content sanity of a streamed page (a file over the 24 MiB single-string ceiling).
 *
 * 1. Protects: with `pages.segmented_storage` on and `content_sanity.bytes_block` unset, the size rule of a segmented page is its page ceiling
 *    (`pages.max_bytes`), so a streamed page is chunked and keyword-searchable and its frontmatter gets no
 *    `embed_skip` / `content_flag: oversized`; the prose pass judges its head, middle and tail windows (a
 *    markup wall is flagged `markup_heavy` and stays searchable); an operator's lower bytes_block still
 *    soft-blocks it (`embed_skip`, chunked for keyword search, #6722); a bytes_block above the body size
 *    imports instead of holding the file.
 * 2. Fails when: the default block stays at 24 MiB, the prose pass holds the file or reads only its head.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { conversationBody } from '../helpers/conversation-page.ts';

const BYTES = PAGE_MAX_BYTES + 1024 * 1024;
let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('pages.segmented_storage', 'on');
  dir = mkdtempSync(join(tmpdir(), 'gbrain-streamed-sanity-'));
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
  await engine.unsetConfig('content_sanity.bytes_block');
});

async function imported(name: string, body: string) {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, `---\ntype: note\ntitle: ${name}\n---\n\n${body}\n`);
  const result = await importFromFile(engine, file, `notes/${name}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) });
  const [row] = await engine.executeRaw<{ body_storage: string; frontmatter: Record<string, unknown>; chunks: number }>(
    `SELECT p.body_storage, p.frontmatter, (SELECT count(*)::int FROM content_chunks c WHERE c.page_id=p.id) AS chunks FROM pages p WHERE p.slug=$1`, [`notes/${name}`]);
  return { result, row };
}

/** A body of `bytes` with a markup wall (HTML tags and table pipes, no prose) at its head, middle or tail. */
function markupAt(where: 'head' | 'middle' | 'tail', bytes: number): string {
  const wall = '<div class="nav"><span></span></div>\n| | | |\n'.repeat(4096);
  const prose = conversationBody(bytes - wall.length, { seed: 71 });
  const cut = where === 'head' ? 0 : where === 'tail' ? prose.length : prose.indexOf('\n\n', prose.length >> 1) + 2;
  return `${prose.slice(0, cut)}${wall}${prose.slice(cut)}`;
}

describe('content sanity of a streamed page', () => {
  test('bytes_block unset: the page ceiling is the size rule, so the page is chunked and its frontmatter is not stamped', async () => {
    const { result, row } = await imported('prose', conversationBody(BYTES, { seed: 72 }));
    expect(result.error ?? null).toBeNull();
    expect(result.status).toBe('imported');
    expect(row!.body_storage).toBe('segmented');
    expect(row!.frontmatter.embed_skip).toBeUndefined();
    expect(row!.frontmatter.content_flag).toBeUndefined();
    expect(row!.chunks).toBeGreaterThan(0);
  }, 300_000);

  test('the prose pass reads head, middle and tail windows: a markup wall in all three is flagged and stays searchable', async () => {
    const wall = '<div class="nav"><span></span></div>\n| | | |\n';
    const { result, row } = await imported('markup', wall.repeat(Math.ceil(BYTES / wall.length)));
    expect(result.status).toBe('imported');
    expect(row!.frontmatter.content_flag).toMatchObject({ reason: 'markup_heavy' });
    expect(row!.frontmatter.embed_skip).toBeUndefined();
    expect(row!.chunks).toBeGreaterThan(0);
    for (const where of ['head', 'middle', 'tail'] as const) {
      const one = await imported(`markup-${where}`, markupAt(where, BYTES));
      expect(one.result.status).toBe('imported');
      expect(one.row!.frontmatter.content_flag).toBeUndefined();
    }
  }, 600_000);

  test('an operator bytes_block below the page soft-blocks it; one above the page imports it', async () => {
    await engine.setConfig('content_sanity.bytes_block', String(PAGE_MAX_BYTES));
    const low = await imported('low-block', conversationBody(BYTES, { seed: 73 }));
    expect(low.result.status).toBe('imported');
    expect(low.row!.frontmatter.embed_skip).toMatchObject({ reason: 'oversized' });
    expect(low.row!.frontmatter.content_flag).toMatchObject({ reason: 'oversized' });
    expect(low.row!.chunks).toBeGreaterThan(0);

    await engine.setConfig('content_sanity.bytes_block', String(64 * 1024 * 1024));
    const high = await imported('high-block', conversationBody(BYTES, { seed: 74 }));
    expect(high.result.error ?? null).toBeNull();
    expect(high.result.status).toBe('imported');
    expect(high.row!.frontmatter.embed_skip).toBeUndefined();
    expect(high.row!.chunks).toBeGreaterThan(0);
  }, 600_000);
});
