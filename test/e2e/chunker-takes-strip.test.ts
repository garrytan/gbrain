/**
 * v0.28 e2e: chunker strips fenced takes content before computing chunks.
 *
 * Codex P0 #3 fix verification: takes content lives ONLY in the takes
 * table for retrieval. Without this strip, page chunks would contain the
 * rendered takes table and the per-token MCP `takes_holders` allow-list
 * would be bypassed at the index layer.
 *
 * This test imports a page with fenced takes content via the real import
 * pipeline (not just chunkText directly) and asserts that no chunk text
 * contains the fenced content.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { chunkText } from '../../src/core/chunkers/recursive.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { importFromContent } from '../../src/core/import-file.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

const PAGE_BODY = `# Alice Example

Alice founded Acme. She is a strong founder with deep technical instincts.
Acme is a B2B SaaS company building AI infra.

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | CEO of Acme | fact | world | 1.0 | 2017-01 | Crustdata |
| 2 | Burned out signal in last OH | hunch | garry | 0.4 | 2026-04-29 | OH body language |
${TAKES_FENCE_END}

## Background

Alice has a history of shipping fast. Acme has raised $300M.
`;

beforeAll(async () => {
  if (!RUN) return;
  await setupDB();
});

afterAll(async () => {
  if (!RUN) return;
  await teardownDB();
});

describe('chunkText (unit) strips fenced takes content', () => {
  test('output chunks do NOT contain takes-fence markers', () => {
    const chunks = chunkText(PAGE_BODY, { chunkSize: 100, chunkOverlap: 20 });
    for (const c of chunks) {
      expect(c.text).not.toContain(TAKES_FENCE_BEGIN);
      expect(c.text).not.toContain(TAKES_FENCE_END);
    }
  });

  test('output chunks do NOT contain fenced claim content', () => {
    const chunks = chunkText(PAGE_BODY, { chunkSize: 100, chunkOverlap: 20 });
    const allText = chunks.map(c => c.text).join('\n');
    // Sensitive content from inside the fence
    expect(allText).not.toContain('Burned out signal in last OH');
    expect(allText).not.toContain('OH body language');
  });

  test('output chunks DO contain non-fence prose', () => {
    const chunks = chunkText(PAGE_BODY, { chunkSize: 100, chunkOverlap: 20 });
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).toContain('strong founder');
    expect(allText).toContain('B2B SaaS');
    expect(allText).toContain('Background');
  });
});

d('chunker strip end-to-end via importFromContent', () => {
  test('imported page has chunks but none contain fenced content', async () => {
    const engine = getEngine();
    // Front-matter the body so parseMarkdown classifies it correctly
    const fmBody = `---\ntitle: Alice Strip Test\ntype: person\n---\n\n${PAGE_BODY}`;
    await importFromContent(engine, 'people/alice-strip-test', fmBody, { noEmbed: true });

    // Read chunks back from DB
    const rows = await engine.executeRaw<{ chunk_text: string }>(
      `SELECT cc.chunk_text FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = $1`,
      ['people/alice-strip-test'],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.chunk_text).not.toContain(TAKES_FENCE_BEGIN);
      expect(r.chunk_text).not.toContain(TAKES_FENCE_END);
      expect(r.chunk_text).not.toContain('Burned out signal in last OH');
    }
  });

  test('takes_fence_chunk_leak doctor invariant: no chunk row contains the begin marker', async () => {
    const engine = getEngine();
    // Confirm the contract globally — across all pages in the brain.
    const leaks = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM content_chunks
       WHERE chunk_text LIKE '%<!--- gbrain:takes:%'`,
    );
    expect(Number(leaks[0]?.count)).toBe(0);
  });
});
