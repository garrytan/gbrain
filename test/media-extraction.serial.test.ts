import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { importNormalizedMediaEvidence } from '../src/core/import-media.ts';
import { mediaExtractionToEvidence, normalizeMediaExtraction } from '../src/core/media-extraction.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImportMedia } from '../src/commands/import-media.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

describe('media extraction normalization', () => {
  test('normalizes screenshot/pdf/video fixtures into evidence text', () => {
    for (const name of ['media-extraction-image.json', 'media-extraction-pdf.json', 'media-extraction-video.json']) {
      const raw = JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'));
      const extraction = normalizeMediaExtraction(raw);
      const evidence = mediaExtractionToEvidence(extraction);
      expect(extraction.schemaVersion).toBe('gbrain.media-extraction.v1');
      expect(evidence.schemaVersion).toBe('gbrain.media-evidence.v1');
      expect(evidence.segments.length).toBeGreaterThan(0);
      expect(evidence.text.length).toBeGreaterThan(10);
    }
  });

  test('rejects payloads without segments or with unknown kinds', () => {
    expect(() => normalizeMediaExtraction({ kind: 'image', segments: [] })).toThrow(/at least one segment/);
    expect(() => normalizeMediaExtraction({ kind: 'spreadsheet', segments: [{ kind: 'asset' }] })).toThrow(/invalid kind/);
    expect(() => normalizeMediaExtraction({ kind: 'image', segments: [{ kind: 'unknown' }] })).toThrow(/invalid kind/);
  });
});

describe('media evidence import', () => {
  const engine = new PGLiteEngine();

  beforeAll(async () => {
    await engine.connect({});
    await engine.initSchema();
  }, 30000);

  beforeEach(async () => {
    await resetPgliteState(engine);
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  }, 30000);

  test('stores normalized media evidence as searchable raw_data sidecar', async () => {
    const content = `---\ntype: media\ntitle: Stripe login screenshot\n---\n\nCurated screenshot note.`;
    const extraction = normalizeMediaExtraction(JSON.parse(readFileSync(join(FIXTURES, 'media-extraction-image.json'), 'utf-8')));
    const evidence = mediaExtractionToEvidence(extraction);

    const result = await importNormalizedMediaEvidence(engine, {
      slug: 'media/stripe-login-screenshot',
      content,
      evidence,
      noEmbed: true,
    });
    expect(result.status).toBe('imported');

    const rows = await engine.getRawData('media/stripe-login-screenshot', 'gbrain.media-evidence.v1');
    expect(rows.length).toBe(1);
    const data = rows[0]?.data as any;
    expect(data.schemaVersion).toBe('gbrain.media-evidence.v1');
    expect(data.kind).toBe('image');
    expect(data.text).toContain('Stripe API key invalid');
    expect(data.segments[0].locator.bbox).toEqual([0.1, 0.2, 0.8, 0.35]);

    const chunks = await engine.executeRaw<{ chunk_text: string }>(
      `SELECT cc.chunk_text
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1`,
      ['media/stripe-login-screenshot'],
    );
    expect(chunks.some(chunk => chunk.chunk_text.includes('Stripe API key invalid'))).toBe(true);
  });

  test('CLI import-media ingests extraction fixture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-media-import-'));
    const contentPath = join(dir, 'page.md');
    const extractionPath = join(dir, 'evidence.json');
    writeFileSync(contentPath, `---\ntype: media\ntitle: Demo video\n---\n\nDemo video evidence page.`);
    writeFileSync(extractionPath, readFileSync(join(FIXTURES, 'media-extraction-video.json'), 'utf-8'));

    try {
      await runImportMedia(engine, [
        '--slug', 'media/demo-video',
        '--content-file', contentPath,
        '--extraction', extractionPath,
        '--no-embed',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const page = await engine.getPage('media/demo-video');
    expect(page?.title).toBe('Demo video');
    expect(page?.compiled_truth).toBe('Demo video evidence page.');
    expect(page?.frontmatter.evidence_schema).toBe('gbrain.media-evidence.v1');

    const raw = await engine.getRawData('media/demo-video', 'gbrain.media-evidence.v1');
    expect(raw.length).toBe(1);
    const data = raw[0]?.data as any;
    expect(data.kind).toBe('video');
    expect(data.segments.some((segment: any) => segment.kind === 'transcript_segment')).toBe(true);
  });

  test('CLI import-media without content file preserves existing page tags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-media-import-tags-'));
    const contentPath = join(dir, 'page.md');
    const extractionPath = join(dir, 'evidence.json');
    writeFileSync(contentPath, `---\ntype: media\ntitle: Tagged Screenshot\ntags: [receipt, stripe]\n---\n\nTagged evidence page.`);
    writeFileSync(extractionPath, readFileSync(join(FIXTURES, 'media-extraction-image.json'), 'utf-8'));

    try {
      await runImportMedia(engine, [
        '--slug', 'media/tagged-screenshot',
        '--content-file', contentPath,
        '--extraction', extractionPath,
        '--no-embed',
      ]);
      expect(await engine.getTags('media/tagged-screenshot')).toEqual(['receipt', 'stripe']);

      await runImportMedia(engine, [
        '--slug', 'media/tagged-screenshot',
        '--extraction', extractionPath,
        '--no-embed',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(await engine.getTags('media/tagged-screenshot')).toEqual(['receipt', 'stripe']);
  });
});
