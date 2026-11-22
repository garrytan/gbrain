/**
 * An indented `---` inside a YAML block scalar is block text, not the closing frontmatter fence. frontmatterBodyOffset
 * used to stop there, so gbrain publish shared the frontmatter lines after it. It now finds the closing fence the way
 * parseDataFrontmatter does: `---` at column 0.
 */
import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeShareable } from '../src/commands/publish.ts';
import { frontmatterBodyOffset } from '../src/core/markdown.ts';
import { parseDataFrontmatter } from '../src/core/data-frontmatter.ts';
import { fixBacklinkGaps } from '../src/commands/backlinks.ts';
import { timelineSectionOf } from '../src/core/persistence/timeline-omission.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { fenceTranscriptText } from '../src/core/search/transcript-quote.ts';

const PAGE = [
  '---',
  'title: Example',
  'notes: |',
  '  public line',
  '  ---',
  "  private: alice-example's phone",
  '---',
  'Body',
  '',
].join('\n');

describe('an indented --- inside frontmatter does not close it', () => {
  test('frontmatterBodyOffset ends where the frontmatter parser ends the block', () => {
    const offset = frontmatterBodyOffset(PAGE);
    expect(PAGE.slice(offset)).toBe('Body\n');
    expect(PAGE.slice(offset)).toBe(parseDataFrontmatter(PAGE).content);
    expect(parseDataFrontmatter(PAGE).data.notes).toBe("public line\n---\nprivate: alice-example's phone\n");
  });

  test('gbrain publish keeps every frontmatter line out of the shared page', () => {
    const out = makeShareable(PAGE);
    expect(out).not.toContain('alice-example');
    expect(out).not.toContain('private:');
    expect(out).not.toContain('public line');
    expect(out.trim()).toBe('Body');
  });

  test('CRLF endings and trailing blanks on the closing fence still close it', () => {
    const crlf = PAGE.replace(/\n/g, '\r\n');
    expect(crlf.slice(frontmatterBodyOffset(crlf))).toBe('Body\r\n');
    expect(makeShareable(crlf)).not.toContain('alice-example');
    const trailing = PAGE.replace('\n---\nBody', '\n--- \t\nBody');
    expect(trailing.slice(frontmatterBodyOffset(trailing))).toBe('Body\n');
  });

  test('frontmatter closed only by an indented --- is unclosed, and publish refuses it', () => {
    const unclosed = "---\ntitle: Example\nnotes: |\n  ---\nprivate: alice-example's phone\n";
    expect(frontmatterBodyOffset(unclosed)).toBe(0);
    expect(parseDataFrontmatter(unclosed).content).toBe('');
    expect(() => makeShareable(unclosed)).toThrow(expect.objectContaining({ code: 'invalid_frontmatter' }));
  });
});

describe('callers of frontmatterBodyOffset read the real body', () => {
  test('the back-link fixer writes into the body, never into a frontmatter block scalar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fence-col0-'));
    try {
      const page = '---\ntitle: Example\nnotes: |\n  ---\n  <!-- timeline -->\n---\n# Example\n\nBody.\n';
      writeFileSync(join(dir, 'target.md'), page);
      const outcome = await fixBacklinkGaps(dir, [{ targetPage: 'target.md', sourcePage: 'source.md', sourceTitle: 'Source' } as never], false, { lockRoot: dir });
      const written = readFileSync(join(dir, 'target.md'), 'utf8');
      expect(outcome).toEqual({ fixed: 1, skipped: [] });
      expect(parseDataFrontmatter(written).data).toEqual(parseDataFrontmatter(page).data);
      expect(parseDataFrontmatter(written).content).toBe('# Example\n\nBody.\n\n## Referenced by\n\n- Referenced in [Source](source.md)\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a Timeline heading quoted inside frontmatter is not the page Timeline section', () => {
    const page = '---\ntitle: Example\nnotes: |\n  ---\n  ## Timeline\n---\n# Example\n\nBody.\n';
    expect(timelineSectionOf(page, 'example')).toBe('omitted');
  });

  describe('remote put_page', () => {
    let engine: PGLiteEngine;
    const remote = { remote: true, transport: 'stdio', sourceId: 'default' };
    const ok = async (op: string, params: Record<string, unknown>) => {
      const res = await dispatchToolCall(engine, op, params, remote as never);
      expect(res.isError, `${op}: ${res.content[0]?.text}`).not.toBe(true);
      return JSON.parse(res.content[0]!.text);
    };
    const stored = (slug: string) => engine.executeRaw<{ title: string; frontmatter: unknown }>('SELECT title, frontmatter FROM pages WHERE slug = $1', [slug]).then(r => r[0]);

    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      await engine.setConfig('embedding_disabled', 'true');
    }, 180_000);
    afterAll(async () => { await engine?.disconnect(); });

    test('a fenced title after an indented --- is stored unfenced', async () => {
      const head = (title: string) => `---\ntype: note\nnotes: |\n  public line\n  ---\n  second line\ntitle: ${title}\n---\n\nPasted body.\n`;
      await ok('put_page', { slug: 'notes/fence-plain', content: head('Pasted') });
      await ok('put_page', { slug: 'notes/fence-quoted', content: '---\ntype: note\ntitle: Old\n---\n\nOld body.\n' });
      const pasted = fenceTranscriptText('Pasted', 'notes/fence-quoted').split('\n').map(l => `  ${l}`).join('\n');
      const { revision } = await ok('get_page', { slug: 'notes/fence-quoted' });
      await ok('put_page', { slug: 'notes/fence-quoted', expected_revision: revision, content: head(`|-\n${pasted}`) });
      expect(await stored('notes/fence-quoted')).toEqual(await stored('notes/fence-plain'));
    }, 120_000);
  });
});
