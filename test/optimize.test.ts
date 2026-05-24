import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runOptimizeCore } from '../src/commands/optimize.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

describe('runOptimizeCore', () => {
  beforeEach(truncateAll);

  test('rebuilds stale oversized chunks into bounded chunks', async () => {
    const body = Array.from({ length: 420 }, (_, i) => `word${i}`).join(' ');
    await engine.putPage('sources/email-long', {
      type: 'source',
      title: 'Long email',
      compiled_truth: body,
      timeline: '',
    });
    await engine.upsertChunks('sources/email-long', [{
      chunk_index: 0,
      chunk_text: body,
      chunk_source: 'compiled_truth',
      token_count: 420,
    }]);

    const result = await runOptimizeCore(engine, {
      dryRun: false,
      jsonMode: false,
      maxWords: 100,
      overlapWords: 10,
      maxChars: 1200,
      skipExtract: true,
    });

    expect(result.pages_rechunked).toBe(1);
    const chunks = await engine.getChunks('sources/email-long');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => (c.token_count ?? 0) <= 160)).toBe(true);
  });

  test('splits long single-token content by character budget', async () => {
    const body = `prefix ${'x'.repeat(1500)} suffix`;
    await engine.putPage('sources/long-token', {
      type: 'source',
      title: 'Long token',
      compiled_truth: body,
      timeline: '',
    });

    await runOptimizeCore(engine, {
      dryRun: false,
      jsonMode: false,
      maxWords: 300,
      overlapWords: 50,
      maxChars: 500,
      skipExtract: true,
    });

    const chunks = await engine.getChunks('sources/long-token');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.chunk_text.length <= 500)).toBe(true);
  });

  test('extracts db links and timeline as part of optimization', async () => {
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: '',
      timeline: '',
    });
    await engine.putPage('companies/acme', {
      type: 'company',
      title: 'Acme',
      compiled_truth: '[Alice](people/alice) joined as CEO.',
      timeline: '- **2026-01-15** | Hired Alice',
    });

    const result = await runOptimizeCore(engine, {
      dryRun: false,
      jsonMode: false,
      maxWords: 300,
      overlapWords: 50,
      maxChars: 1200,
      skipExtract: false,
    });

    expect(result.links_created).toBe(1);
    expect(result.timeline_entries_created).toBe(2);
    const links = await engine.getLinks('companies/acme');
    const timeline = await engine.getTimeline('companies/acme');
    expect(links.map(l => l.to_slug)).toEqual(['people/alice']);
    expect(timeline.map(t => t.summary)).toEqual(['Hired Alice']);
  });

  test('propagates dated source events to linked entity timelines', async () => {
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: '',
      timeline: '',
    });
    await engine.putPage('meetings/acme-sync', {
      type: 'meeting',
      title: 'Acme Sync',
      compiled_truth: '[Alice](people/alice) discussed pipeline.',
      timeline: '- **2026-01-15** | Discussed pipeline',
    });

    const result = await runOptimizeCore(engine, {
      dryRun: false,
      jsonMode: false,
      maxWords: 300,
      overlapWords: 50,
      maxChars: 1200,
      skipExtract: false,
    });

    expect(result.links_created).toBe(1);
    expect(result.timeline_entries_created).toBe(2);
    expect((await engine.getTimeline('meetings/acme-sync')).map(t => t.summary)).toEqual(['Discussed pipeline']);
    const entityTimeline = await engine.getTimeline('people/alice');
    expect(entityTimeline.map(t => t.summary)).toEqual(['Discussed pipeline']);
    expect(entityTimeline[0].source).toBe('meetings/acme-sync');
  });

  test('propagates structured timeline entries through entity backlinks', async () => {
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: '',
      timeline: '',
    });
    await engine.putPage('meetings/acme-sync', {
      type: 'meeting',
      title: 'Acme Sync',
      compiled_truth: 'Pipeline discussion.',
      timeline: '',
    });
    await engine.addLink('people/alice', 'meetings/acme-sync', 'frontmatter.attendees: alice@example.com', 'attended', 'frontmatter', 'meetings/acme-sync', 'attendees');
    await engine.addTimelineEntry('meetings/acme-sync', { date: '2026-01-15', summary: 'Discussed pipeline' });

    const result = await runOptimizeCore(engine, {
      dryRun: false,
      jsonMode: false,
      maxWords: 300,
      overlapWords: 50,
      maxChars: 1200,
      skipExtract: false,
    });

    expect(result.timeline_entries_created).toBe(1);
    const entityTimeline = await engine.getTimeline('people/alice');
    expect(entityTimeline.map(t => t.summary)).toEqual(['Discussed pipeline']);
    expect(entityTimeline[0].source).toBe('meetings/acme-sync');
  });

  test('dry-run reports work without writing', async () => {
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: '',
      timeline: '- **2026-01-15** | Test',
    });

    const result = await runOptimizeCore(engine, {
      dryRun: true,
      jsonMode: true,
      maxWords: 300,
      overlapWords: 50,
      maxChars: 1200,
      skipExtract: false,
    });

    expect(result.timeline_entries_created).toBe(1);
    expect(await engine.getTimeline('people/alice')).toHaveLength(0);
  });
});
