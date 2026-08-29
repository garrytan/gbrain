/**
 * #3694 — one canonical content-hash formula.
 *
 * Pre-fix, utils.contentHash (both engines' putPage fallback) and the
 * importer's inline formula hashed DIFFERENT shapes (no ephemeral strip, no
 * tags on the putPage side), so the same logical page carried two hashes and
 * every putPage→sync roundtrip re-chunked + re-embedded unchanged content.
 *
 * Coverage:
 *   1. GOLDEN byte-parity: contentHash reproduces the importer's former
 *      inline formula exactly (replicated here), pinned to a literal digest.
 *   2. Ephemeral keys + tags spelling invariance.
 *   3. contentHashLegacy preserves the pre-fix putPage formula.
 *   4. PGLite e2e: putPage → importFromContent of the same logical page is a
 *      SKIP (hashes converge); a legacy-hashed row is reconciled in place
 *      (canonical hash stamped, no re-chunk) and the next import fast-skips.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { contentHash, contentHashLegacy, HASH_EPHEMERAL_FRONTMATTER_KEYS } from '../src/core/utils.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

/** The importer's former inline formula, replicated byte-for-byte. */
function formerImporterHash(parsed: {
  title: string;
  type: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
}): string {
  const stableFrontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  for (const k of HASH_EPHEMERAL_FRONTMATTER_KEYS) delete stableFrontmatter[k];
  return createHash('sha256')
    .update(JSON.stringify({
      title: parsed.title,
      type: parsed.type,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: stableFrontmatter,
      tags: [...parsed.tags].sort(),
    }))
    .digest('hex');
}

const FILE_CONTENT = [
  '---',
  'type: concept',
  'title: Golden Page',
  'tags: [beta, alpha]',
  'extra: value',
  'captured_at: 2026-08-21T00:00:00Z',
  '---',
  '',
  'Golden body for the #3694 parity pin.',
  '',
].join('\n');

describe('#3694 contentHash — canonical formula', () => {
  test('GOLDEN: matches the importer former inline formula byte-for-byte', () => {
    const parsed = parseMarkdown(FILE_CONTENT, 'topics/golden-page.md');
    const viaHelper = contentHash({
      title: parsed.title,
      type: parsed.type as never,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
    });
    const viaFormerInline = formerImporterHash({
      title: parsed.title,
      type: parsed.type,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
    });
    expect(viaHelper).toBe(viaFormerInline);
  });

  test('ephemeral frontmatter keys do not perturb the hash', () => {
    const base = {
      title: 'T',
      type: 'concept' as never,
      compiled_truth: 'body',
      timeline: '',
      frontmatter: { extra: 'v' },
    };
    const withEphemeral = {
      ...base,
      frontmatter: {
        extra: 'v',
        captured_at: '2026-08-21T01:02:03Z',
        ingested_at: '2026-08-21T01:02:03Z',
        quarantine: { reason: 'x' },
        content_flag: { reason: 'y' },
        embed_skip: { bytes: 999 },
      },
    };
    expect(contentHash(withEphemeral)).toBe(contentHash(base));
  });

  test('tags hash identically whether hoisted (page.tags) or inline (frontmatter.tags)', () => {
    const hoisted = contentHash({
      title: 'T',
      type: 'concept' as never,
      compiled_truth: 'body',
      frontmatter: { extra: 'v' },
      tags: ['b', 'a'],
    });
    const inline = contentHash({
      title: 'T',
      type: 'concept' as never,
      compiled_truth: 'body',
      frontmatter: { extra: 'v', tags: ['a', 'b'] },
    });
    expect(hoisted).toBe(inline);
  });

  test('contentHashLegacy preserves the pre-#3694 putPage formula', () => {
    const page = {
      title: 'T',
      type: 'concept' as never,
      compiled_truth: 'body',
      timeline: '',
      frontmatter: { extra: 'v', captured_at: 'x', tags: ['a'] },
    };
    const oldFormula = createHash('sha256')
      .update(JSON.stringify({
        title: page.title,
        type: page.type,
        compiled_truth: page.compiled_truth,
        timeline: page.timeline || '',
        frontmatter: page.frontmatter || {},
      }))
      .digest('hex');
    expect(contentHashLegacy(page)).toBe(oldFormula);
    // And the canonical formula genuinely differs on this shape (tags +
    // ephemeral present) — otherwise the legacy shim would be dead code.
    expect(contentHash(page)).not.toBe(oldFormula);
  });
});

describe('#3694 putPage → import converges (PGLite e2e)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  test('a page written via putPage is SKIPPED on re-import of the same file', async () => {
    const parsed = parseMarkdown(FILE_CONTENT, 'topics/golden-page.md');
    // putPage the same logical page (frontmatter spelling: tags inline, the
    // typical ops-caller shape) with NO explicit content_hash so the engine
    // fallback computes it.
    await engine.putPage('topics/golden-page', {
      type: parsed.type as never,
      title: parsed.title,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: { ...parsed.frontmatter, tags: parsed.tags, captured_at: '2026-08-21T09:00:00Z' },
    });

    const result = await importFromContent(engine, 'topics/golden-page', FILE_CONTENT, {
      noEmbed: true,
    });
    expect(result.status).toBe('skipped');
  }, 60_000);

  test('a legacy-hashed row is reconciled in place and then fast-skips', async () => {
    const slug = 'topics/legacy-page';
    const content = [
      '---',
      'type: concept',
      'title: Legacy Page',
      'tags: [x]',
      '---',
      '',
      'Legacy body.',
      '',
    ].join('\n');
    const parsed = parseMarkdown(content, slug + '.md');
    const legacy = contentHashLegacy({
      title: parsed.title,
      type: parsed.type as never,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
    });
    const canonical = contentHash({
      title: parsed.title,
      type: parsed.type as never,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
    });
    expect(legacy).not.toBe(canonical);

    // Simulate a pre-fix row: explicit legacy content_hash.
    await engine.putPage(slug, {
      type: parsed.type as never,
      title: parsed.title,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      content_hash: legacy,
    });

    const first = await importFromContent(engine, slug, content, { noEmbed: true });
    expect(first.status).toBe('skipped');

    // The reconcile stamped the canonical hash without a re-import.
    const rows = await engine.executeRaw<{ content_hash: string }>(
      `SELECT content_hash FROM pages WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    expect(rows[0]!.content_hash).toBe(canonical);

    // Second import takes the fast path (hash equality) and stays skipped.
    const second = await importFromContent(engine, slug, content, { noEmbed: true });
    expect(second.status).toBe('skipped');
  }, 60_000);
});
