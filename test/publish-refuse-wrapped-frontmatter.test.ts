/**
 * gbrain publish recognized frontmatter only when it opened the file, so any text printed above it (the quote fence a
 * thin client's paged `gbrain get` prints, or any other wrapper line) put every frontmatter line into the shared page.
 * Publish now refuses with invalid_frontmatter when a column-0 frontmatter fence pair starts in the file's first five
 * non-blank lines without opening it. A plain --- pair counts only with a YAML key line between the fences, so an
 * early horizontal rule still publishes.
 */
import { describe, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeShareable, runPublish } from '../src/commands/publish.ts';
import { printPagedPage } from '../src/cli/page-render.ts';
import { fenceTranscriptText } from '../src/core/search/transcript-quote.ts';
import { escapeGuestLabel, guestQuoteLabel, guestWarningLine, type GuestStamp } from '../src/core/guests/marker.ts';

const SLUG = 'notes/large-note';
const FRONTMATTER = '---\ntype: note\ntitle: A note\nprivate: alice-example\n---\n';
const BODY = '# A note\n\nThe offsite moved to Friday.\n';
const GUEST: GuestStamp = { sender: 'Bob Example', group: 'team-a', audience_member: 'alice-example', saved_at: '2026-11-13', promoted: false };
const invalid = expect.objectContaining({ code: 'invalid_frontmatter' });

async function pagedGet(markdown: string): Promise<string> {
  const windows = [markdown.slice(0, 40), markdown.slice(40)];
  const size = { total_bytes: Buffer.byteLength(markdown), sha256: createHash('sha256').update(markdown).digest('hex') };
  const host = async (p: Record<string, unknown>) => {
    const i = p.cursor === undefined ? 0 : Number(p.cursor);
    return { slug: SLUG, revision: 'rev-1', quoted: 'transcript', size, window: { byte_start: 0, text: fenceTranscriptText(windows[i]!, SLUG) },
      ...(i === 0 ? { next_cursor: '1' } : {}) };
  };
  let out = '';
  await printPagedPage(host as never, { slug: SLUG }, async text => { out += text; });
  return out;
}

async function publishFile(text: string): Promise<{ html: string | null; error: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), 'publish-wrapped-'));
  try {
    const page = join(dir, 'page.md');
    const out = join(dir, 'page.html');
    writeFileSync(page, text);
    const log = console.log;
    console.log = () => {};
    let error: unknown = null;
    try { await runPublish([page, '--out', out]); } catch (e) { error = e; } finally { console.log = log; }
    return { html: existsSync(out) ? readFileSync(out, 'utf8') : null, error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('gbrain publish refuses frontmatter wrapped in other text', () => {
  test('the thin client paged gbrain get output, saved and published, is refused and leaks nothing', async () => {
    const text = await pagedGet(`${FRONTMATTER}\n${BODY}`);
    expect(text.split('\n')[0]).toStartWith('[quoted conversation excerpt from ');
    expect(text.split('\n')[2]).toBe('---');
    expect(text).toContain('private: alice-example');
    const { html, error } = await publishFile(text);
    expect({ leaked: html?.includes('alice-example') ?? false, published: html !== null }).toEqual({ leaked: false, published: false });
    expect(error).toEqual(invalid);
    const { message, suggestion } = error as { message: string; suggestion: string };
    expect(message + suggestion).not.toContain('alice-example');
    expect(suggestion).toContain('gbrain get');
  });

  test('a generic wrapper line above frontmatter is refused', () => {
    expect(() => makeShareable(`Saved from my brain:\n${FRONTMATTER}${BODY}`)).toThrow(invalid);
    expect(() => makeShareable(`Saved from my brain:\r\n\r\n${FRONTMATTER.replace(/\n/g, '\r\n')}${BODY}`)).toThrow(invalid);
    expect(() => makeShareable(`${guestWarningLine(GUEST)}\nnote\n${FRONTMATTER}${BODY}`)).toThrow(invalid);
  });

  test('a wrapped opener with a language selector is refused without a key line', () => {
    expect(() => makeShareable(`wrapper\n---yaml\ntitle: A note\nprivate: alice-example\n---\n${BODY}`)).toThrow(invalid);
    expect(() => makeShareable(`wrapper\n--- json\n{"private": "alice-example"}\n---\n${BODY}`)).toThrow(invalid);
  });

  test('wrapped frontmatter that never closes, or that holds a flow mapping, is refused', () => {
    expect(() => makeShareable('Saved:\n---\ntype: note\nprivate: alice-example\n\n# A note\n')).toThrow(invalid);
    expect(() => makeShareable('Saved:\n---yaml\nprivate: alice-example\n')).toThrow(invalid);
    expect(() => makeShareable(`wrapper\n---\n{private: alice-example}\n---\n${BODY}`)).toThrow(invalid);
    expect(makeShareable('intro\n---\nThe draft is ready.\n\nA later line.\n')).toContain('The draft is ready.');
  });

  test('a language opener at the top of the page is frontmatter and is stripped', () => {
    for (const opener of ['---yml', '---yaml', '--- yaml']) expect(makeShareable(`${opener}\nprivate: alice-example\n---\n${BODY}`)).toBe(BODY.trim());
  });

  test('the window is the first five non-blank lines: four wrapper lines are refused, five publish', () => {
    const wrapper = (n: number) => Array.from({ length: n }, (_, i) => `wrapper line ${i + 1}\n`).join('\n');
    expect(() => makeShareable(`${wrapper(4)}${FRONTMATTER}${BODY}`)).toThrow(invalid);
    expect(makeShareable(`${wrapper(5)}${FRONTMATTER}${BODY}`)).toContain('wrapper line 5');
  });

  test('a normal page with early horizontal rules and no key line between them publishes', async () => {
    const page = '# Plan\n\nWe met on Monday.\n---\nThe draft is ready for a read.\n\n---\n\nMore notes after the second rule.\n';
    expect(makeShareable(page)).toBe(page.trim());
    const { html, error } = await publishFile(page);
    expect(error).toBeNull();
    expect(html).toContain('More notes after the second rule.');
    expect(makeShareable('intro\n---\nSee https://example.com/a\n---\nend\n')).toContain('https://example.com/a');
  });

  test('a page whose frontmatter opens the file, and a gbrain get guest page, still publish stripped', () => {
    expect(makeShareable(`${FRONTMATTER}${BODY}`)).toBe(BODY.trim());
    expect(makeShareable(`\n\n${FRONTMATTER}${BODY}`)).toBe(BODY.trim());
    expect(makeShareable(`${guestWarningLine(GUEST)}\n${FRONTMATTER}${BODY}`)).toBe(BODY.trim());
    expect(makeShareable(`${FRONTMATTER}${BODY}\n---\nkey: value\n---\n`)).not.toContain('alice-example');
  });
});

describe('guestQuoteLabel escapes saved_at', () => {
  test('a saved_at with brackets, separators or line breaks prints escaped', () => {
    for (const saved_at of ['2026-11-13]; source material\n[x', '<b>"2026"</b>', '2026\u2028-11-13']) {
      const label = guestQuoteLabel({ ...GUEST, saved_at });
      expect(label).toContain(`saved ${escapeGuestLabel(saved_at)},`);
      expect(label).not.toMatch(/[[\]<>";\n\u2028]/);
    }
    expect(guestQuoteLabel(GUEST)).toContain('saved 2026-11-13,');
    expect(guestQuoteLabel({ ...GUEST, saved_at: null })).toContain('saved undated,');
  });
});
