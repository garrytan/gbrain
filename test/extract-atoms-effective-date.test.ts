/** Protects historical atom filtering through the actual extraction/import path.
 * Reverting the extraction date stamp dates these pages at today's run instead.
 * Existing chunk/provenance tests never assert a stored effective_date. Uses
 * the existing model seam only; all persistence and indexing are real PGLite.
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

const chat = async (): Promise<ChatResult> => ({
  text: '[{"title":"Historical lesson","atom_type":"insight","body":"Clear exit criteria prevent stalled pilots."}]',
  blocks: [], stopReason: 'end', model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
});

describe('atom content dates', () => {
  for (const fixture of [
    { id: 'filename', slug: 'meetings/2026-07-09-review', fm: '', date: '2026-07-09T00:00:00.000Z' },
    { id: 'event', slug: 'notes/review', fm: 'event_date: 2026-06-03T15:45:00Z\n', date: '2026-06-03T15:45:00.000Z' },
    { id: 'precedence', slug: 'notes/2026-07-09-review', fm: 'date: 2026-05-04\n', date: '2026-05-04T00:00:00.000Z' },
    { id: 'legacy', slug: 'meetings/2026-04-02-review', fm: '', date: '2026-04-02T00:00:00.000Z' },
    { id: 'undated', slug: 'notes/undated-review', fm: '', date: '2026-03-01T00:00:00.000Z' },
  ]) test(`inherits ${fixture.id} date, not the run or another source`, async () => {
    const sourceId = `atom-date-${fixture.id}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const body = 'The pilot needs clear exit criteria. '.repeat(40);
    await importFromContent(engine, fixture.slug, `---\ntype: source\n${fixture.fm}---\n${body}`, { sourceId, noEmbed: true });
    await engine.putPage(fixture.slug, { type: 'source', title: 'Wrong source', compiled_truth: body,
      effective_date: new Date('2026-01-01'), effective_date_source: 'date' });
    if (fixture.id === 'legacy' || fixture.id === 'undated') {
      await engine.executeRaw('UPDATE pages SET effective_date=NULL,effective_date_source=NULL,created_at=$3 WHERE source_id=$1 AND slug=$2',
        [sourceId, fixture.slug, new Date('2026-03-01')]);
    }
    const page = (await engine.getPage(fixture.slug, { sourceId }))!;
    if (page.effective_date) expect(page.effective_date.toISOString()).toBe(fixture.date);
    const result = await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [],
      _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: async () => {
        // A date projection refreshed during inference must not replace the
        // date captured with this extraction's input.
        await engine.executeRaw('UPDATE pages SET effective_date=$3 WHERE source_id=$1 AND slug=$2',
          [sourceId, fixture.slug, new Date('2026-09-01')]);
        return chat();
      } });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(1);
    const atoms = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND type='atom'", [sourceId]);
    expect(atoms).toHaveLength(1);
    const atom = (await engine.getPage(atoms[0].slug, { sourceId }))!;
    expect(atom.effective_date!.toISOString()).toBe(fixture.date);
    expect(new Date(atom.frontmatter.extracted_at as string).getTime()).toBeGreaterThan(new Date(fixture.date).getTime());
    expect(atom.frontmatter.source_slug).toBe(page.slug);
    expect(atom.effective_date_source).toBe('date');
    expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1', [atom.id])).not.toHaveLength(0);
  }, 60_000);
});
