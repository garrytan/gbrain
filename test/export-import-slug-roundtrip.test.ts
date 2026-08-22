/**
 * #3772 — export → import slug round-trip.
 *
 * Export writes each page at `<slug>.md` with the stored frontmatter
 * verbatim; import re-derives the slug via slugifyPath and rejects a
 * frontmatter slug that differs from the path-derived one. When the stored
 * slug is NOT a slugifyPath fixed point (legacy/hand-keyed slugs with case,
 * apostrophes, accents…), the round-trip silently RE-KEYED the page:
 * export people/Alice_Smith → import people/alice_smith (a different row).
 *
 * Fix: export stamps `slug:` into frontmatter when the slug isn't a fixed
 * point; import accepts a frontmatter slug iff slugifyPath(slug) equals the
 * path-derived slug (normalization-equivalent). Anti-spoof is preserved: a
 * frontmatter slug claiming a DIFFERENT page still normalizes differently
 * and still rejects.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExport } from '../src/commands/export.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { slugifyPath } from '../src/core/sync.ts';

let source: PGLiteEngine;
let target: PGLiteEngine;
let outDir: string;

// A slug that is NOT a slugifyPath fixed point. putPage's validateSlug
// lowercases but preserves apostrophes and accents; slugifyPath strips both,
// so this identity cannot be re-derived from its own export path.
const LEGACY_SLUG = "people/ren\u00e9-o'brien";
// A slug that IS a fixed point.
const CLEAN_SLUG = 'people/bob-jones';

beforeAll(async () => {
  source = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  target = new PGLiteEngine();
  await target.connect({});
  await target.initSchema();
  outDir = mkdtempSync(join(tmpdir(), 'gbrain-roundtrip-'));

  expect(slugifyPath(LEGACY_SLUG + '.md')).not.toBe(LEGACY_SLUG);
  expect(slugifyPath(CLEAN_SLUG + '.md')).toBe(CLEAN_SLUG);

  await source.putPage(LEGACY_SLUG, {
    type: 'person',
    title: 'Rene OBrien',
    compiled_truth: '# Rene OBrien\n\nLegacy-keyed page whose slug predates slug normalization.',
    frontmatter: { type: 'person', title: 'Rene OBrien' },
  } as any, { sourceId: 'default' });
  await source.putPage(CLEAN_SLUG, {
    type: 'person',
    title: 'Bob Jones',
    compiled_truth: '# Bob Jones\n\nNormal page with an already-normalized slug.',
    frontmatter: { type: 'person', title: 'Bob Jones' },
  } as any, { sourceId: 'default' });

  await runExport(source, ['--dir', outDir]);
}, 60000);

afterAll(async () => {
  await source.disconnect();
  await target.disconnect();
  rmSync(outDir, { recursive: true, force: true });
}, 30000);

describe('export stamps the identity when slug is not a slugifyPath fixed point (#3772)', () => {
  test('legacy slug file carries a frontmatter slug', () => {
    const md = readFileSync(join(outDir, LEGACY_SLUG + '.md'), 'utf-8');
    expect(md).toContain(`slug: ${LEGACY_SLUG}`);
  });

  test('fixed-point slug file does NOT grow a slug line (no diff noise)', () => {
    const md = readFileSync(join(outDir, CLEAN_SLUG + '.md'), 'utf-8');
    expect(md).not.toMatch(/^slug:/m);
  });
});

describe('import accepts normalization-equivalent frontmatter slugs (#3772)', () => {
  test('round-trip preserves the legacy slug', async () => {
    const rel = LEGACY_SLUG + '.md';
    const result = await importFromFile(target, join(outDir, rel), rel, { noEmbed: true });
    expect(result.error).toBeUndefined();
    expect(result.slug).toBe(LEGACY_SLUG);
    const page = await target.getPage(LEGACY_SLUG, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Rene OBrien');
    // No re-keyed doppelganger under the normalized spelling.
    const normalized = await target.getPage(slugifyPath(LEGACY_SLUG + '.md'), { sourceId: 'default' });
    expect(normalized).toBeNull();
  });

  test('round-trip of the fixed-point slug still works', async () => {
    const rel = CLEAN_SLUG + '.md';
    const result = await importFromFile(target, join(outDir, rel), rel, { noEmbed: true });
    expect(result.error).toBeUndefined();
    expect(result.slug).toBe(CLEAN_SLUG);
  });

  test('anti-spoof preserved: a frontmatter slug for a DIFFERENT page still rejects', async () => {
    const rel = 'people/eve.md';
    mkdirSync(join(outDir, 'people'), { recursive: true });
    writeFileSync(
      join(outDir, rel),
      '---\ntype: person\ntitle: Eve\nslug: people/mallory\n---\n\n# Eve\n',
    );
    const result = await importFromFile(target, join(outDir, rel), rel, { noEmbed: true });
    expect(result.status).toBe('skipped');
    expect(result.error).toContain('does not match path-derived slug');
  });
});
