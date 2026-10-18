/**
 * #6720: a page-derived atom inherits its source page's content date.
 *
 * Protects: date filters and recency ranking over atoms. The atom writer
 * stamped only `extracted_at`, so canonical import dated every atom at
 * the extraction run (`created_at` fallback). The source date is captured
 * with the extraction input, before the model call, and serialized into the
 * atom's frontmatter `date`, so classic import and managed publication
 * (test/helpers/managed-atoms-contract.ts) store the same date.
 * Regression: dropping the stamp, reading the date after inference, or
 * borrowing a date for a transcript-derived atom (no source page).
 * Model calls go through the `_chat` seam; persistence is real PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); resetGateway(); });

const reply = (): ChatResult => ({
  text: '[{"title":"Exit criteria lesson","atom_type":"insight","body":"Clear exit criteria keep pilots from stalling."}]',
  blocks: [], stopReason: 'end', model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
});
const body = 'The pilot needs clear exit criteria before it starts. '.repeat(40);

async function onlyAtom(sourceId: string) {
  const rows = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND type='atom'", [sourceId]);
  expect(rows).toHaveLength(1);
  return (await engine.getPage(rows[0]!.slug, { sourceId }))!;
}

describe('#6720 atom content dates', () => {
  for (const fx of [
    { id: 'filename', slug: 'meetings/2026-07-09-review', fm: '', legacy: false, date: '2026-07-09T00:00:00.000Z' },
    { id: 'frontmatter-date', slug: 'notes/2026-07-09-review', fm: 'date: 2026-05-04\n', legacy: false, date: '2026-05-04T00:00:00.000Z' },
    { id: 'legacy-no-projection', slug: 'meetings/2026-04-02-review', fm: '', legacy: true, date: '2026-04-02T00:00:00.000Z' },
  ]) {
    test(`a page-derived atom carries the source page's ${fx.id} date, captured before the model call`, async () => {
      const sourceId = `atom-date-${fx.id}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await importFromContent(engine, fx.slug, `---\ntype: source\ntitle: Review\n${fx.fm}---\n${body}`, { sourceId, noEmbed: true });
      // A same-slug page in another source with another date must never leak in.
      await engine.putPage(fx.slug, { type: 'source', title: 'Other source', compiled_truth: body, effective_date: new Date('2026-01-01'), effective_date_source: 'date' });
      if (fx.legacy) await engine.executeRaw('UPDATE pages SET effective_date=NULL, effective_date_source=NULL WHERE source_id=$1 AND slug=$2', [sourceId, fx.slug]);
      const page = (await engine.getPage(fx.slug, { sourceId }))!;
      const result = await runPhaseExtractAtoms(engine, {
        sourceId, _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }],
        _chat: async () => {
          await engine.executeRaw('UPDATE pages SET effective_date=$3 WHERE source_id=$1 AND slug=$2', [sourceId, fx.slug, new Date('2026-09-01')]);
          return reply();
        },
      });
      expect(result.details?.atoms_extracted).toBe(1);
      const atom = await onlyAtom(sourceId);
      expect(atom.frontmatter.source_slug).toBe(fx.slug);
      expect(atom.frontmatter.date).toBe(fx.date);
      expect(new Date(atom.effective_date!).toISOString()).toBe(fx.date);
      expect(atom.effective_date_source).toBe('date');
      expect(new Date(atom.frontmatter.extracted_at as string).getTime()).toBeGreaterThan(Date.parse('2026-10-01'));
    }, 60_000);
  }

  test('a transcript-derived atom has no source page and borrows no date', async () => {
    const sourceId = 'atom-date-transcript';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const result = await runPhaseExtractAtoms(engine, {
      sourceId, _pages: [], _transcripts: [{ filePath: '/fake/2026-07-09-call.txt', content: body, contentHash: 'ab'.repeat(32) }],
      _chat: async () => reply(),
    });
    expect(result.details?.atoms_extracted).toBe(1);
    const atom = await onlyAtom(sourceId);
    expect(atom.frontmatter.date).toBeUndefined();
    expect(atom.effective_date_source).not.toBe('date');
  }, 60_000);
});
