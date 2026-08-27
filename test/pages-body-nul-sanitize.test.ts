// gbrain#3998 regression (also covers the #4392 ingest-abort shape) — pages
// body columns (title, compiled_truth, timeline) and content_chunks.chunk_text
// must survive a raw NUL and a lone UTF-16 surrogate. Pre-fix, putPage and
// upsertChunks bound the raw strings, so one 0x00 byte aborted the INSERT with
// `invalid byte sequence for encoding "UTF8": 0x00` and dropped the whole
// document. #2011's sanitizeForJsonb only covered links/timeline/takes
// free-text; `sanitizeText` extends the same policy to the body columns.
//
// PGLite half (always-on): PGLite may not reproduce the exact Postgres
// encoding abort, but it locks the JS-side sanitization the same way
// links-timeline-jsonb-poison.test.ts does for the batch builders.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// Built via fromCharCode so no literal NUL / lone surrogate lands in this file.
const NUL = String.fromCharCode(0);
const LONE_HI = String.fromCharCode(0xd83c);

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('putPage — NUL/lone-surrogate body sanitization (#3998)', () => {
  it('persists and round-trips a page whose body columns carry NUL + lone surrogate', async () => {
    const page = await engine.putPage('poisoned-page', {
      type: 'concept' as never,
      title: `ti${NUL}tle${LONE_HI}`,
      compiled_truth: `body with a raw${NUL} NUL and a lone ${LONE_HI} surrogate, long enough to pass backstops`,
      timeline: `- 2026-01-01: something${NUL} happened${LONE_HI}`,
      frontmatter: {},
      source_path: 'poisoned-page.md',
    });
    // The page persisted (pre-fix: the INSERT aborts) and the stored values
    // are NUL-free and well-formed (lone surrogate → U+FFFD).
    expect(page.title).toBe('title�');
    expect(page.compiled_truth).not.toContain(NUL);
    expect(page.compiled_truth).toContain('�');
    expect(page.timeline).not.toContain(NUL);

    const fetched = await engine.getPage('poisoned-page');
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('title�');
    expect(fetched!.compiled_truth).not.toContain(NUL);
    expect(fetched!.timeline).not.toContain(NUL);
  });
});

describe('upsertChunks — NUL/lone-surrogate chunk_text sanitization (#3998)', () => {
  it('persists poisoned chunk_text and keeps embedded_text_hash consistent with the stored text', async () => {
    await engine.putPage('poisoned-chunks', {
      type: 'concept' as never,
      title: 'poisoned chunks',
      compiled_truth: 'clean body long enough to pass any minimum length backstop',
      timeline: '',
      frontmatter: {},
      source_path: 'poisoned-chunks.md',
    });
    await engine.upsertChunks('poisoned-chunks', [
      {
        chunk_index: 0,
        chunk_text: `chunk with${NUL} NUL and lone ${LONE_HI} surrogate`,
        chunk_source: 'compiled_truth',
        // Embedding present so the embedded_text_hash md5() bind path runs —
        // pre-fix that second raw chunk_text bind aborted the INSERT even if
        // the stored-text bind were sanitized, and the hash diverged.
        embedding: new Float32Array(1536),
      },
      {
        chunk_index: 1,
        chunk_text: `unembedded chunk with${NUL} NUL`,
        chunk_source: 'compiled_truth',
      },
    ]);

    const rows = await engine.executeRaw<{
      chunk_index: number;
      chunk_text: string;
      embedded_text_hash: string | null;
      recomputed: string;
    }>(
      `SELECT c.chunk_index, c.chunk_text, c.embedded_text_hash, md5(c.chunk_text) AS recomputed
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE p.slug = 'poisoned-chunks' AND p.source_id = 'default'
        ORDER BY c.chunk_index`,
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.chunk_text).not.toContain(NUL);
    }
    expect(rows[0].chunk_text).toContain('�');
    // The hash was computed over the SAME sanitized bytes as the stored text.
    expect(rows[0].embedded_text_hash).toBe(rows[0].recomputed);
    expect(rows[1].embedded_text_hash).toBeNull();
  });
});
