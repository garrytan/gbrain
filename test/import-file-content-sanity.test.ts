import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importFromContent } from '../src/core/import-file.ts';
import { ContentSanityBlockError } from '../src/core/content-sanity.ts';
import { isEmbedSkipped, EMBED_SKIP_KEY } from '../src/core/embed-skip.ts';

let engine: PGLiteEngine;
let auditDir: string;
let gbrainHomeDir: string;

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
});

/** Wrap an importFromContent call with GBRAIN_HOME + GBRAIN_AUDIT_DIR
 *  pointed at fresh tempdirs so config and audit writes don't leak
 *  between tests or pollute the developer's real ~/.gbrain. */
async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  gbrainHomeDir = mkdtempSync(join(tmpdir(), 'cs-gate-home-'));
  auditDir = mkdtempSync(join(tmpdir(), 'cs-gate-audit-'));
  try {
    return await withEnv({
      GBRAIN_HOME: gbrainHomeDir,
      GBRAIN_AUDIT_DIR: auditDir,
    }, fn);
  } finally {
    rmSync(gbrainHomeDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
}

const FRONTMATTER = `---
title: 'Test Page'
type: note
created: 2026-05-24
---

`;

describe('importFromContent — content-sanity hard-block (D6)', () => {
  test('throws ContentSanityBlockError on Cloudflare junk title', async () => {
    await withIsolatedHome(async () => {
      const content = `---
title: 'Attention Required! | Cloudflare'
type: note
created: 2026-05-24
---

Body.`;
      await expect(
        importFromContent(engine, 'test/junk', content, { noEmbed: true })
      ).rejects.toThrow(ContentSanityBlockError);
    });
  });

  test('throws with PAGE_JUNK_PATTERN-tagged message for classifyErrorCode', async () => {
    await withIsolatedHome(async () => {
      const content = FRONTMATTER + 'Cloudflare Ray ID: abc123';
      let caught: Error | undefined;
      try {
        await importFromContent(engine, 'test/ray', content, { noEmbed: true });
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('PAGE_JUNK_PATTERN');
    });
  });

  test('thrown page is NOT written to DB', async () => {
    await withIsolatedHome(async () => {
      // Title matches the anchored error_page_title pattern exactly
      // (`^(403|404|500|...|page not found)\s*$`). "404 Not Found"
      // doesn't anchor; the test needs the bare form.
      const content = `---
title: '404'
type: note
created: 2026-05-24
---

`;
      try {
        await importFromContent(engine, 'test/404', content, { noEmbed: true });
      } catch { /* expected */ }
      const page = await engine.getPage('test/404');
      expect(page).toBeNull();
    });
  });

  // ─── v0.41.13: end-to-end coverage for the expanded patterns ────────
  // Exercises the assessor wiring (not just the regex) per D6.

  test.each([
    ['Forbidden', 'error_page_title'],
    ['Access Denied', 'error_page_title'],
    ['Service Unavailable', 'error_page_title'],
    ['Robot Check', 'error_page_title'],
    ['Just a moment...', 'cloudflare_challenge_title'],
  ])('v0.41.13: title %j → ContentSanityBlockError (matches %s)', async (title, expectedPattern) => {
    await withIsolatedHome(async () => {
      const content = `---
title: '${title}'
type: note
created: 2026-05-24
---

scraper junk body`;
      let caught: ContentSanityBlockError | undefined;
      try {
        await importFromContent(engine, 'test/v04113-' + title.toLowerCase().replace(/[^a-z]/g, '-'), content, { noEmbed: true });
      } catch (e) {
        if (e instanceof ContentSanityBlockError) caught = e;
        else throw e;
      }
      expect(caught).toBeDefined();
      expect(caught!.result.junk_pattern_matches).toContain(expectedPattern);
      expect(caught!.message).toContain('PAGE_JUNK_PATTERN');
    });
  });

  test('v0.41.13: over-match regression — "How to Handle Access Denied Errors" imports cleanly', async () => {
    await withIsolatedHome(async () => {
      const content = `---
title: 'How to Handle Access Denied Errors'
type: note
created: 2026-05-24
---

A legitimate essay about handling access-denied errors in your app.`;
      // Should NOT throw.
      const result = await importFromContent(engine, 'test/v04113-essay', content, { noEmbed: true });
      expect(result.status).not.toBe('error');
      const page = await engine.getPage('test/v04113-essay');
      expect(page).not.toBeNull();
    });
  });
});

describe('importFromContent — soft-block (D9 transition + embed_skip)', () => {
  test('soft-block writes page with embed_skip frontmatter marker', async () => {
    await withIsolatedHome(async () => {
      // 600K of clean text → soft-block (oversize but no junk pattern).
      const content = FRONTMATTER + 'a'.repeat(600_000);
      const result = await importFromContent(engine, 'test/big', content, { noEmbed: true });
      expect(result.status).not.toBe('error');
      const page = await engine.getPage('test/big');
      expect(page).not.toBeNull();
      const fm = page!.frontmatter as Record<string, unknown>;
      expect(isEmbedSkipped(fm)).toBe(true);
      const marker = fm[EMBED_SKIP_KEY] as Record<string, unknown>;
      expect(marker.reason).toBe('oversized');
      expect(marker.bytes).toBeGreaterThan(500_000);
    });
  });

  test('soft-block deletes existing chunks (D9 transition invariant)', async () => {
    await withIsolatedHome(async () => {
      // First write a normal page to seed some chunks.
      const small = FRONTMATTER + 'Short content with multiple sentences. Plenty of words here. Enough to chunk.';
      await importFromContent(engine, 'test/grow', small, { noEmbed: true });
      const beforeChunks = await engine.getChunks('test/grow');
      expect(beforeChunks.length).toBeGreaterThan(0);

      // Now re-import with content that grew past the block threshold.
      const big = FRONTMATTER + 'a'.repeat(600_000);
      await importFromContent(engine, 'test/grow', big, { noEmbed: true });
      const afterChunks = await engine.getChunks('test/grow');
      // D9: transition to embed_skip should delete chunks.
      expect(afterChunks.length).toBe(0);
    });
  });

  test('soft-block skips chunking entirely (no new chunks created)', async () => {
    await withIsolatedHome(async () => {
      const content = FRONTMATTER + 'a'.repeat(600_000);
      await importFromContent(engine, 'test/big2', content, { noEmbed: true });
      const chunks = await engine.getChunks('test/big2');
      expect(chunks.length).toBe(0);
    });
  });
});

describe('importFromContent — kill-switch bypass', () => {
  test('GBRAIN_NO_SANITY=1 lets junk through with bypass audit + stderr', async () => {
    const gbrainHomeDirLocal = mkdtempSync(join(tmpdir(), 'cs-bypass-home-'));
    const auditDirLocal = mkdtempSync(join(tmpdir(), 'cs-bypass-audit-'));
    try {
      await withEnv({
        GBRAIN_HOME: gbrainHomeDirLocal,
        GBRAIN_AUDIT_DIR: auditDirLocal,
        GBRAIN_NO_SANITY: '1',
      }, async () => {
        const content = `---
title: 'Attention Required! | Cloudflare'
type: note
created: 2026-05-24
---

junk body`;
        const result = await importFromContent(engine, 'test/bypass', content, { noEmbed: true });
        expect(result.status).not.toBe('error');
        const page = await engine.getPage('test/bypass');
        expect(page).not.toBeNull();
        // Page lands with frontmatter unchanged (no embed_skip set on bypass).
        const fm = page!.frontmatter as Record<string, unknown>;
        expect(isEmbedSkipped(fm)).toBe(false);
      });
    } finally {
      rmSync(gbrainHomeDirLocal, { recursive: true, force: true });
      rmSync(auditDirLocal, { recursive: true, force: true });
    }
  });
});

describe('importFromContent — normal pages unaffected', () => {
  test('clean page imports successfully', async () => {
    await withIsolatedHome(async () => {
      const content = FRONTMATTER + 'A thoughtful essay about software design.';
      const result = await importFromContent(engine, 'test/clean', content, { noEmbed: true });
      expect(result.status).toBe('imported');
      const page = await engine.getPage('test/clean');
      expect(page).not.toBeNull();
      const fm = page!.frontmatter as Record<string, unknown>;
      expect(isEmbedSkipped(fm)).toBe(false);
    });
  });

  test('warn-tier page (50K-500K body) lands normally without embed_skip', async () => {
    await withIsolatedHome(async () => {
      const content = FRONTMATTER + 'a'.repeat(100_000);
      const result = await importFromContent(engine, 'test/warn', content, { noEmbed: true });
      expect(result.status).toBe('imported');
      const page = await engine.getPage('test/warn');
      expect(page).not.toBeNull();
      const fm = page!.frontmatter as Record<string, unknown>;
      expect(isEmbedSkipped(fm)).toBe(false);
    });
  });
});
